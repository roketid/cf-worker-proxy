import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { network } from "./server";

function toBase64(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

async function run(request: Request, env: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const ID_PATTERN = /^req_[0-9a-z]{9}[0-9a-f]{16}$/;

const S3_ENV: Env = {
  REQUEST_LOG_S3_ENDPOINT: "https://s3.test",
  REQUEST_LOG_S3_BUCKET: "logs-bucket",
  REQUEST_LOG_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
  REQUEST_LOG_S3_SECRET_ACCESS_KEY: "secret",
};

function envFor(hostConfig: Record<string, unknown> = {}, extra: Env = {}): Env {
  return {
    PROXY_CONFIG: toBase64({ "api.example.com": { upstream: "https://backend.example.com", ...hostConfig } }),
    ...S3_ENV,
    ...extra,
  };
}

interface Upload {
  path: string;
  authorization: string | null;
  contentType: string | null;
  bytes: Uint8Array;
  /** Parsed entry for plain `.json` objects; undefined for encrypted ones. */
  entry: any;
}

let uploads: Upload[];

beforeEach(() => {
  uploads = [];
  network.use(
    http.put("https://s3.test/logs-bucket/*", async ({ request }) => {
      const path = new URL(request.url).pathname;
      const bytes = new Uint8Array(await request.arrayBuffer());
      uploads.push({
        path,
        authorization: request.headers.get("Authorization"),
        contentType: request.headers.get("Content-Type"),
        bytes,
        entry: path.endsWith(".json") ? JSON.parse(new TextDecoder().decode(bytes)) : undefined,
      });
      return new HttpResponse(null, { status: 200 });
    }),
    http.post("https://backend.example.com/charges", () =>
      HttpResponse.json({ error: "card_declined" }, { status: 402, headers: { "Set-Cookie": "sid=abc" } })
    ),
    http.get("https://backend.example.com/ok", () => HttpResponse.text("fine"))
  );
});

function chargeRequest(): Request {
  return new Request("https://api.example.com/charges?expand=customer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk_live_123", "X-Trace": "t1" },
    body: JSON.stringify({ amount: 500 }),
  });
}

