import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { network } from "./server";

const ID_PATTERN = /^req_[0-9a-z]{9}[0-9a-f]{16}$/;

let uploads: { path: string; entry: any }[];
let seen: Request | undefined;

beforeEach(() => {
  uploads = [];
  seen = undefined;
  network.use(
    http.put("https://s3.test/logs-bucket/*", async ({ request }) => {
      uploads.push({ path: new URL(request.url).pathname, entry: await request.json() });
      return new HttpResponse(null, { status: 200 });
    })
  );
});

function envWithBinding(extra: Record<string, unknown> = {}): Env {
  return {
    PROXY_CONFIG: btoa(JSON.stringify({ "app.example.com": { binding: "AUTH_BACKEND" } })),
    REQUEST_LOG_S3_ENDPOINT: "https://s3.test",
    REQUEST_LOG_S3_BUCKET: "logs-bucket",
    REQUEST_LOG_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
    REQUEST_LOG_S3_SECRET_ACCESS_KEY: "secret",
    AUTH_BACKEND: {
      fetch: async (req: Request) => {
        seen = req.clone();
        return Response.json(
          { error: "denied" },
          { status: 403, headers: { "X-Request-Log-Metadata": '{"user_id":"42"}' } }
        );
      },
    },
    ...extra,
  } as Env;
}

async function run(env: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request("https://app.example.com/login?next=%2Fhome", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Trace": "t1",
      "CF-Connecting-IP": "203.0.113.7",
      "X-Request-Log-Id": "req_spoofed",
    },
    body: JSON.stringify({ user: "a" }),
  });
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("service binding: forwarded headers", () => {
  it("forwards client headers, X-Forwarded-For and a fresh log id to the bound Worker", async () => {
    const response = await run(envWithBinding());

    expect(seen!.headers.get("X-Trace")).toBe("t1");
    expect(seen!.headers.get("X-Forwarded-For")).toBe("203.0.113.7");
    expect(seen!.headers.get("X-Request-Log-Id")).toMatch(ID_PATTERN);
    expect(seen!.headers.get("X-Request-Log-Id")).toBe(response.headers.get("X-Request-Log-Id"));
    expect(await seen!.text()).toBe('{"user":"a"}');
  });
});

describe("service binding: request logging to S3", () => {
  it("uploads the request and response of a binding call", async () => {
    const response = await run(envWithBinding({ REQUEST_LOG_ENABLED: "true" }));
    const id = response.headers.get("X-Request-Log-Id");

    expect(response.status).toBe(403);
    expect(response.headers.get("X-Request-Log-Metadata")).toBeNull();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toMatch(new RegExp(`/${id}_403\\.json$`));
    const { entry } = uploads[0];
    expect(entry.id).toBe(id);
    expect(entry.request).toMatchObject({
      method: "POST",
      url: "https://app.example.com/login?next=%2Fhome",
      body: '{"user":"a"}',
    });
    expect(entry.request.headers["x-trace"]).toBe("t1");
    expect(entry.response).toMatchObject({ status: 403, body: '{"error":"denied"}' });
    expect(entry.metadata).toEqual({ user_id: "42" });
  });

  it("writes no log for a binding call when logging is off", async () => {
    await run(envWithBinding());
    expect(uploads).toHaveLength(0);
  });
});
