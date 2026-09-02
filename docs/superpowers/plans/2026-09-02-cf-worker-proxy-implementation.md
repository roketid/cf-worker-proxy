# cf-worker-proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `echo-proxy` (a Go/Echo multi-host reverse proxy) to a single Cloudflare Worker in TypeScript, preserving routing/header/condition/fallback behavior for proxying to domains outside Cloudflare.

**Architecture:** One Worker, one `fetch` handler, four small modules (`types`, `config`, `modifier`, `router`) with no routing library. Config is a base64-encoded JSON env var (`PROXY_CONFIG`) parsed and cached once per isolate. Static wildcard fallback uses Workers Static Assets.

**Tech Stack:** TypeScript, Wrangler 4.x, `@cloudflare/vitest-plugin` + `@msw/cloudflare`/`msw` for tests (run inside real `workerd`), Node >=22.

**Spec:** `docs/superpowers/specs/2026-09-02-cf-worker-proxy-design.md`

## Global Constraints

- Node.js >= 22 (required by `wrangler` 4.x — `engines.node` is `>=22.0.0`).
- `host_override` is **not** part of the config schema (dropped per spec — Cloudflare `fetch()` cannot send a Host header different from the actual upstream's own host for domains outside your Cloudflare zone).
- `dial_timeout`/`read_timeout`/`write_timeout`/`idle_timeout` are **not** part of the config schema (no equivalent in the `fetch()` model).
- Config is loaded only from the base64-encoded `PROXY_CONFIG` env var — no file-based or plain-JSON-env loading modes.
- All error responses use the JSON shape `{"error": "<message>"}` with the same status codes as the Go version (`404`, `502`, `403`).
- Every task's tests run via `npm test` (Vitest, inside `workerd`), never against real network endpoints — outbound `fetch()` in tests is mocked with `@msw/cloudflare`.
- Repo root: `/home/mrofi/repos/cf-worker-proxy`. Every commit in this repo must use the local git identity already configured there (`user.name = Mokhamad Rofiudin`, `user.email = mokh.rofiudin@gmail.com`) — do not pass `--author` or touch global git config.

---

### Task 1: Project scaffolding & tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.jsonc`
- Create: `.gitignore`
- Create: `.dev.vars.example`
- Create: `public/index.html`
- Create: `src/index.ts` (temporary stub, replaced in Task 6)
- Test: `test/smoke.test.ts` (temporary, deleted in Task 6)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a working `npm test` / `npm run typecheck` toolchain that every later task builds on. Later tasks assume `wrangler.jsonc` exists with `main: "src/index.ts"` and an `assets` binding named `ASSETS` pointed at `./public`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "cf-worker-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "^1.1.3",
    "@cloudflare/workers-types": "^5.20260902.1",
    "@msw/cloudflare": "^0.0.1",
    "msw": "^2.15.0",
    "typescript": "^7.0.2",
    "vitest": "^4.1.11",
    "wrangler": "^4.128.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-worker-proxy",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-02",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS"
  }
}
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
.wrangler/
.dev.vars
dist/
*.log
```

- [ ] **Step 5: Create `.dev.vars.example`**

This documents the local-dev variable shape without committing real config. Copy it to `.dev.vars` (gitignored) for local `wrangler dev` runs.

```
# Copy to .dev.vars (gitignored) and fill in real values for local dev.
# PROXY_CONFIG must be base64-encoded JSON — see README.md for the schema.
PROXY_CONFIG=eyJleGFtcGxlLmNvbSI6eyJ1cHN0cmVhbSI6Imh0dHBzOi8vZXhhbXBsZS5jb20ifX0=
DEFAULT_UPSTREAM=
DEFAULT_STATIC_INDEX_FILE=
```

- [ ] **Step 6: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>cf-worker-proxy</title>
  </head>
  <body>
    <h1>No route configured for this host</h1>
  </body>
</html>
```

- [ ] **Step 7: Create temporary `src/index.ts` stub**

```typescript
export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
};
```

- [ ] **Step 8: Create temporary smoke test `test/smoke.test.ts`**

```typescript
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("toolchain smoke test", () => {
  it("runs the worker inside workerd", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://example.com/"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(await response.text()).toBe("ok");
  });
});
```

- [ ] **Step 9: Create `vitest.config.ts`**

```typescript
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
```

- [ ] **Step 10: Install dependencies**

Run: `cd /home/mrofi/repos/cf-worker-proxy && npm install`
Expected: installs succeed, `node_modules/` created, `package-lock.json` created.

- [ ] **Step 11: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 12: Run the smoke test to verify the toolchain works**

Run: `npm test`
Expected: `test/smoke.test.ts` PASSES (1 passed). This proves Wrangler config, the Vitest plugin, and the Assets binding all load correctly before any real logic is written.

- [ ] **Step 13: Commit**