describe("request logging to S3", () => {
  it("is off by default, but still assigns an id", async () => {
    const response = await run(chargeRequest(), envFor());
    expect(response.status).toBe(402);
    expect(response.headers.get("X-Request-Log-Id")).toMatch(ID_PATTERN);
    expect(uploads).toHaveLength(0);
  });

  it("uploads the request and response when enabled via env", async () => {
    const response = await run(chargeRequest(), envFor({}, { REQUEST_LOG_ENABLED: "true" }));

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "card_declined" });
    const id = response.headers.get("X-Request-Log-Id");
    expect(id).toMatch(/^req_[0-9a-z]{9}[0-9a-f]{16}$/);
    const idTime = parseInt(id!.slice(4, 13), 36);
    expect(Math.abs(Date.now() - idTime)).toBeLessThan(60_000);

    expect(uploads).toHaveLength(1);
    const { path, authorization, entry } = uploads[0];
    expect(path).toMatch(new RegExp(`^/logs-bucket/request-logs/\\d{4}/\\d{2}/\\d{2}/\\d{2}/${id}_402\\.json$`));
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
    expect(entry.id).toBe(id);
    expect(new Date(entry.timestamp).getTime()).toBe(idTime);
    expect(entry.request).toMatchObject({
      method: "POST",
      url: "https://api.example.com/charges?expand=customer",
      body: '{"amount":500}',
      body_truncated: false,
    });
    expect(entry.request.headers["x-trace"]).toBe("t1");
    expect(entry.response).toMatchObject({ status: 402, body: '{"error":"card_declined"}', body_truncated: false });
    expect(typeof entry.duration_ms).toBe("number");
  });

  it("forwards the log id and the untouched body to the origin", async () => {
    let seenId: string | null = null;
    let seenBody = "";
    network.use(
      http.post("https://backend.example.com/charges", async ({ request }) => {
        seenId = request.headers.get("X-Request-Log-Id");
        seenBody = await request.text();
        return HttpResponse.json({ ok: true });
      })
    );
    const request = chargeRequest();
    request.headers.set("X-Request-Log-Id", "req_spoofed");
    const response = await run(request, envFor({}, { REQUEST_LOG_ENABLED: "true" }));

    expect(seenId).toMatch(/^req_[0-9a-z]{9}[0-9a-f]{16}$/);
    expect(seenId).toBe(response.headers.get("X-Request-Log-Id"));
    expect(seenBody).toBe('{"amount":500}');
    expect(uploads[0].entry.id).toBe(seenId);
  });

  describe("upstream metadata", () => {
    function backendWithMetadata(value: string) {
      network.use(
        http.post("https://backend.example.com/charges", () =>
          HttpResponse.json({ ok: true }, { headers: { "X-Request-Log-Metadata": value } })
        )
      );
    }

    it("stores JSON metadata from the upstream and hides the header from the client", async () => {
      backendWithMetadata('{"user_id":"42","plan":"pro"}');
      const response = await run(chargeRequest(), envFor({}, { REQUEST_LOG_ENABLED: "true" }));

      expect(response.headers.get("X-Request-Log-Metadata")).toBeNull();
      expect(await response.json()).toEqual({ ok: true });
      expect(uploads[0].entry.metadata).toEqual({ user_id: "42", plan: "pro" });
      expect(uploads[0].entry.response.headers["x-request-log-metadata"]).toBeUndefined();
    });

    it("stores metadata that is not JSON as a plain string", async () => {
      backendWithMetadata("order 17 retried");
      await run(chargeRequest(), envFor({}, { REQUEST_LOG_ENABLED: "true" }));
      expect(uploads[0].entry.metadata).toBe("order 17 retried");
    });

    it("leaves metadata out of the entry when the upstream sends none", async () => {
      await run(chargeRequest(), envFor({}, { REQUEST_LOG_ENABLED: "true" }));
      expect("metadata" in uploads[0].entry).toBe(false);
    });

    it("hides the header from the client when the response is below REQUEST_LOG_MIN_STATUS", async () => {
      backendWithMetadata('{"user_id":"42"}');
      const env = envFor({}, { REQUEST_LOG_ENABLED: "true", REQUEST_LOG_MIN_STATUS: "400" });
      const response = await run(chargeRequest(), env);
      expect(response.headers.get("X-Request-Log-Metadata")).toBeNull();
      expect(uploads).toHaveLength(0);
    });

    it("with logging off, hides the header from the client and still sends its own id to the upstream", async () => {
      let seenId: string | null = "unset";
      network.use(
        http.post("https://backend.example.com/charges", ({ request }) => {
          seenId = request.headers.get("X-Request-Log-Id");
          return HttpResponse.json({ ok: true }, { headers: { "X-Request-Log-Metadata": '{"user_id":"42"}' } });
        })
      );
      const request = chargeRequest();
      request.headers.set("X-Request-Log-Id", "req_spoofed");
      const response = await run(request, envFor());

      expect(seenId).toMatch(ID_PATTERN);
      expect(seenId).toBe(response.headers.get("X-Request-Log-Id"));
      expect(response.headers.get("X-Request-Log-Metadata")).toBeNull();
      expect(await response.json()).toEqual({ ok: true });
    });

    it("does not replay metadata from a cached response", async () => {
      network.use(
        http.get(
          "https://backend.example.com/meta-cache.js",
          () => HttpResponse.text("js", { headers: { "X-Request-Log-Metadata": '{"n":1}' } }),
          { once: true }
        )
      );
      const env = envFor({ cache: { extensions: [".js"], ttl_seconds: 60 } }, { REQUEST_LOG_ENABLED: "true" });
      await run(new Request("https://api.example.com/meta-cache.js"), env);
      await run(new Request("https://api.example.com/meta-cache.js"), env);

      expect(uploads).toHaveLength(2);
      expect(uploads[0].entry.metadata).toEqual({ n: 1 });
      expect("metadata" in uploads[1].entry).toBe(false);
    });
  });

  describe("encryption", () => {
    const rawKey = new Uint8Array(32).map((_, i) => i * 7 + 1);
    const keyBase64 = btoa(String.fromCharCode(...rawKey));

    it("stores the entry encrypted with AES-256-GCM when a key is set", async () => {
      const env = envFor({}, { REQUEST_LOG_ENABLED: "true", REQUEST_LOG_ENCRYPTION_KEY: keyBase64 });
      const response = await run(chargeRequest(), env);
      const id = response.headers.get("X-Request-Log-Id");

      expect(uploads).toHaveLength(1);
      const { path, bytes, contentType } = uploads[0];
      expect(path.endsWith(`/${id}_402.json.enc`)).toBe(true);
      expect(contentType).toBe("application/octet-stream");
      expect(new TextDecoder().decode(bytes)).not.toContain("card_declined");

      const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
      const entry = JSON.parse(new TextDecoder().decode(plain));
      expect(entry.id).toBe(id);
      expect(entry.response.body).toBe('{"error":"card_declined"}');
    });

    it("writes nothing rather than plaintext when the key is invalid", async () => {
      const env = envFor({}, { REQUEST_LOG_ENABLED: "true", REQUEST_LOG_ENCRYPTION_KEY: "too-short" });
      const response = await run(chargeRequest(), env);
      expect(response.status).toBe(402);
      expect(uploads).toHaveLength(0);
    });
  });

  it("redacts sensitive headers, including extra ones from REQUEST_LOG_REDACT_HEADERS", async () => {
    await run(chargeRequest(), envFor({}, { REQUEST_LOG_ENABLED: "true", REQUEST_LOG_REDACT_HEADERS: "X-Trace" }));
    const { entry } = uploads[0];
    expect(entry.request.headers.authorization).toBe("[REDACTED]");
    expect(entry.request.headers["x-trace"]).toBe("[REDACTED]");
    expect(entry.response.headers["set-cookie"]).toBe("[REDACTED]");
    expect(JSON.stringify(entry)).not.toContain("sk_live_123");
  });

  it("truncates bodies beyond REQUEST_LOG_MAX_BODY_BYTES without altering the proxied response", async () => {
    const response = await run(chargeRequest(), envFor({}, { REQUEST_LOG_ENABLED: "true", REQUEST_LOG_MAX_BODY_BYTES: "5" }));
    expect(await response.json()).toEqual({ error: "card_declined" });
    expect(uploads[0].entry.request).toMatchObject({ body: '{"amo', body_truncated: true });
    expect(uploads[0].entry.response).toMatchObject({ body: '{"err', body_truncated: true });
  });

  it("lets a host opt in via config while the env flag is off", async () => {
    await run(chargeRequest(), envFor({ request_log: true }));
    expect(uploads).toHaveLength(1);
  });

  it("lets a host opt out via config while the env flag is on", async () => {
    const response = await run(chargeRequest(), envFor({ request_log: false }, { REQUEST_LOG_ENABLED: "true" }));
    expect(response.headers.get("X-Request-Log-Id")).toMatch(ID_PATTERN);
    expect(uploads).toHaveLength(0);
  });

  it("skips responses below REQUEST_LOG_MIN_STATUS", async () => {
    const env = envFor({}, { REQUEST_LOG_ENABLED: "true", REQUEST_LOG_MIN_STATUS: "400" });
    const ok = await run(new Request("https://api.example.com/ok"), env);
    expect(await ok.text()).toBe("fine");
    expect(ok.headers.get("X-Request-Log-Id")).toMatch(ID_PATTERN);
    expect(uploads).toHaveLength(0);
    await run(chargeRequest(), env);
    expect(uploads).toHaveLength(1);
  });

  it("omits bodies that are not text", async () => {
    network.use(
      http.get("https://backend.example.com/img", () =>
        HttpResponse.arrayBuffer(new Uint8Array([1, 2, 3]).buffer, { headers: { "Content-Type": "image/png" } })
      )
    );
    await run(new Request("https://api.example.com/img"), envFor({}, { REQUEST_LOG_ENABLED: "true" }));
    expect(uploads[0].entry.request).toMatchObject({ body: null, body_omitted: "empty" });
    expect(uploads[0].entry.response).toMatchObject({ body: null, body_omitted: "non-text content type" });
  });

  it("still returns the proxied response when the upload fails", async () => {
    network.use(http.put("https://s3.test/logs-bucket/*", () => new HttpResponse("denied", { status: 403 })));
    const response = await run(chargeRequest(), envFor({}, { REQUEST_LOG_ENABLED: "true" }));
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "card_declined" });
  });

  it("does not log when enabled but the S3 settings are incomplete", async () => {
    const env = envFor({}, { REQUEST_LOG_ENABLED: "true", REQUEST_LOG_S3_BUCKET: "" });
    const response = await run(chargeRequest(), env);
    expect(response.status).toBe(402);
    expect(response.headers.get("X-Request-Log-Id")).toMatch(ID_PATTERN);
    expect(uploads).toHaveLength(0);
  });
});
