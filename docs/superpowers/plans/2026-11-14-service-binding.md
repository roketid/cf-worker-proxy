# Service Binding Upstreams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host or route in `PROXY_CONFIG` name a Cloudflare service binding (`binding`) as an alternative to a URL `upstream`.

**Architecture:** `serveProxy` gains an `env` parameter. When the effective config has `binding`, it resolves `env[binding]` to a `Fetcher` and calls its `.fetch()` in place of the global `fetch`; everything around that call (request building, response headers, edge cache, request log) is unchanged. The upstream request for a binding is built by the existing `buildUpstreamRequest`, with the incoming request's own origin as the target.

**Tech Stack:** TypeScript, Cloudflare Workers, wrangler 4, vitest 4 with `@cloudflare/vitest-plugin`, msw.

**Spec:** `docs/superpowers/specs/2026-11-14-service-binding-design.md`

## Global Constraints

- Config field is named `binding`, on `Route` and on `ProxyConfig` (so also on the `"*"` host).
- No new condition syntax; routes keep `condition: { path_prefix | header | query_param }`.
- A binding name not present on `env`, or whose value has no `fetch` function, returns 502 `{"error":"Upstream not configured"}` via the existing `jsonError`.
- If both `binding` and `upstream` are set on the same route or host, `binding` wins.
- `fallback_upstream` stays URL-only.
- The request sent through a binding keeps the incoming scheme and host and carries the rewritten path and the original query string.
- `src/modifier.ts` is not changed.

## Review Focus

- A `binding` that names a non-service env var (e.g. `"PROXY_CONFIG"`, a string): expect 502 `Upstream not configured`, not a thrown `TypeError`.
- The bound Worker's `fetch` throws: expect 502 `{"error":"Bad gateway"}`, same as a failed URL upstream.
- A host with a host-level `binding` and `fallback_behavior: "fallback_upstream"`: the fallback request goes to the `fallback_upstream` URL, not to the binding.
- A route that names a URL `upstream` under a host that has a host-level `binding`: the route's URL is used.
- `POST` with a body and a query string through a binding: the bound Worker receives the same method, body and query.

Each of these has a test in Task 1.

---

### Task 1: Dispatch to a service binding

**Files:**
- Modify: `src/types.ts` (`Route`, `ProxyConfig`)
- Modify: `src/router.ts` (`effectiveConfig`, `serveProxy`, `handleFallback`, `handleNoMatch`, `handleRequest`)
- Modify: `wrangler.jsonc`, `README.md`
- Test: `test/router-binding.test.ts` (new)

**Interfaces:**
- Produces:
  - `Route.upstream?: string` (now optional), `Route.binding?: string`, `ProxyConfig.binding?: string`
  - `resolveBinding(env: Env, name: string): Fetcher | undefined` — exported from `src/router.ts`
  - `serveProxy(request: Request, config: ProxyConfig, env: Env, ctx?: ExecutionContext): Promise<Response>`
  - `handleFallback(request: Request, config: ProxyConfig, env: Env, ctx?: ExecutionContext): Promise<Response>`

- [ ] **Step 1: Write the failing tests in `test/router-binding.test.ts`**

Use the same `toBase64` / `envWith` helpers as `test/router-dispatch.test.ts`. A binding is faked as a plain object on `env`:

```ts
function fakeBinding(handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  return {
    calls,
    fetch: async (req: Request) => {
      calls.push(req.clone());
      return handler(req);
    },
  };
}
const withBinding = (configs: unknown, bindings: Record<string, unknown>) =>
  ({ ...envWith(configs), ...bindings }) as Env;
```

Tests (host is `app.example.com` throughout):

