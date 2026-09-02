import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/router";
import type { Env } from "../src/types";
import { network } from "./server";

function toBase64(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

function envWith(configs: unknown, extra: Partial<Env> = {}): Env {
  return { PROXY_CONFIG: toBase64(configs), ...extra };
}

describe("handleRequest: basic proxying", () => {
  it("proxies a matched host to its upstream", async () => {
    network.use(
      http.get("https://backend.example.com/hello", () => HttpResponse.text("hi from backend"))
    );
    const env = envWith({ "api.example.com": { upstream: "https://backend.example.com" } });
    const response = await handleRequest(new Request("https://api.example.com/hello"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hi from backend");
  });

  it("removes and adds headers according to config", async () => {
    network.use(
      http.get(
        "https://backend.example.com/",
        () => new HttpResponse("body", { headers: { Server: "nginx" } })
      )
    );
    const env = envWith({
      "api.example.com": {
        upstream: "https://backend.example.com",
        remove_headers: ["Server"],
        response_headers: { "X-Response-Header": "ResponseValue" },
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(response.headers.get("Server")).toBeNull();
    expect(response.headers.get("X-Response-Header")).toBe("ResponseValue");
  });

  it("rewrites the path before proxying", async () => {
    network.use(
      http.get("https://backend.example.com/api/users", () => HttpResponse.text("rewritten"))
    );
    const env = envWith({
      "api.example.com": {
        upstream: "https://backend.example.com",
        path_rewrite_regex: "^/v1/(.*)",
        path_rewrite_replacement: "/api/$1",
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/v1/users"), env);
    expect(await response.text()).toBe("rewritten");
  });
});

describe("handleRequest: single condition + fallback_behavior", () => {
  const configs = {
    "api.example.com": {
      upstream: "https://backend.example.com",
      condition: { header: "X-Api-Key", value: "secret-key" },
      fallback_behavior: "404",
    },
  };

  it("proxies when the condition matches", async () => {
    network.use(http.get("https://backend.example.com/", () => HttpResponse.text("ok")));
    const env = envWith(configs);
    const response = await handleRequest(
      new Request("https://api.example.com/", { headers: { "X-Api-Key": "secret-key" } }),
      env
    );
    expect(await response.text()).toBe("ok");
  });

  it("falls back to 404 when the condition fails", async () => {
    const env = envWith(configs);
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("falls back to bad_gateway", async () => {
    const env = envWith({
      "api.example.com": {
        upstream: "https://backend.example.com",
        condition: { header: "X-Api-Key", value: "secret-key" },
        fallback_behavior: "bad_gateway",
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(response.status).toBe(502);
  });

  it("defaults to 403 forbidden when fallback_behavior is unset", async () => {
    const env = envWith({
      "api.example.com": {
        upstream: "https://backend.example.com",
        condition: { header: "X-Api-Key", value: "secret-key" },
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(response.status).toBe(403);
  });

  it("proxies to fallback_upstream when configured", async () => {
    network.use(
      http.get("https://fallback.example.com/", () => HttpResponse.text("fallback body"))
    );
    const env = envWith({
      "api.example.com": {
        upstream: "https://backend.example.com",
        condition: { header: "X-Api-Key", value: "secret-key" },
        fallback_behavior: "fallback_upstream",
        fallback_upstream: "https://fallback.example.com",
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(await response.text()).toBe("fallback body");
  });
});

describe("handleRequest: routes", () => {
  const configs = {
    "api.example.com": {
      routes: [
        { condition: { path_prefix: "/files/" }, upstream: "https://files.example.com" },
        { condition: { header: "target-app", value: "b" }, upstream: "https://b.example.com" },
        { upstream: "https://default.example.com" },
      ],
      fallback_behavior: "bad_gateway",
    },
  };

  it("routes by path_prefix", async () => {
    network.use(http.get("https://files.example.com/files/report.pdf", () => HttpResponse.text("file")));
    const env = envWith(configs);
    const response = await handleRequest(new Request("https://api.example.com/files/report.pdf"), env);
    expect(await response.text()).toBe("file");
  });

  it("routes by header when path_prefix doesn't match", async () => {
    network.use(http.get("https://b.example.com/", () => HttpResponse.text("service b")));
    const env = envWith(configs);
    const response = await handleRequest(
      new Request("https://api.example.com/", { headers: { "target-app": "b" } }),
      env
    );
    expect(await response.text()).toBe("service b");
  });

  it("falls through to the catch-all route", async () => {
    network.use(http.get("https://default.example.com/", () => HttpResponse.text("default")));
    const env = envWith(configs);
    const response = await handleRequest(new Request("https://api.example.com/"), env);
    expect(await response.text()).toBe("default");
  });

  it("uses fallback_behavior when routes has entries but none match and there is no catch-all", async () => {
    const env = envWith({
      "api.example.com": {
        routes: [{ condition: { path_prefix: "/files/" }, upstream: "https://files.example.com" }],
        fallback_behavior: "bad_gateway",
      },
    });
    const response = await handleRequest(new Request("https://api.example.com/other"), env);
    expect(response.status).toBe(502);
  });
});

describe("handleRequest: no host match / wildcard fallback", () => {
  it("returns 502 when the host doesn't match and there is no wildcard entry", async () => {
    const env = envWith({ "api.example.com": { upstream: "https://backend.example.com" } });
    const response = await handleRequest(new Request("https://unknown.example.com/"), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "No upstream for host" });
  });

  it("proxies to the wildcard upstream when the host doesn't match", async () => {
    network.use(http.get("https://default.example.com/", () => HttpResponse.text("default upstream")));
    const env = envWith({ "*": { upstream: "https://default.example.com" } });
    const response = await handleRequest(new Request("https://unknown.example.com/"), env);
    expect(await response.text()).toBe("default upstream");
  });

  it("serves the wildcard static_index_file via ASSETS when the host doesn't match", async () => {
    const env = envWith(
      { "*": { static_index_file: "/index.html" } },
      {
        ASSETS: {
          fetch: async () =>
            new Response("<html>fallback page</html>", {
              status: 200,
              headers: { "Content-Type": "text/html" },
            }),
        } as unknown as Fetcher,
      }
    );
    const response = await handleRequest(new Request("https://unknown.example.com/"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>fallback page</html>");
  });
});