```bash
cd /home/mrofi/repos/cf-worker-proxy
git add package.json package-lock.json tsconfig.json wrangler.jsonc vitest.config.ts .gitignore .dev.vars.example public/index.html src/index.ts test/smoke.test.ts
git commit -m "Scaffold cf-worker-proxy project and verify toolchain"
```

---

### Task 2: Config schema & loader

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing beyond global `atob`/`JSON`/`Map` (runtime built-ins).
- Produces (used by later tasks):
  - `interface ProxyCondition { header?: string; query_param?: string; path_prefix?: string; value?: string }`
  - `interface Route { condition?: ProxyCondition; upstream: string; path_rewrite_regex?: string; path_rewrite_replacement?: string }`
  - `interface ProxyConfig { upstream?: string; request_headers?: Record<string,string>; response_headers?: Record<string,string>; remove_headers?: string[]; condition?: ProxyCondition; fallback_behavior?: string; fallback_upstream?: string; path_rewrite_regex?: string; path_rewrite_replacement?: string; routes?: Route[]; static_index_file?: string }`
  - `type ProxyConfigMap = Record<string, ProxyConfig>`
  - `const WILDCARD_HOST = "*"`
  - `interface Env { PROXY_CONFIG?: string; DEFAULT_UPSTREAM?: string; DEFAULT_STATIC_INDEX_FILE?: string; ASSETS?: Fetcher }`
  - `function getConfig(env: Env): ProxyConfigMap`
  - `function parseConfig(raw: string): ProxyConfigMap`
  - `function clearConfigCache(): void`

- [ ] **Step 1: Write `src/types.ts`**

```typescript
export interface ProxyCondition {
  header?: string;
  query_param?: string;
  path_prefix?: string;
  value?: string;
}

export interface Route {
  condition?: ProxyCondition;
  upstream: string;
  path_rewrite_regex?: string;
  path_rewrite_replacement?: string;
}

export interface ProxyConfig {
  upstream?: string;
  request_headers?: Record<string, string>;
  response_headers?: Record<string, string>;
  remove_headers?: string[];
  condition?: ProxyCondition;
  fallback_behavior?: string;
  fallback_upstream?: string;
  path_rewrite_regex?: string;
  path_rewrite_replacement?: string;
  routes?: Route[];
  static_index_file?: string;
}

export type ProxyConfigMap = Record<string, ProxyConfig>;

export const WILDCARD_HOST = "*";

export interface Env {
  PROXY_CONFIG?: string;
  DEFAULT_UPSTREAM?: string;
  DEFAULT_STATIC_INDEX_FILE?: string;
  ASSETS?: Fetcher;
}
```

- [ ] **Step 2: Write the failing test `test/config.test.ts`**

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache, getConfig, parseConfig } from "../src/config";
import type { Env } from "../src/types";

