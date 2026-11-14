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

function fakeBinding(handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  return {
    calls,
    fetch: async (req: Request) => {
      calls.push(req.clone());
      return handler(req);
    },
  };
}

const withBinding = (configs: unknown, bindings: Record<string, unknown>) =>
  ({ ...envWith(configs), ...bindings }) as Env;

const HOST = "app.example.com";

describe("handleRequest: service binding on a route", () => {
  const configs = {
    [HOST]: {
      routes: [
        { condition: { path_prefix: "/portal/auth" }, binding: "AUTH_BACKEND" },
        { upstream: "https://default.example.com" },
      ],
    },
  };

  it("routes a matched route to its binding", async () => {
    const auth = fakeBinding(() => new Response("from auth worker"));
    const env = withBinding(configs, { AUTH_BACKEND: auth });
    const response = await handleRequest(
      new Request(`https://${HOST}/portal/auth/login?next=%2Fhome`),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("from auth worker");
    expect(auth.calls.length).toBe(1);
    expect(auth.calls[0].url).toBe(`https://${HOST}/portal/auth/login?next=%2Fhome`);
  });

  it("sends non-matching routes to the URL upstream", async () => {
    network.use(http.get("https://default.example.com/other", () => HttpResponse.text("default")));
    const auth = fakeBinding(() => new Response("from auth worker"));
    const env = withBinding(configs, { AUTH_BACKEND: auth });
    const response = await handleRequest(new Request(`https://${HOST}/other`), env);
    expect(await response.text()).toBe("default");
    expect(auth.calls.length).toBe(0);
  });
});

describe("handleRequest: service binding at host level", () => {
  it("uses a host-level binding", async () => {
    const auth = fakeBinding(() => new Response("from auth worker"));
    const env = withBinding({ [HOST]: { binding: "AUTH_BACKEND" } }, { AUTH_BACKEND: auth });
    const response = await handleRequest(new Request(`https://${HOST}/x`), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("from auth worker");
  });

  it("uses a binding on the wildcard host", async () => {
    const auth = fakeBinding(() => new Response("from auth worker"));
    const env = withBinding({ "*": { binding: "AUTH_BACKEND" } }, { AUTH_BACKEND: auth });
    const response = await handleRequest(new Request("https://unknown.example.com/x"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("from auth worker");
  });

  it("applies path rewrite and header changes through a binding", async () => {
    const auth = fakeBinding(() => new Response("ok", { headers: { Server: "w" } }));
    const env = withBinding(
      {
        [HOST]: {
          binding: "AUTH_BACKEND",
          path_rewrite_regex: "^/v1/(.*)",
          path_rewrite_replacement: "/api/$1",
          request_headers: { "X-Custom": "yes" },
          remove_headers: ["Server"],
          response_headers: { "X-Out": "1" },
        },
      },
      { AUTH_BACKEND: auth }
    );
    const response = await handleRequest(new Request(`https://${HOST}/v1/users`), env);
    expect(new URL(auth.calls[0].url).pathname).toBe("/api/users");
    expect(auth.calls[0].headers.get("X-Custom")).toBe("yes");
    expect(response.headers.get("Server")).toBeNull();
    expect(response.headers.get("X-Out")).toBe("1");
  });

  it("forwards method, body and query through a binding", async () => {
    const auth = fakeBinding(() => new Response("ok"));
    const env = withBinding({ [HOST]: { binding: "AUTH_BACKEND" } }, { AUTH_BACKEND: auth });
    await handleRequest(
      new Request(`https://${HOST}/submit?a=1`, { method: "POST", body: "payload" }),
      env
    );
    expect(auth.calls[0].method).toBe("POST");
    expect(await auth.calls[0].text()).toBe("payload");
    expect(new URL(auth.calls[0].url).search).toBe("?a=1");
  });

  it("prefers binding when upstream is also set", async () => {
    const auth = fakeBinding(() => new Response("from auth worker"));
    const env = withBinding(
      { [HOST]: { binding: "AUTH_BACKEND", upstream: "https://backend.example.com" } },
      { AUTH_BACKEND: auth }
    );
    const response = await handleRequest(new Request(`https://${HOST}/x`), env);
    expect(await response.text()).toBe("from auth worker");
  });
});

describe("handleRequest: service binding failures", () => {
  it("returns 502 when the binding is not declared", async () => {
    const env = withBinding({ [HOST]: { binding: "MISSING" } }, {});
    const response = await handleRequest(new Request(`https://${HOST}/x`), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Upstream not configured" });
  });

  it("returns 502 when the name is not a service", async () => {
    const env = withBinding({ [HOST]: { binding: "PROXY_CONFIG" } }, {});
    const response = await handleRequest(new Request(`https://${HOST}/x`), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Upstream not configured" });
  });

  it("returns 502 when the bound Worker throws", async () => {
    const auth = fakeBinding(() => {
      throw new Error("boom");
    });
    const env = withBinding({ [HOST]: { binding: "AUTH_BACKEND" } }, { AUTH_BACKEND: auth });
    const response = await handleRequest(new Request(`https://${HOST}/x`), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Bad gateway" });
  });
});

describe("handleRequest: binding does not leak into URL upstreams", () => {
  it("route upstream is not overridden by a host-level binding", async () => {
    network.use(http.get("https://default.example.com/x", () => HttpResponse.text("default")));
    const auth = fakeBinding(() => new Response("from auth worker"));
    const env = withBinding(
      { [HOST]: { binding: "AUTH_BACKEND", routes: [{ upstream: "https://default.example.com" }] } },
      { AUTH_BACKEND: auth }
    );
    const response = await handleRequest(new Request(`https://${HOST}/x`), env);
    expect(await response.text()).toBe("default");
    expect(auth.calls.length).toBe(0);
  });

  it("fallback_upstream ignores a host-level binding", async () => {
    network.use(http.get("https://fallback.example.com/x", () => HttpResponse.text("fallback")));
    const auth = fakeBinding(() => new Response("from auth worker"));
    const env = withBinding(
      {
        [HOST]: {
          binding: "AUTH_BACKEND",
          condition: { header: "X-Api-Key", value: "k" },
          fallback_behavior: "fallback_upstream",
          fallback_upstream: "https://fallback.example.com",
        },
      },
      { AUTH_BACKEND: auth }
    );
    const response = await handleRequest(new Request(`https://${HOST}/x`), env);
    expect(await response.text()).toBe("fallback");
    expect(auth.calls.length).toBe(0);
  });
});
