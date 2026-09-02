import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
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

describe("static asset edge caching", () => {
  it("serves a cache hit on the second request without a second upstream fetch", async () => {
    network.use(
      http.get("https://cache-hit.example.com/app.js", () => HttpResponse.text("console.log(1)"), {
        once: true,
      })
    );
    const env: Env = {
      PROXY_CONFIG: toBase64({
        "cache-hit.example.com": {
          upstream: "https://cache-hit.example.com",
          cache: { extensions: [".js"], ttl_seconds: 60 },
        },
      }),
    };

    const first = await run(new Request("https://cache-hit.example.com/app.js"), env);
    expect(await first.text()).toBe("console.log(1)");

    const second = await run(new Request("https://cache-hit.example.com/app.js"), env);
    expect(await second.text()).toBe("console.log(1)");
  });

  it("sets a Cache-Control max-age matching the configured ttl_seconds on the cached copy", async () => {
    network.use(
      http.get("https://cache-ttl.example.com/style.css", () => HttpResponse.text("body{}"), {
        once: true,
      })
    );
    const env: Env = {
      PROXY_CONFIG: toBase64({
        "cache-ttl.example.com": {
          upstream: "https://cache-ttl.example.com",
          cache: { extensions: [".css"], ttl_seconds: 120 },
        },
      }),
    };

    await run(new Request("https://cache-ttl.example.com/style.css"), env);
    const cached = await run(new Request("https://cache-ttl.example.com/style.css"), env);
    expect(cached.headers.get("Cache-Control")).toBe("public, max-age=120");
  });

  it("does not cache a path whose extension isn't in the configured list", async () => {
    let upstreamHits = 0;
    network.use(
      http.get("https://cache-skip.example.com/page.html", () => {
        upstreamHits += 1;
        return HttpResponse.text("<html></html>");
      })
    );
    const env: Env = {
      PROXY_CONFIG: toBase64({
        "cache-skip.example.com": {
          upstream: "https://cache-skip.example.com",
          cache: { extensions: [".js"], ttl_seconds: 60 },
        },
      }),
    };

    await run(new Request("https://cache-skip.example.com/page.html"), env);
    await run(new Request("https://cache-skip.example.com/page.html"), env);
    expect(upstreamHits).toBe(2);
  });

  it("does not cache a non-2xx response", async () => {
    let upstreamHits = 0;
    network.use(
      http.get("https://cache-error.example.com/broken.js", () => {
        upstreamHits += 1;
        return new HttpResponse("nope", { status: 500 });
      })
    );
    const env: Env = {
      PROXY_CONFIG: toBase64({
        "cache-error.example.com": {
          upstream: "https://cache-error.example.com",
          cache: { extensions: [".js"], ttl_seconds: 60 },
        },
      }),
    };

    await run(new Request("https://cache-error.example.com/broken.js"), env);
    await run(new Request("https://cache-error.example.com/broken.js"), env);
    expect(upstreamHits).toBe(2);
  });

  it("does not cache when no cache config is set on the host", async () => {
    let upstreamHits = 0;
    network.use(
      http.get("https://no-cache-config.example.com/app.js", () => {
        upstreamHits += 1;
        return HttpResponse.text("console.log(1)");
      })
    );
    const env: Env = {
      PROXY_CONFIG: toBase64({
        "no-cache-config.example.com": { upstream: "https://no-cache-config.example.com" },
      }),
    };

    await run(new Request("https://no-cache-config.example.com/app.js"), env);
    await run(new Request("https://no-cache-config.example.com/app.js"), env);
    expect(upstreamHits).toBe(2);
  });
});