function toBase64(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

describe("parseConfig", () => {
  it("returns an empty map for an empty string", () => {
    expect(parseConfig("")).toEqual({});
  });

  it("decodes base64 JSON into a ProxyConfigMap", () => {
    const raw = toBase64({
      "example.com": { upstream: "https://backend.example.com" },
    });
    expect(parseConfig(raw)).toEqual({
      "example.com": { upstream: "https://backend.example.com" },
    });
  });
});

describe("getConfig", () => {
  beforeEach(() => clearConfigCache());

  it("parses PROXY_CONFIG from env", () => {
    const env: Env = {
      PROXY_CONFIG: toBase64({
        "example.com": { upstream: "https://backend.example.com" },
      }),
    };
    expect(getConfig(env)).toEqual({
      "example.com": { upstream: "https://backend.example.com" },
    });
  });

  it("caches the parsed result for identical env values", () => {
    const env: Env = {
      PROXY_CONFIG: toBase64({ "example.com": { upstream: "https://a.example.com" } }),
    };
    const first = getConfig(env);
    const second = getConfig(env);
    expect(second).toBe(first);
  });

  it("applies DEFAULT_UPSTREAM as the wildcard fallback when no \"*\" entry exists", () => {
    const env: Env = {
      PROXY_CONFIG: toBase64({ "example.com": { upstream: "https://a.example.com" } }),
      DEFAULT_UPSTREAM: "https://default.example.com",
    };
    expect(getConfig(env)["*"]).toEqual({ upstream: "https://default.example.com" });
  });

  it("applies DEFAULT_STATIC_INDEX_FILE as the wildcard fallback when no \"*\" entry exists", () => {
    const env: Env = {
      PROXY_CONFIG: toBase64({}),
      DEFAULT_STATIC_INDEX_FILE: "/index.html",
    };
    expect(getConfig(env)["*"]).toEqual({ static_index_file: "/index.html" });
  });

  it("does not override an explicit \"*\" entry with DEFAULT_UPSTREAM", () => {
    const env: Env = {
      PROXY_CONFIG: toBase64({ "*": { upstream: "https://explicit.example.com" } }),
      DEFAULT_UPSTREAM: "https://default.example.com",
    };
    expect(getConfig(env)["*"]).toEqual({ upstream: "https://explicit.example.com" });
  });

  it("adds no wildcard entry when neither PROXY_CONFIG nor env fallbacks set one", () => {
    const env: Env = { PROXY_CONFIG: toBase64({}) };
    expect(getConfig(env)["*"]).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/config.test.ts`
Expected: FAIL — `src/config.ts` does not exist yet (`Cannot find module '../src/config'`).

- [ ] **Step 4: Write `src/config.ts`**

```typescript
import type { Env, ProxyConfigMap } from "./types";
import { WILDCARD_HOST } from "./types";

const cache = new Map<string, ProxyConfigMap>();

export function parseConfig(raw: string): ProxyConfigMap {
  if (!raw) return {};
  const json = atob(raw);
  return JSON.parse(json) as ProxyConfigMap;
}

function applyEnvFallback(configs: ProxyConfigMap, env: Env): void {
  if (configs[WILDCARD_HOST]) return;

  const upstream = env.DEFAULT_UPSTREAM ?? "";
  const staticIndexFile = env.DEFAULT_STATIC_INDEX_FILE ?? "";
  if (!upstream && !staticIndexFile) return;

  configs[WILDCARD_HOST] = {
    ...(upstream ? { upstream } : {}),
    ...(staticIndexFile ? { static_index_file: staticIndexFile } : {}),
  };
}

export function getConfig(env: Env): ProxyConfigMap {
  const raw = env.PROXY_CONFIG ?? "";
  const cacheKey = `${raw}|${env.DEFAULT_UPSTREAM ?? ""}|${env.DEFAULT_STATIC_INDEX_FILE ?? ""}`;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const configs = parseConfig(raw);
  applyEnvFallback(configs, env);
  cache.set(cacheKey, configs);
  return configs;
}

export function clearConfigCache(): void {
  cache.clear();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- test/config.test.ts`
Expected: PASS (7 passed).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts
git commit -m "Add config schema and PROXY_CONFIG loader with wildcard env fallback"
```

---

### Task 3: Request/response modifier

**Files:**
- Create: `src/modifier.ts`
- Test: `test/modifier.test.ts`

**Interfaces:**
- Consumes: `ProxyConfig` from `./types` (Task 2).
- Produces (used by Task 5):
  - `function buildUpstreamRequest(request: Request, upstream: string, config: Pick<ProxyConfig, "request_headers" | "path_rewrite_regex" | "path_rewrite_replacement">): Request`
  - `function applyResponseHeaders(response: Response, config: Pick<ProxyConfig, "remove_headers" | "response_headers">): Response`

- [ ] **Step 1: Write the failing test `test/modifier.test.ts`**

```typescript
import { describe, expect, it } from "vitest";
import { applyResponseHeaders, buildUpstreamRequest } from "../src/modifier";

describe("buildUpstreamRequest", () => {
  it("targets the upstream's own scheme and host", () => {
    const request = new Request("https://proxy.example.com/foo?x=1");
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {});
    const url = new URL(outgoing.url);
    expect(url.origin).toBe("https://backend.example.com");
    expect(url.pathname).toBe("/foo");
    expect(url.search).toBe("?x=1");
  });

  it("preserves the query string when rewriting the path", () => {
    const request = new Request("https://proxy.example.com/v1/users?limit=10");
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {
      path_rewrite_regex: "^/v1/(.*)",
      path_rewrite_replacement: "/api/$1",
    });
    const url = new URL(outgoing.url);
    expect(url.pathname).toBe("/api/users");
    expect(url.search).toBe("?limit=10");
  });

  it("does not rewrite the path when no regex is configured", () => {
    const request = new Request("https://proxy.example.com/unchanged");
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {});
    expect(new URL(outgoing.url).pathname).toBe("/unchanged");
  });

  it("sets configured request_headers on the outgoing request", () => {
    const request = new Request("https://proxy.example.com/");
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {
      request_headers: { "X-Custom-Header": "MyValue" },
    });
    expect(outgoing.headers.get("X-Custom-Header")).toBe("MyValue");
  });

  it("sets X-Forwarded-For from CF-Connecting-IP", () => {
    const request = new Request("https://proxy.example.com/", {
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {});
    expect(outgoing.headers.get("X-Forwarded-For")).toBe("203.0.113.9");
  });

  it("does not set X-Forwarded-For when CF-Connecting-IP is absent", () => {
    const request = new Request("https://proxy.example.com/");
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {});
    expect(outgoing.headers.get("X-Forwarded-For")).toBeNull();
  });

  it("preserves the request method", () => {
    const request = new Request("https://proxy.example.com/", { method: "POST", body: "hi" });
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {});
    expect(outgoing.method).toBe("POST");
  });
});

describe("applyResponseHeaders", () => {
  it("removes headers listed in remove_headers", () => {
    const response = new Response("body", {
      headers: { Server: "nginx", "X-Keep": "yes" },
    });
    const patched = applyResponseHeaders(response, { remove_headers: ["Server"] });
    expect(patched.headers.get("Server")).toBeNull();
    expect(patched.headers.get("X-Keep")).toBe("yes");
  });

  it("sets configured response_headers", () => {
    const response = new Response("body");
    const patched = applyResponseHeaders(response, {
      response_headers: { "X-Response-Header": "ResponseValue" },
    });
    expect(patched.headers.get("X-Response-Header")).toBe("ResponseValue");
  });

  it("preserves status and body", async () => {
    const response = new Response("hello", { status: 201 });
    const patched = applyResponseHeaders(response, {});
    expect(patched.status).toBe(201);
    expect(await patched.text()).toBe("hello");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/modifier.test.ts`
Expected: FAIL — `src/modifier.ts` does not exist yet.

- [ ] **Step 3: Write `src/modifier.ts`**

```typescript
import type { ProxyConfig } from "./types";

const regexCache = new Map<string, RegExp>();

function getCompiledRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

export function buildUpstreamRequest(
  request: Request,
  upstream: string,
  config: Pick<ProxyConfig, "request_headers" | "path_rewrite_regex" | "path_rewrite_replacement">
): Request {
  const target = new URL(upstream);
  const originalUrl = new URL(request.url);

  let path = originalUrl.pathname;
  if (config.path_rewrite_regex && config.path_rewrite_replacement !== undefined) {
    const re = getCompiledRegex(config.path_rewrite_regex);
    path = path.replace(re, config.path_rewrite_replacement);
  }

  const outgoingUrl = new URL(target.toString());
  outgoingUrl.pathname = path;
  outgoingUrl.search = originalUrl.search;

  const headers = new Headers(request.headers);
  if (config.request_headers) {
    for (const [key, value] of Object.entries(config.request_headers)) {
      headers.set(key, value);
    }
  }
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(outgoingUrl.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
  });
}

export function applyResponseHeaders(
  response: Response,
  config: Pick<ProxyConfig, "remove_headers" | "response_headers">
): Response {
  const headers = new Headers(response.headers);
  if (config.remove_headers) {
    for (const header of config.remove_headers) {
      headers.delete(header);
    }
  }
  if (config.response_headers) {
    for (const [key, value] of Object.entries(config.response_headers)) {
      headers.set(key, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/modifier.test.ts`
Expected: PASS (10 passed).

- [ ] **Step 5: Commit**

```bash
git add src/modifier.ts test/modifier.test.ts
git commit -m "Add request/response header modifier and path rewrite logic"
```

---

### Task 4: Route & condition matching

**Files:**
- Create: `src/router.ts` (partial — `jsonError`, `checkCondition`, `matchRoute` only; extended in Task 5)
- Test: `test/router-matching.test.ts`

**Interfaces:**
- Consumes: `ProxyCondition`, `Route` from `./types` (Task 2).
- Produces (used by Task 5 and by this task's own tests):
  - `function jsonError(status: number, message: string): Response`
  - `function checkCondition(request: Request, cond: ProxyCondition): boolean`
  - `function matchRoute(request: Request, routes: Route[]): Route | undefined`

- [ ] **Step 1: Write the failing test `test/router-matching.test.ts`**

```typescript
import { describe, expect, it } from "vitest";
import { checkCondition, jsonError, matchRoute } from "../src/router";
import type { Route } from "../src/types";

describe("jsonError", () => {
  it("returns a JSON error body with the given status", async () => {
    const response = jsonError(404, "Not found");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("checkCondition", () => {
  it("matches a header condition", () => {
    const request = new Request("https://example.com/", {
      headers: { "X-Api-Key": "secret-key" },
    });
    expect(checkCondition(request, { header: "X-Api-Key", value: "secret-key" })).toBe(true);
  });

  it("fails a header condition on mismatch", () => {
    const request = new Request("https://example.com/", {
      headers: { "X-Api-Key": "wrong" },
    });
    expect(checkCondition(request, { header: "X-Api-Key", value: "secret-key" })).toBe(false);
  });

  it("matches a query_param condition", () => {
    const request = new Request("https://example.com/?token=mytoken");
    expect(checkCondition(request, { query_param: "token", value: "mytoken" })).toBe(true);
  });

  it("matches a path_prefix condition", () => {
    const request = new Request("https://example.com/files/report.pdf");
    expect(checkCondition(request, { path_prefix: "/files/" })).toBe(true);
  });

  it("fails a path_prefix condition when the path doesn't start with it", () => {
    const request = new Request("https://example.com/other/report.pdf");
    expect(checkCondition(request, { path_prefix: "/files/" })).toBe(false);
  });
});

describe("matchRoute", () => {
  it("returns the first route whose condition matches", () => {
    const request = new Request("https://example.com/files/a.txt");
    const routes: Route[] = [
      { condition: { header: "target-app", value: "b" }, upstream: "https://b.example.com" },
      { condition: { path_prefix: "/files/" }, upstream: "https://files.example.com" },
      { upstream: "https://default.example.com" },
    ];
    expect(matchRoute(request, routes)?.upstream).toBe("https://files.example.com");
  });

  it("returns the catch-all route (no condition) when nothing else matches", () => {
    const request = new Request("https://example.com/other");
    const routes: Route[] = [
      { condition: { path_prefix: "/files/" }, upstream: "https://files.example.com" },
      { upstream: "https://default.example.com" },
    ];
    expect(matchRoute(request, routes)?.upstream).toBe("https://default.example.com");
  });

  it("returns undefined when no route matches and there is no catch-all", () => {
    const request = new Request("https://example.com/other");
    const routes: Route[] = [
      { condition: { path_prefix: "/files/" }, upstream: "https://files.example.com" },
    ];
    expect(matchRoute(request, routes)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/router-matching.test.ts`
Expected: FAIL — `src/router.ts` does not exist yet.

- [ ] **Step 3: Write `src/router.ts` (matching functions only)**

```typescript
import type { ProxyCondition, Route } from "./types";

export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function checkCondition(request: Request, cond: ProxyCondition): boolean {
  const url = new URL(request.url);

  if (cond.path_prefix) {
    return url.pathname.startsWith(cond.path_prefix);
  }

  let actual = "";
  if (cond.header) {
    actual = request.headers.get(cond.header) ?? "";
  } else if (cond.query_param) {
    actual = url.searchParams.get(cond.query_param) ?? "";
  }
  return actual === (cond.value ?? "");
}

export function matchRoute(request: Request, routes: Route[]): Route | undefined {
  for (const route of routes) {
    if (!route.condition || checkCondition(request, route.condition)) {
      return route;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/router-matching.test.ts`
Expected: PASS (9 passed).

- [ ] **Step 5: Commit**

```bash
git add src/router.ts test/router-matching.test.ts
git commit -m "Add condition and route matching logic"
```

---

### Task 5: Request dispatch (proxy, fallback, wildcard)

**Files:**
- Modify: `src/router.ts` (add `serveProxy`, `handleFallback`, `handleNoMatch`, `handleRequest`)
- Create: `test/server.ts` (MSW network setup, shared by this task's tests)
- Create: `test/setup.ts` (MSW lifecycle hooks)
- Modify: `vitest.config.ts` (wire up `setupFiles`)
- Test: `test/router-dispatch.test.ts`

**Interfaces:**
- Consumes: `getConfig` (Task 2), `buildUpstreamRequest`/`applyResponseHeaders` (Task 3), `jsonError`/`checkCondition`/`matchRoute` (Task 4), `Env`/`ProxyConfig`/`WILDCARD_HOST` (Task 2).
- Produces (used by Task 6):
  - `function handleRequest(request: Request, env: Env): Promise<Response>`

- [ ] **Step 1: Create the MSW network helper `test/server.ts`**

```typescript
import { setupNetwork } from "@msw/cloudflare";

export const network = setupNetwork();
```

- [ ] **Step 2: Create the MSW lifecycle hooks `test/setup.ts`**

```typescript
import { afterAll, afterEach, beforeAll } from "vitest";
import { network } from "./server";

beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
```

- [ ] **Step 3: Wire `setupFiles` into `vitest.config.ts`**

Replace the full file contents with:

```typescript
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    setupFiles: ["test/setup.ts"],
  },
});
```

- [ ] **Step 4: Run the existing test suite to confirm nothing broke**

Run: `npm test`
Expected: all previously-passing tests (smoke, config, modifier, router-matching) still PASS.

- [ ] **Step 5: Write the failing test `test/router-dispatch.test.ts`**

```typescript
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/router";
import type { Env } from "../src/types";
import { network } from "./server";

function toBase64(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

function envWith(configs: unknown, extra: Partial<Env> = {}): Env {
  return { PROXY_CONFIG: toBase64(configs), ...extra };
}

describe("handleRequest: basic proxying", () => {
  it("proxies a matched host to its upstream", async () => {
    network.use(
      http.get("https://backend.example.com/hello", () => HttpResponse.text("hi from backend"))
    );
    const env = envWith({ "api.example.com": { upstream: "https://backend.example.com" } });
    const response = await handleRequest(new Request("https://api.example.com/hello"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hi from backend");
  });

  it("removes and adds headers according to config", async () => {
    network.use(
      http.get(
        "https://backend.example.com/",
        () => new HttpResponse("body", { headers: { Server: "nginx" } })
      )
    );
    const env = envWith({
      "api.example.com": {
        upstream: "https://backend.example.com",
        remove_headers: ["Server"],
        response_headers: { "X-Response-Header": "ResponseValue" },
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(response.headers.get("Server")).toBeNull();
    expect(response.headers.get("X-Response-Header")).toBe("ResponseValue");
  });

  it("rewrites the path before proxying", async () => {
    network.use(
      http.get("https://backend.example.com/api/users", () => HttpResponse.text("rewritten"))
    );
    const env = envWith({
      "api.example.com": {
        upstream: "https://backend.example.com",
        path_rewrite_regex: "^/v1/(.*)",
        path_rewrite_replacement: "/api/$1",
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/v1/users"), env);
    expect(await response.text()).toBe("rewritten");
  });
});

describe("handleRequest: single condition + fallback_behavior", () => {
  const configs = {
    "api.example.com": {
      upstream: "https://backend.example.com",
      condition: { header: "X-Api-Key", value: "secret-key" },
      fallback_behavior: "404",
    },
  };

  it("proxies when the condition matches", async () => {
    network.use(http.get("https://backend.example.com/", () => HttpResponse.text("ok")));
    const env = envWith(configs);
    const response = await handleRequest(
      new Request("https://api.example.com/", { headers: { "X-Api-Key": "secret-key" } }),
      env
    );
    expect(await response.text()).toBe("ok");
  });

  it("falls back to 404 when the condition fails", async () => {
    const env = envWith(configs);
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("falls back to bad_gateway", async () => {
    const env = envWith({
      "api.example.com": {
        upstream: "https://backend.example.com",
        condition: { header: "X-Api-Key", value: "secret-key" },
        fallback_behavior: "bad_gateway",
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(response.status).toBe(502);
  });

  it("defaults to 403 forbidden when fallback_behavior is unset", async () => {
    const env = envWith({
      "api.example.com": {
        upstream: "https://backend.example.com",
        condition: { header: "X-Api-Key", value: "secret-key" },
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(response.status).toBe(403);
  });

  it("proxies to fallback_upstream when configured", async () => {
    network.use(
      http.get("https://fallback.example.com/", () => HttpResponse.text("fallback body"))
    );
    const env = envWith({
      "api.example.com": {
        upstream: "https://backend.example.com",
        condition: { header: "X-Api-Key", value: "secret-key" },
        fallback_behavior: "fallback_upstream",
        fallback_upstream: "https://fallback.example.com",
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(await response.text()).toBe("fallback body");
  });
});

describe("handleRequest: routes", () => {
  const configs = {
    "api.example.com": {
      routes: [
        { condition: { path_prefix: "/files/" }, upstream: "https://files.example.com" },
        { condition: { header: "target-app", value: "b" }, upstream: "https://b.example.com" },
        { upstream: "https://default.example.com" },
      ],
      fallback_behavior: "bad_gateway",
    },
  };

  it("routes by path_prefix", async () => {
    network.use(http.get("https://files.example.com/files/report.pdf", () => HttpResponse.text("file")));
    const env = envWith(configs);
    const response = await handleRequest(new Request("https://api.example.com/files/report.pdf"), env);
    expect(await response.text()).toBe("file");
  });

  it("routes by header when path_prefix doesn't match", async () => {
    network.use(http.get("https://b.example.com/", () => HttpResponse.text("service b")));
    const env = envWith(configs);
    const response = await handleRequest(
      new Request("https://api.example.com/", { headers: { "target-app": "b" } }),
      env
    );
    expect(await response.text()).toBe("service b");
  });

  it("falls through to the catch-all route", async () => {
    network.use(http.get("https://default.example.com/", () => HttpResponse.text("default")));
    const env = envWith(configs);
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(await response.text()).toBe("default");
  });

  it("uses fallback_behavior when routes has entries but none match and there is no catch-all", async () => {
    const env = envWith({
      "api.example.com": {
        routes: [{ condition: { path_prefix: "/files/" }, upstream: "https://files.example.com" }],
        fallback_behavior: "bad_gateway",
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/other"), env);
    expect(response.status).toBe(502);
  });
});

describe("handleRequest: no host match / wildcard fallback", () => {
  it("returns 502 when the host doesn't match and there is no wildcard entry", async () => {
    const env = envWith({ "api.example.com": { upstream: "https://backend.example.com" } });
    const response = await handleRequest(new Request("https://unknown.example.com/"), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "No upstream for host" });
  });

  it("proxies to the wildcard upstream when the host doesn't match", async () => {
    network.use(http.get("https://default.example.com/", () => HttpResponse.text("default upstream")));
    const env = envWith({ "*": { upstream: "https://default.example.com" } });
    const response = await handleRequest(new Request("https://unknown.example.com/"), env);
    expect(await response.text()).toBe("default upstream");
  });

  it("serves the wildcard static_index_file via ASSETS when the host doesn't match", async () => {
    const env = envWith(
      { "*": { static_index_file: "/index.html" } },
      {
        ASSETS: {
          fetch: async () =>
            new Response("<html>fallback page</html>", {
              status: 200,
              headers: { "Content-Type": "text/html" },
            }),
        } as unknown as Fetcher,
      }
    );
    const response = await handleRequest(new Request("https://unknown.example.com/"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>fallback page</html>");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- test/router-dispatch.test.ts`
Expected: FAIL — `handleRequest` is not exported from `src/router.ts` yet.

- [ ] **Step 7: Append the dispatch functions to `src/router.ts`**

Add these imports to the top of `src/router.ts` (alongside the existing `import type { ProxyCondition, Route } from "./types";`):

```typescript
import { getConfig } from "./config";
import { applyResponseHeaders, buildUpstreamRequest } from "./modifier";
import type { Env, ProxyConfig } from "./types";
import { WILDCARD_HOST } from "./types";
```

Append this to the end of `src/router.ts`:

```typescript
function effectiveConfig(config: ProxyConfig, route: Route): ProxyConfig {
  return {
    ...config,
    upstream: route.upstream,
    path_rewrite_regex: route.path_rewrite_regex ?? config.path_rewrite_regex,
    path_rewrite_replacement: route.path_rewrite_replacement ?? config.path_rewrite_replacement,
  };
}

export async function serveProxy(request: Request, config: ProxyConfig): Promise<Response> {
  if (!config.upstream) {
    return jsonError(500, "Invalid upstream URL");
  }
  const upstreamRequest = buildUpstreamRequest(request, config.upstream, config);
  try {
    const upstreamResponse = await fetch(upstreamRequest);
    return applyResponseHeaders(upstreamResponse, config);
  } catch {
    return jsonError(502, "Bad gateway");
  }
}

export async function handleFallback(request: Request, config: ProxyConfig): Promise<Response> {
  switch (config.fallback_behavior) {
    case "fallback_upstream":
      if (config.fallback_upstream) {
        return serveProxy(request, { ...config, upstream: config.fallback_upstream });
      }
      return jsonError(502, "No fallback upstream configured");
    case "404":
      return jsonError(404, "Not found");
    case "bad_gateway":
      return jsonError(502, "Bad gateway");
    default:
      return jsonError(403, "Forbidden");
  }
}

export async function handleNoMatch(
  request: Request,
  config: ProxyConfig | undefined,
  env: Env
): Promise<Response> {
  if (!config) {
    return jsonError(502, "No upstream for host");
  }
  if (config.upstream) {
    return serveProxy(request, config);
  }
  if (config.static_index_file && env.ASSETS) {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = config.static_index_file;
    return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  }
  return jsonError(502, "No upstream for host");
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const configs = getConfig(env);
  const host = new URL(request.url).hostname;
  const config = configs[host];

  if (!config) {
    return handleNoMatch(request, configs[WILDCARD_HOST], env);
  }

  if (config.routes && config.routes.length > 0) {
    const route = matchRoute(request, config.routes);
    if (route) {
      return serveProxy(request, effectiveConfig(config, route));
    }
    return handleFallback(request, config);
  }

  if (config.condition && !checkCondition(request, config.condition)) {
    return handleFallback(request, config);
  }

  return serveProxy(request, config);
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- test/router-dispatch.test.ts`
Expected: PASS (13 passed).

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: all tests across every file PASS.

- [ ] **Step 10: Commit**

```bash
git add src/router.ts test/server.ts test/setup.ts test/router-dispatch.test.ts vitest.config.ts
git commit -m "Add proxy dispatch, fallback behaviors, and wildcard host handling"
```

---

### Task 6: Worker entry point

**Files:**
- Modify: `src/index.ts` (replace the Task 1 stub with the real handler)
- Modify: `test/smoke.test.ts` → replace with `test/index.test.ts`

**Interfaces:**
- Consumes: `handleRequest` from `./router` (Task 5), `Env` from `./types` (Task 2).
- Produces: the deployable Worker (`export default { fetch }`).

- [ ] **Step 1: Delete the Task 1 smoke test**

```bash
git rm test/smoke.test.ts
```

- [ ] **Step 2: Write the failing test `test/index.test.ts`**

```typescript
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { network } from "./server";

function toBase64(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

describe("worker fetch handler", () => {
  it("proxies an incoming request end-to-end", async () => {
    network.use(http.get("https://backend.example.com/", () => HttpResponse.text("hello")));
    const env: Env = {
      PROXY_CONFIG: toBase64({ "api.example.com": { upstream: "https://backend.example.com" } }),
    };
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://api.example.com/"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });

  it("returns 502 for an unmatched host with no wildcard", async () => {
    const env: Env = { PROXY_CONFIG: toBase64({}) };
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://unknown.example.com/"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(502);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/index.test.ts`
Expected: FAIL — the Task 1 stub always returns `"ok"` regardless of config, so the first assertion (`response.status === 200` with body `"hello"`) fails on the body check, and the second test gets `"ok"`/200 instead of a 502.

- [ ] **Step 4: Replace `src/index.ts`**

```typescript
import { handleRequest } from "./router";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await handleRequest(request, env);
    const url = new URL(request.url);
    console.log(`${request.method} ${url.hostname}${url.pathname} -> ${response.status}`);
    return response;
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- test/index.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "Wire up the Worker fetch handler entry point"
```

---

### Task 7: Documentation and manual verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by other tasks — this is the final task.

- [ ] **Step 1: Write `README.md`**

```markdown
# cf-worker-proxy

A Cloudflare Workers port of [`echo-proxy`](https://github.com/roketid/echo-proxy) — a
multi-host reverse proxy that routes by `Host` header, modifies request/response headers,
rewrites paths, and supports conditional/ordered routing per host.

One Worker script can be attached to many domains at once (Cloudflare Custom Domains or
Routes); the Worker uses the incoming `Host` to pick the right config entry per request.

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in a real base64 PROXY_CONFIG for local dev
npm run dev                       # wrangler dev, reads .dev.vars
```

## Config

`PROXY_CONFIG` is a base64-encoded JSON object keyed by hostname:

```json
{
  "example.com": {
    "upstream": "https://backend.example.com",
    "request_headers": { "X-Custom-Header": "MyValue" },
    "response_headers": { "X-Response-Header": "ResponseValue" },
    "remove_headers": ["Server", "Set-Cookie"]
  },
  "*": {
    "static_index_file": "/index.html"
  }
}
```

Encode it with: `base64 -w 0 < config.json`

Set it for local dev in `.dev.vars` (gitignored). For production, use a secret so it
isn't stored in plaintext:

```sh
wrangler secret put PROXY_CONFIG
```

### Conditional proxying

```json
{
  "condition": { "header": "X-Api-Key", "value": "secret-key" },
  "fallback_behavior": "404"
}
```

`condition` supports `header`, `query_param` (both matched by equality against `value`),
or `path_prefix` (matched by prefix). `fallback_behavior` is one of `fallback_upstream`
(requires `fallback_upstream` to also be set), `404`, `bad_gateway`, or defaults to `403`.

### Multiple upstreams per host (routes)

```json
{
  "routes": [
    { "condition": { "path_prefix": "/files/" }, "upstream": "https://files.example.com" },
    { "condition": { "header": "target-app", "value": "b" }, "upstream": "https://b.example.com" },
    { "upstream": "https://default.example.com" }
  ]
}
```

Evaluated in order; the first matching route wins. A route with no `condition` is a
catch-all and should go last. If no route matches, `fallback_behavior` applies.

### Wildcard host fallback

A `"*"` entry handles requests whose `Host` matches nothing else — either `upstream`
(proxied like any other host) or `static_index_file` (served via the `ASSETS` binding).
`DEFAULT_UPSTREAM` / `DEFAULT_STATIC_INDEX_FILE` vars populate this automatically when
`PROXY_CONFIG` doesn't define an explicit `"*"` entry.

### Path rewriting

```json
{
  "path_rewrite_regex": "^/v1/(.*)",
  "path_rewrite_replacement": "/api/$1"
}
```

## Attaching multiple domains

Add each domain under the Worker's **Settings → Domains & Routes** in the Cloudflare
dashboard (or via Wrangler). Every attached domain invokes this same Worker; the Worker
picks the right config entry from the incoming `Host`.

## Known limitation: no `host_override`

Unlike the Go version, this port has no way to send an upstream a Host header different
from the upstream's own hostname. Cloudflare's `fetch()` always derives the Host header
from the outgoing request's URL; the only way to decouple them (`cf.resolveOverride`)
only works when both hosts are on your own Cloudflare account/zone. Since this proxy's
purpose is reaching domains outside Cloudflare, that mechanism doesn't apply, so the
config field was dropped rather than shipped half-working.

## Commands

- `npm run dev` — run locally with Wrangler
- `npm test` — run the Vitest suite (runs inside `workerd`, outbound `fetch()` mocked)
- `npm run typecheck` — `tsc --noEmit`
- `npm run deploy` — deploy with Wrangler

## Manual verification after deploy

```sh
wrangler deploy
curl -i https://<your-attached-domain>/some/path
```

Confirm: the response comes from the configured upstream, configured request/response
headers are present, `remove_headers` are absent, and an unmatched host either proxies
to the wildcard upstream, serves the static fallback page, or returns `502`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Add README documenting config schema, setup, and known limitations"
```

- [ ] **Step 3: Final full verification**

Run: `npm test && npm run typecheck`
Expected: all tests PASS, typecheck exits 0. This is the last task — the project is now feature-complete per the spec.
