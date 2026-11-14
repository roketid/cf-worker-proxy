# Service binding upstreams — design

Date: 2026-11-14

## Intent

Let a host or route in `PROXY_CONFIG` send traffic to another Worker through a
Cloudflare service binding, instead of always calling an upstream by URL.

## Goals

- `binding` is an alternative to `upstream`, on a route or at host level (including `"*"`).
- Requests through a binding go through the same pipeline as URL upstreams: request and
  response header changes, path rewrite, edge caching, request logs.

## Non-goals

- `fallback_upstream` stays URL-only.
- No new condition syntax; routes keep `condition: { path_prefix | header | query_param }`.
- No runtime discovery of bindings: a binding must be declared in `wrangler.jsonc`.

## Constraints

- Service bindings are declared at deploy time in `wrangler.jsonc` (`services`).
  `PROXY_CONFIG` only refers to one by name, so adding a new target Worker needs a redeploy.
- The target Worker must be in the same Cloudflare account.

## Approaches

1. **`binding` field naming a declared binding (picked).** Routing stays in one place
   (`PROXY_CONFIG`), and the field makes it plain that a different mechanism is used.
2. **Separate config for bindings.** Rejected: splits routing across two places.
3. **URL scheme, `upstream: "binding://AUTH_BACKEND"`.** Rejected: hides a different
   mechanism behind a URL string and complicates URL handling.

## Design

Config:

```json
{
  "example.com": {
    "routes": [
      { "condition": { "path_prefix": "/portal/auth" }, "binding": "AUTH_BACKEND" },
      { "upstream": "https://default.example.com" }
    ]
  }
}
```

- `Route.upstream` becomes optional; `Route.binding?: string` and
  `ProxyConfig.binding?: string` are added.
- In `serveProxy`, when `binding` is set, look up `env[binding]` and call its `.fetch()`
  instead of the global `fetch`. The request keeps the incoming host and scheme and gets
  the rewritten path; header changes apply as for URL upstreams.
- A binding name that is not present on `env`, or is not a service (no `fetch` function),
  returns 502 `{"error":"Upstream not configured"}`.
- If both `binding` and `upstream` are set on the same route or host, `binding` wins.
- A matched route sets both `upstream` and `binding` from the route, so a host-level
  `binding` never leaks into a route that names a URL upstream.
- The wildcard host (`"*"`) accepts `binding` the same way it accepts `upstream`.
- `wrangler.jsonc` gets a commented-out `services` example. README gets a section,
  including the redeploy note.

## Tests

- Binding on a route; binding at host level; binding on the wildcard host.
- Missing binding returns 502 with the JSON error.
- Path rewrite and request/response headers applied through a binding.
- `binding` wins when `upstream` is also set.

## Left to the builder

- How `env` is threaded into `serveProxy` and how the upstream request is built for a
  binding (reuse of `buildUpstreamRequest`).
- How the `Env` type exposes dynamic binding lookup.
