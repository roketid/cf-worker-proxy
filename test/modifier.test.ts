import { describe, expect, it } from "vitest";
import { applyResponseHeaders, buildUpstreamRequest } from "../src/modifier";

describe("buildUpstreamRequest", () => {
  it("targets the upstream's own scheme and host", () => {
    const request = new Request("https://proxy.example.com/foo?x=1");
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {});
    const url = new URL(outgoing.url);
    expect(url.origin).toBe("https://backend.example.com");
    expect(url.pathname).toBe("/foo");
    expect(url.search).toBe("?x=1");
  });

  it("preserves the query string when rewriting the path", () => {
    const request = new Request("https://proxy.example.com/v1/users?limit=10");
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {
      path_rewrite_regex: "^/v1/(.*)",
      path_rewrite_replacement: "/api/$1",
    });
    const url = new URL(outgoing.url);
    expect(url.pathname).toBe("/api/users");
    expect(url.search).toBe("?limit=10");
  });

  it("does not rewrite the path when no regex is configured", () => {
    const request = new Request("https://proxy.example.com/unchanged");
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {});
    expect(new URL(outgoing.url).pathname).toBe("/unchanged");
  });

  it("sets configured request_headers on the outgoing request", () => {
    const request = new Request("https://proxy.example.com/");
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {
      request_headers: { "X-Custom-Header": "MyValue" },
    });
    expect(outgoing.headers.get("X-Custom-Header")).toBe("MyValue");
  });

  it("sets X-Forwarded-For from CF-Connecting-IP", () => {
    const request = new Request("https://proxy.example.com/", {
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {});
    expect(outgoing.headers.get("X-Forwarded-For")).toBe("203.0.113.9");
  });

  it("does not set X-Forwarded-For when CF-Connecting-IP is absent", () => {
    const request = new Request("https://proxy.example.com/");
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {});
    expect(outgoing.headers.get("X-Forwarded-For")).toBeNull();
  });

  it("preserves the request method", () => {
    const request = new Request("https://proxy.example.com/", { method: "POST", body: "hi" });
    const outgoing = buildUpstreamRequest(request, "https://backend.example.com", {});
    expect(outgoing.method).toBe("POST");
  });
});

describe("applyResponseHeaders", () => {
  it("removes headers listed in remove_headers", () => {
    const response = new Response("body", {
      headers: { Server: "nginx", "X-Keep": "yes" },
    });
    const patched = applyResponseHeaders(response, { remove_headers: ["Server"] });
    expect(patched.headers.get("Server")).toBeNull();
    expect(patched.headers.get("X-Keep")).toBe("yes");
  });

  it("sets configured response_headers", () => {
    const response = new Response("body");
    const patched = applyResponseHeaders(response, {
      response_headers: { "X-Response-Header": "ResponseValue" },
    });
    expect(patched.headers.get("X-Response-Header")).toBe("ResponseValue");
  });

  it("preserves status and body", async () => {
    const response = new Response("hello", { status: 201 });
    const patched = applyResponseHeaders(response, {});
    expect(patched.status).toBe(201);
    expect(await patched.text()).toBe("hello");
  });
});
