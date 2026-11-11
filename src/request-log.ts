import { getConfig } from "./config";
import { buildS3PutRequest, type S3Target } from "./s3";
import type { Env } from "./types";
import { WILDCARD_HOST } from "./types";

export const LOG_ID_HEADER = "X-Request-Log-Id";
/** Response header an upstream can set to attach its own data to the log entry. */
export const LOG_METADATA_HEADER = "X-Request-Log-Metadata";

const DEFAULT_MAX_BODY_BYTES = 65536;
const DEFAULT_REDACTED_HEADERS = ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"];
const REDACTED = "[REDACTED]";
const TEXTUAL_CONTENT_TYPE = /^text\/|json|xml|x-www-form-urlencoded|javascript/i;

export interface LogSettings {
  target: S3Target;
  prefix: string;
  maxBodyBytes: number;
  minStatus: number;
  redactedHeaders: Set<string>;
  /** Raw 32-byte AES-256 key, or null when log objects are stored unencrypted. */
  encryptionKey: Uint8Array | null;
}

interface CapturedBody {
  body: string | null;
  body_truncated: boolean;
  body_omitted?: string;
}

function isTruthy(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;

function decodeEncryptionKey(value: string): Uint8Array | null {
  try {
    const bytes = Uint8Array.from(atob(value.trim()), (c) => c.charCodeAt(0));
    return bytes.byteLength === AES_KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/** AES-256-GCM. Output layout: 12-byte random nonce, then ciphertext with the 16-byte tag appended. */
export async function encryptLogObject(plaintext: string, rawKey: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(plaintext));
  const out = new Uint8Array(GCM_NONCE_BYTES + sealed.byteLength);
  out.set(nonce);
  out.set(new Uint8Array(sealed), GCM_NONCE_BYTES);
  return out;
}

/** Returns the logging settings for this request, or null when logging is off for it. */
export function resolveLogSettings(request: Request, env: Env): LogSettings | null {
  let hostFlag: boolean | undefined;
  try {
    const configs = getConfig(env);
    hostFlag = (configs[new URL(request.url).hostname] ?? configs[WILDCARD_HOST])?.request_log;
  } catch {
    // A broken PROXY_CONFIG is reported by the request handler itself.
  }
  if (!(hostFlag ?? isTruthy(env.REQUEST_LOG_ENABLED))) return null;

  const endpoint = env.REQUEST_LOG_S3_ENDPOINT;
  const bucket = env.REQUEST_LOG_S3_BUCKET;
  const accessKeyId = env.REQUEST_LOG_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.REQUEST_LOG_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    console.warn("request log: enabled but REQUEST_LOG_S3_* settings are incomplete; skipping");
    return null;
  }

  let encryptionKey: Uint8Array | null = null;
  if (env.REQUEST_LOG_ENCRYPTION_KEY) {
    encryptionKey = decodeEncryptionKey(env.REQUEST_LOG_ENCRYPTION_KEY);
    if (!encryptionKey) {
      // Never fall back to writing plaintext when encryption was asked for.
      console.error("request log: REQUEST_LOG_ENCRYPTION_KEY must be 32 bytes, base64-encoded; skipping");
      return null;
    }
  }

  const extraRedacted = (env.REQUEST_LOG_REDACT_HEADERS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  return {
    target: { endpoint, bucket, accessKeyId, secretAccessKey, region: env.REQUEST_LOG_S3_REGION || "auto" },
    prefix: (env.REQUEST_LOG_S3_PREFIX ?? "request-logs").replace(/^\/+|\/+$/g, ""),
    maxBodyBytes: parseNumber(env.REQUEST_LOG_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    minStatus: parseNumber(env.REQUEST_LOG_MIN_STATUS, 0),
    redactedHeaders: new Set([...DEFAULT_REDACTED_HEADERS, ...extraRedacted]),
    encryptionKey,
  };
}

/**
 * Ids sort by time: `req_` + 9 base36 digits of the start time in ms + 16 random hex digits.
 * The time part lets a reader derive the object's hour folder from the id alone.
 */
function newLogId(startedAt: Date): string {
  const time = startedAt.getTime().toString(36).padStart(9, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `req_${time}${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function headersToObject(headers: Headers, redacted: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    out[name] = redacted.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

function omittedReason(message: Request | Response): string | undefined {
  if (!message.body) return "empty";
  const contentType = message.headers.get("Content-Type") ?? "";
  if (contentType.toLowerCase().startsWith("text/event-stream")) return "event stream";
  if (!TEXTUAL_CONTENT_TYPE.test(contentType)) return "non-text content type";
  return undefined;
}

async function readBody(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<CapturedBody> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let remaining = maxBytes;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > remaining) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
      remaining -= value.byteLength;
    }
  } catch {
    truncated = true;
  }
  if (truncated) await reader.cancel().catch(() => {});
  return { body: text + decoder.decode(), body_truncated: truncated };
}

/**
 * Starts capturing a copy of the body. Must be called before the original body is consumed;
 * the copy is read from a clone so the original stream still flows to its real destination.
 */
function captureBody(message: Request | Response, maxBytes: number): Promise<CapturedBody> {
  const reason = omittedReason(message);
  if (reason) return Promise.resolve({ body: null, body_truncated: false, body_omitted: reason });
  return readBody(message.clone().body!, maxBytes);
}

/** Parsed JSON when the upstream sent valid JSON, otherwise the raw header text. */
function parseMetadata(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectKey(prefix: string, id: string, status: number, startedAt: Date, encrypted: boolean): string {
  const [date, time] = startedAt.toISOString().split("T");
  const parts = [...date.split("-"), time.slice(0, 2), `${id}_${status}.json${encrypted ? ".enc" : ""}`];
  return [prefix, ...parts].filter(Boolean).join("/");
}

/**
 * Wraps the request handler. Every request gets an id, sent to the upstream and returned to
 * the client, whether or not it is logged. When logging is on, the request and response are
 * uploaded as one JSON object. Logging never changes the outcome of the proxied request.
 */
export async function withRequestLog(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  handler: (request: Request) => Promise<Response>
): Promise<Response> {
  const settings = resolveLogSettings(request, env);
  const startedAt = new Date();
  const id = newLogId(startedAt);
  // Start the copy before the body is handed to the upstream request below.
  const requestBody = settings ? captureBody(request, settings.maxBodyBytes) : undefined;

  // Replaces any id the client sent, so the upstream can trust the header.
  const forwarded = new Request(request, { headers: new Headers(request.headers) });
  forwarded.headers.set(LOG_ID_HEADER, id);

  const upstreamResponse = await handler(forwarded);
  // A WebSocket upgrade has to be handed back as-is.
  if (upstreamResponse.status === 101) return upstreamResponse;

  const response = new Response(upstreamResponse.body, upstreamResponse);
  const metadata = parseMetadata(response.headers.get(LOG_METADATA_HEADER));
  response.headers.delete(LOG_METADATA_HEADER);
  response.headers.set(LOG_ID_HEADER, id);
  if (!settings || !requestBody || response.status < settings.minStatus) return response;

  const durationMs = Date.now() - startedAt.getTime();
  const responseBody = captureBody(response, settings.maxBodyBytes);

  ctx.waitUntil(
    (async () => {
      try {
        const entry = {
          id,
          timestamp: startedAt.toISOString(),
          duration_ms: durationMs,
          client_ip: request.headers.get("CF-Connecting-IP"),
          cf_ray: request.headers.get("CF-Ray"),
          ...(metadata !== undefined ? { metadata } : {}),
          request: {
            method: request.method,
            url: request.url,
            headers: headersToObject(request.headers, settings.redactedHeaders),
            ...(await requestBody),
          },
          response: {
            status: response.status,
            headers: headersToObject(response.headers, settings.redactedHeaders),
            ...(await responseBody),
          },
        };
        const json = JSON.stringify(entry);
        const key = settings.encryptionKey;
        const put = await buildS3PutRequest(
          settings.target,
          objectKey(settings.prefix, id, response.status, startedAt, key !== null),
          key ? await encryptLogObject(json, key) : json,
          key ? "application/octet-stream" : "application/json"
        );
        const result = await fetch(put);
        if (!result.ok) {
          console.error(`request log: upload of ${id} failed with ${result.status}: ${await result.text()}`);
        }
      } catch (err) {
        console.error(`request log: upload of ${id} failed:`, err);
      }
    })()
  );

  return response;
}
