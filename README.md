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

### Service bindings

A route or a host can send traffic to another Worker through a
[service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
instead of a URL, by naming the binding with `binding`:

```json
{
  "routes": [
    { "condition": { "path_prefix": "/portal/auth" }, "binding": "AUTH_BACKEND" },
    { "upstream": "https://default.example.com" }
  ]
}
```

`binding` also works at host level (including `"*"`) in place of `upstream`. If both are
set on the same route or host, `binding` wins.

The name must be declared in `wrangler.jsonc`:

```jsonc
"services": [{ "binding": "AUTH_BACKEND", "service": "auth-backend" }]
```

`PROXY_CONFIG` can only name bindings that are already declared, so pointing at a new
Worker needs a redeploy, not just a config change. The target Worker must be in the same
Cloudflare account. A name that isn't declared returns `502 {"error":"Upstream not configured"}`.

The bound Worker receives the request with the original host and scheme, the rewritten
path (if `path_rewrite_*` is set) and the original query string. Request/response header
changes, edge caching and request logs apply exactly as they do for URL upstreams.
`fallback_upstream` is URL-only.

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

### Static asset edge caching

```json
{
  "cache": { "extensions": [".js", ".css", ".png", ".woff2"], "ttl_seconds": 3600 }
}
```

Responses to `GET`/`HEAD` requests whose path ends in one of `extensions` are cached at
the edge (Workers `Cache` API) for `ttl_seconds`, served on subsequent matching requests
without hitting the upstream. Only successful (`2xx`) responses are cached. This reduces
load on your upstream and improves latency — it does not reduce the request count billed
by Cloudflare, since the Worker still runs on every request whether it's a cache hit or not.

## Request logs (opt-in)

Stripe-style request logs: when enabled, every proxied request is written as one JSON
object to an S3 or S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, DigitalOcean
Spaces, Backblaze B2, ...), holding the request and response headers and bodies. It is
off unless you turn it on.

Turn it on for all hosts with `REQUEST_LOG_ENABLED=true`, or per host in `PROXY_CONFIG`
with `"request_log": true`. The per-host value wins, so `"request_log": false` excludes
one host while the env flag is on.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `REQUEST_LOG_ENABLED` | | off | `true` enables logging for every host |
| `REQUEST_LOG_S3_ENDPOINT` | yes | | e.g. `https://s3.ap-southeast-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com` |
| `REQUEST_LOG_S3_BUCKET` | yes | | Bucket name (addressed path-style: `{endpoint}/{bucket}/{key}`) |
| `REQUEST_LOG_S3_ACCESS_KEY_ID` | yes | | Set with `wrangler secret put` |
| `REQUEST_LOG_S3_SECRET_ACCESS_KEY` | yes | | Set with `wrangler secret put` |
| `REQUEST_LOG_S3_REGION` | | `auto` | Signing region; AWS needs the bucket's real region |
| `REQUEST_LOG_S3_PREFIX` | | `request-logs` | Key prefix inside the bucket |
| `REQUEST_LOG_MAX_BODY_BYTES` | | `65536` | Bodies longer than this are cut and marked `body_truncated` |
| `REQUEST_LOG_MIN_STATUS` | | `0` | Only log responses with at least this status (`400` = failures only) |
| `REQUEST_LOG_REDACT_HEADERS` | | | Comma-separated extra header names to redact |
| `REQUEST_LOG_ENCRYPTION_KEY` | | | Base64 32-byte key; when set, log objects are encrypted. Blank = no encryption. Set with `wrangler secret put` |

Every request gets an id, whether or not it is logged. It is sent to the upstream as an
`X-Request-Log-Id: req_...` request header and returned to the client as a response header
of the same name, so the client, the upstream's own logs and the log entry can all be
matched. Any value the client sent under that name is replaced. An id only has a log
object behind it when logging is on for that host and the response passes
`REQUEST_LOG_MIN_STATUS`. Log objects are stored at
`{prefix}/{YYYY}/{MM}/{DD}/{HH}/{id}_{status}.json` (UTC).