1. `routes a matched route to its binding` — config `routes: [{ condition: { path_prefix: "/portal/auth" }, binding: "AUTH_BACKEND" }, { upstream: "https://default.example.com" }]`; request `https://app.example.com/portal/auth/login?next=%2Fhome`. Expect body from the fake, `calls.length === 1`, and `calls[0].url === "https://app.example.com/portal/auth/login?next=%2Fhome"`.
2. `sends non-matching routes to the URL upstream` — same config, request `/other`, msw handler on `https://default.example.com/other`; expect its body and `calls.length === 0`.
3. `uses a host-level binding` — config `{ binding: "AUTH_BACKEND" }`; expect the fake's body.
4. `uses a binding on the wildcard host` — config `{ "*": { binding: "AUTH_BACKEND" } }`, request to `https://unknown.example.com/x`; expect the fake's body.
5. `applies path rewrite and header changes through a binding` — config `{ binding: "AUTH_BACKEND", path_rewrite_regex: "^/v1/(.*)", path_rewrite_replacement: "/api/$1", request_headers: { "X-Custom": "yes" }, remove_headers: ["Server"], response_headers: { "X-Out": "1" } }`; fake returns `new Response("ok", { headers: { Server: "w" } })`; request `/v1/users`. Expect `new URL(calls[0].url).pathname === "/api/users"`, `calls[0].headers.get("X-Custom") === "yes"`, response `Server` null and `X-Out` `"1"`.
6. `forwards method, body and query through a binding` — `POST /submit?a=1` with body `"payload"`; expect `calls[0].method === "POST"`, `await calls[0].text() === "payload"`, `new URL(calls[0].url).search === "?a=1"`.
7. `prefers binding when upstream is also set` — config `{ binding: "AUTH_BACKEND", upstream: "https://backend.example.com" }`, no msw handler; expect the fake's body.
8. `returns 502 when the binding is not declared` — config `{ binding: "MISSING" }`, no bindings on env. Expect status 502 and `await response.json()` to equal `{ error: "Upstream not configured" }`.
9. `returns 502 when the name is not a service` — config `{ binding: "PROXY_CONFIG" }`. Same expectation as test 8.
10. `returns 502 when the bound Worker throws` — fake handler throws; expect 502 and `{ error: "Bad gateway" }`.
11. `route upstream is not overridden by a host-level binding` — config `{ binding: "AUTH_BACKEND", routes: [{ upstream: "https://default.example.com" }] }`, msw handler on `https://default.example.com/x`; expect its body and `calls.length === 0`.
12. `fallback_upstream ignores a host-level binding` — config `{ binding: "AUTH_BACKEND", condition: { header: "X-Api-Key", value: "k" }, fallback_behavior: "fallback_upstream", fallback_upstream: "https://fallback.example.com" }`, request without the header, msw handler on `https://fallback.example.com/x`; expect its body and `calls.length === 0`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/router-binding.test.ts`
Expected: FAIL — binding tests get 500 `Invalid upstream URL` or 502 `No upstream for host`.

- [ ] **Step 3: Update the types in `src/types.ts`**

`Route.upstream` becomes optional; add `binding?: string` to `Route` and `ProxyConfig`, each with a one-line doc comment: name of a service binding declared in `wrangler.jsonc`; wins over `upstream`. `Env` is not changed.

- [ ] **Step 4: Implement the dispatch in `src/router.ts`**

- `resolveBinding(env: Env, name: string): Fetcher | undefined` — read `(env as unknown as Record<string, unknown>)[name]`; return it only if it is a non-null object whose `fetch` is a function.
- `effectiveConfig` sets both `upstream: route.upstream` and `binding: route.binding` (so neither leaks from the host).
- `serveProxy(request, config, env, ctx?)`:
  - if `config.binding`: resolve it; if unresolved return `jsonError(502, "Upstream not configured")`; build the request with `buildUpstreamRequest(request, new URL(request.url).origin, config)` and send it with the binding's `.fetch()`.
  - else the existing URL path, unchanged (including 500 `Invalid upstream URL` when neither is set).
  - both paths share the existing `try/catch` → 502 `Bad gateway`, the cache lookup before, and the response-header and cache-put code after.
- `handleFallback(request, config, env, ctx?)` — the `fallback_upstream` case passes `{ ...config, upstream: config.fallback_upstream, binding: undefined }`.
- `handleNoMatch` — proxy when `config.upstream || config.binding`, passing `env`.
- `handleRequest` — pass `env` to every `serveProxy` / `handleFallback` call.

- [ ] **Step 5: Run the full suite and the type check**

Run: `npm test && npm run typecheck`
Expected: all tests pass (the 12 new ones and every existing one); `tsc` reports no errors.

- [ ] **Step 6: Document it**

- `wrangler.jsonc`: add a commented-out example after `assets`:
  ```jsonc
  // Service bindings that PROXY_CONFIG can name with "binding": "<name>".
  // "services": [{ "binding": "AUTH_BACKEND", "service": "auth-backend" }]
  ```
- `README.md`: add a `### Service bindings` section after "Multiple upstreams per host (routes)" covering: the `binding` field on a route and at host level with the `/portal/auth` → `AUTH_BACKEND` example; that the name must be declared under `services` in `wrangler.jsonc`, so a new target Worker needs a redeploy and must be in the same account; that the bound Worker sees the original host with the rewritten path; that header changes, caching and request logs apply as for URL upstreams; that `binding` wins over `upstream`; that an undeclared name returns 502 `Upstream not configured`; that `fallback_upstream` is URL-only.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/router.ts test/router-binding.test.ts wrangler.jsonc README.md docs/superpowers
git commit -m "Add service binding upstreams via PROXY_CONFIG binding field"
```
