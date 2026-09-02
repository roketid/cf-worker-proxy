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

## License

MIT with the [Commons Clause](https://commonsclause.com/) condition — see
[`LICENSE`](./LICENSE). Free to use, modify, and self-host. Offering this
software (or a product substantially derived from it) as a paid
Software-as-a-Service or Platform-as-a-Service product to third parties
requires a separate commercial license — see
[`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md).