Ids sort by time: after `req_` come 9 base36 digits holding the request's start time in
milliseconds since the Unix epoch, then 16 random hex digits. So a bucket listing is in
chronological order, and the hour folder can be worked out from the id alone
(`parseInt(id.slice(4, 13), 36)` gives the timestamp). To fetch a failed request, list
that hour with the id as a prefix:

```sh
aws s3 ls s3://my-bucket/request-logs/2026/11/11/08/req_0mwbu8c17 --endpoint-url "$REQUEST_LOG_S3_ENDPOINT"
```

```json
{
  "id": "req_0mwbu8c173f9a1c0b7d2e4f6a",
  "timestamp": "2026-11-11T08:09:10.123Z",
  "duration_ms": 182,
  "client_ip": "203.0.113.7",
  "cf_ray": "8f1c2d3e4f5a6b7c-SIN",
  "metadata": { "user_id": "42" },
  "request": {
    "method": "POST",
    "url": "https://api.example.com/charges?expand=customer",
    "headers": { "content-type": "application/json", "authorization": "[REDACTED]" },
    "body": "{\"amount\":500}",
    "body_truncated": false
  },
  "response": {
    "status": 402,
    "headers": { "content-type": "application/json" },
    "body": "{\"error\":\"card_declined\"}",
    "body_truncated": false
  }
}
```

### Encrypting log objects

Set `REQUEST_LOG_ENCRYPTION_KEY` to encrypt every log object before it leaves the Worker,
so the storage provider and anyone with bucket access only see ciphertext. Leave it blank
to store plain JSON.

```sh
openssl rand -base64 32 | wrangler secret put REQUEST_LOG_ENCRYPTION_KEY
```

- The key must be exactly 32 bytes, base64-encoded. If it is set but invalid, nothing is
  logged (an error goes to the Worker's console) rather than falling back to plaintext.
- Encrypted objects are named `{id}_{status}.json.enc` instead of `.json`. Object keys
  (time, id, status) are not encrypted.
- Format: AES-256-GCM, no additional data. The object is a 12-byte random nonce followed
  by the ciphertext with the 16-byte tag appended, which is what Go's `cipher.AEAD`
  expects:

  ```go
  key, _ := base64.StdEncoding.DecodeString(os.Getenv("REQUEST_LOG_ENCRYPTION_KEY"))
  block, _ := aes.NewCipher(key)
  gcm, _ := cipher.NewGCM(block)
  plaintext, err := gcm.Open(nil, object[:12], object[12:], nil)
  ```

- Keep the key safe: objects cannot be read without it. After changing the key, older
  objects still need the old key.

### Adding upstream data to a log entry

The upstream can attach its own data (user id, order number, internal error code, ...) by
returning an `X-Request-Log-Metadata` response header:

```
X-Request-Log-Metadata: {"user_id":"42","error_code":"E_LIMIT"}
```

The value is stored in the entry's top-level `metadata` field: as parsed JSON when it is
valid JSON, otherwise as a plain string. The header is always removed before the response
reaches the client, whether or not the request is logged. Keep it to a few KB (it is an
HTTP header, so non-ASCII text should be escaped as `\uXXXX` inside the JSON), and do not
put secrets in it: metadata is stored unredacted.

Things to know:

- `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie` and `X-Api-Key` values are
  always replaced with `[REDACTED]`. Bodies are stored as-is, so they can contain
  credentials or personal data: restrict access to the bucket and set a lifecycle rule to
  expire old logs.
- Only text bodies (JSON, form, XML, `text/*`) are stored. Binary bodies and
  `text/event-stream` are recorded as `"body": null` with a `body_omitted` reason.
- The log records the request as the client sent it and the response as the client
  received it; `duration_ms` is the time until response headers.
- The upload happens after the response is returned and never affects it. If the upload
  fails, the error goes to the Worker's console log and the request log is lost.
- Each logged request costs one extra subrequest (the S3 `PUT`).

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
