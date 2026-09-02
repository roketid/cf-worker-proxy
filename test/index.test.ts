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
