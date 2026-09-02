# cf-worker-proxy: Cloudflare Workers port of echo-proxy

Status: approved
Date: 2026-09-02
Source project: `~/repos/echo-proxy` (Go / Echo framework reverse proxy)

## Purpose

Port the multi-host reverse proxy currently implemented as a Go binary
(`echo-proxy`) to a single Cloudflare Worker, so the same host-based
routing/header/condition/fallback behavior runs at Cloudflare's edge
instead of on a self-managed server. One Worker script is attached to
every domain it needs to serve (Cloudflare Custom Domains / Routes),
and the Worker uses the `Host` header to pick the right config entry
per request, exactly as the Go version uses `c.Request().Host`.

## Scope

In scope — full parity with `echo-proxy`'s routing feature set:
- Per-host upstream proxying based on `Host` header, with a `"*"`
  wildcard fallback host.
- Request header add (`request_headers`), response header add
  (`response_headers`) and removal (`remove_headers`).
- Path rewriting via regex (`path_rewrite_regex` /
  `path_rewrite_replacement`).
- `host_override` (Host header sent upstream).
- Single `condition` + `fallback_behavior`
  (`fallback_upstream`/`404`/`bad_gateway`/default `403`).
- Ordered `routes` (first-match-wins, condition types: `header`,
  `query_param`, `path_prefix`).
- Wildcard host static file fallback (`static_index_file`).
- `X-Forwarded-For` set from the real client IP.
- Config loading from a base64-encoded JSON env var, matching the
  existing `PROXY_CONFIG` convention.

Explicitly out of scope (decided during brainstorming):
- `dial_timeout` / `read_timeout` / `write_timeout` / `idle_timeout`
  config fields. These configure Go's `http.Transport` connection
  pooling, which has no equivalent in the Workers `fetch()` model —
  Cloudflare manages upstream connection pooling and its own
  subrequest timeout platform-side. These fields are dropped from the
  config schema rather than accepted-and-ignored, so the schema stays
  honest about what's actually configurable.
- The "library" usage mode (`echoproxy.RunProxy(...)` as a Go import)
  — not meaningful for a Worker, which has a single fixed entry point.
- Config-from-file and config-from-plain-JSON-file loading modes — the
  Worker only supports the base64-env-var form.

## Config Source

`PROXY_CONFIG`: a Worker binding (var for local/dev, `wrangler secret
put PROXY_CONFIG` for anything containing sensitive values) holding
the same base64-encoded JSON blob shape used today, keyed by hostname:

```json
{
  "example.com": {
    "upstream": "https://example.com",
    "request_headers": { "X-Custom-Header": "MyValue" },
    "remove_headers": ["Server", "Set-Cookie"]
  },
  "*": {
    "static_index_file": "/index.html"
  }
}
```

`DEFAULT_UPSTREAM` / `DEFAULT_STATIC_INDEX_FILE` plain vars remain
supported as the wildcard fallback when no explicit `"*"` entry exists
in `PROXY_CONFIG`, matching the Go behavior. An explicit `"*"` entry
always wins.

Config is parsed and regexes compiled once per isolate (module-scope
memoization keyed off the raw `PROXY_CONFIG` string), avoiding
per-request JSON parsing — the same performance intent as the Go
version's `initializeConfigs` pre-compilation step.

## Static Fallback

Cloudflare Workers Static Assets (`[assets] directory = "./public"` in
`wrangler.toml`, bound as `env.ASSETS`) serves the file named by
`static_index_file` for the wildcard host, replacing Echo's `c.File()`
call. This is the only case where the Worker does not proxy to an
upstream at all.

## Architecture

Single Worker, TypeScript, one `fetch` handler. No routing library —
matches the Go version's single catch-all handler plus internal
dispatch.

```
src/
  types.ts      ProxyConfig, Route, ProxyCondition interfaces
  config.ts     parse + memoize PROXY_CONFIG, wildcard env fallback
  router.ts     host lookup, route/condition matching, fallback dispatch
  modifier.ts   build outgoing Request, patch outgoing Response headers
  index.ts      fetch(request, env, ctx) entry point
test/
  config.test.ts
  router.test.ts
  modifier.test.ts
public/
  index.html    (example static wildcard fallback page)
wrangler.toml
package.json
tsconfig.json
README.md
```

### Data flow

1. `index.ts` receives the request, calls `config.ts` to get the
   (cached) parsed config map.
2. `router.ts` looks up `new URL(request.url).hostname` in the map.
   - No match → wildcard `"*"` entry: proxy to its `upstream` if set,
     else serve `static_index_file` via `env.ASSETS`, else `502`.
   - Match with `routes` → evaluate in order, first matching route (or
     the first with no `condition`) wins; overrides `upstream`,
     `host_override`, `path_rewrite_regex/replacement` on top of the
     host-level config (headers/remove_headers stay host-level, same
     as `effectiveConfig` in the Go code).
   - Match with a single `condition` and it fails → `handleFallback`:
     `fallback_behavior` of `fallback_upstream` (proxy to
     `fallback_upstream`), `404`, `bad_gateway`, or default `403`, each
     returned as `{"error": "..."}` JSON like the Go version.
   - Match, condition passes (or none set) → proxy normally.
3. `modifier.ts` builds the outgoing `Request`: rewrites `pathname` via
   the compiled regex if configured, sets `Host` to `host_override` or
   the upstream's own host, applies `request_headers`, sets
   `X-Forwarded-For` from `request.headers.get('CF-Connecting-IP')`.
4. Worker calls `fetch(upstreamRequest)`. Network failure → caught,
   logged, `502 {"error": "..."}` returned (matching
   `httputil.ReverseProxy`'s default error behavior).
5. `modifier.ts` patches the response: deletes `remove_headers`, sets
   `response_headers`, then the (possibly mutated) `Response` is
   returned to the client.

### Error handling

All error paths return the same JSON shape and status codes as the Go
version (`{"error": "<message>"}` with `404`/`502`/`403`), so any
client relying on the current error contract keeps working after the
port.

### Logging

`console.log` one line per request (method, matched host, upstream,
status) — visible via `wrangler tail` or Cloudflare Logpush, replacing
Echo's `middleware.Logger()`. No custom middleware layer needed for a
single-handler Worker.

## Testing

Vitest + `@cloudflare/vitest-pool-workers` (the standard Workers-native
test runtime, runs tests inside `workerd`). Test coverage mirrors
`tests/proxy_test.go`:
- Host match / no match → wildcard upstream / wildcard static file /
  default 502.
- Single `condition` (header, query param) pass/fail → fallback
  behaviors (`fallback_upstream`, `404`, `bad_gateway`, default).
- `routes`: ordered evaluation, `path_prefix` condition, catch-all
  route with no condition, per-route `host_override` and path rewrite
  overrides layered on host-level headers.
- Path rewrite regex replacement.
- `request_headers` set, `response_headers` set, `remove_headers`
  deleted.
- `X-Forwarded-For` populated from `CF-Connecting-IP`.

## Repo / Git

New standalone repo at `~/repos/cf-worker-proxy`, git-initialized with
a local identity override (`user.email = mokh.rofiudin@gmail.com`,
`user.name = Mokhamad Rofiudin`) so all commits in this repo are
attributed to that identity regardless of the global git config.
