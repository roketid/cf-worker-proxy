import { beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache, getConfig, parseConfig } from "../src/config";
import type { Env } from "../src/types";

function toBase64(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

describe("parseConfig", () => {
  it("returns an empty map for an empty string", () => {
    expect(parseConfig("")).toEqual({});
  });

  it("decodes base64 JSON into a ProxyConfigMap", () => {
    const raw = toBase64({
      "example.com": { upstream: "https://backend.example.com" },
    });
    expect(parseConfig(raw)).toEqual({
      "example.com": { upstream: "https://backend.example.com" },
    });
  });
});

describe("getConfig", () => {
  beforeEach(() => clearConfigCache());

  it("parses PROXY_CONFIG from env", () => {
    const env: Env = {
      PROXY_CONFIG: toBase64({
        "example.com": { upstream: "https://backend.example.com" },
      }),
    };
    expect(getConfig(env)).toEqual({
      "example.com": { upstream: "https://backend.example.com" },
    });
  });

  it("caches the parsed result for identical env values", () => {
    const env: Env = {
      PROXY_CONFIG: toBase64({ "example.com": { upstream: "https://a.example.com" } }),
    };
    const first = getConfig(env);
    const second = getConfig(env);
    expect(second).toBe(first);
  });

  it("applies DEFAULT_UPSTREAM as the wildcard fallback when no \"*\" entry exists", () => {
    const env: Env = {
      PROXY_CONFIG: toBase64({ "example.com": { upstream: "https://a.example.com" } }),
      DEFAULT_UPSTREAM: "https://default.example.com",
    };
    expect(getConfig(env)["*"]).toEqual({ upstream: "https://default.example.com" });
  });

  it("applies DEFAULT_STATIC_INDEX_FILE as the wildcard fallback when no \"*\" entry exists", () => {
    const env: Env = {
      PROXY_CONFIG: toBase64({}),
      DEFAULT_STATIC_INDEX_FILE: "/index.html",
    };
    expect(getConfig(env)["*"]).toEqual({ static_index_file: "/index.html" });
  });

  it("does not override an explicit \"*\" entry with DEFAULT_UPSTREAM", () => {
    const env: Env = {
      PROXY_CONFIG: toBase64({ "*": { upstream: "https://explicit.example.com" } }),
      DEFAULT_UPSTREAM: "https://default.example.com",
    };
    expect(getConfig(env)["*"]).toEqual({ upstream: "https://explicit.example.com" });
  });

  it("adds no wildcard entry when neither PROXY_CONFIG nor env fallbacks set one", () => {
    const env: Env = { PROXY_CONFIG: toBase64({}) };
    expect(getConfig(env)["*"]).toBeUndefined();
  });
});
