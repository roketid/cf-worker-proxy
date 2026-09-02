import { describe, expect, it } from "vitest";
import { checkCondition, jsonError, matchRoute } from "../src/router";
import type { Route } from "../src/types";

describe("jsonError", () => {
  it("returns a JSON error body with the given status", async () => {
    const response = jsonError(404, "Not found");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("checkCondition", () => {
  it("matches a header condition", () => {
    const request = new Request("https://example.com/", {
      headers: { "X-Api-Key": "secret-key" },
    });
    expect(checkCondition(request, { header: "X-Api-Key", value: "secret-key" })).toBe(true);
  });

  it("fails a header condition on mismatch", () => {
    const request = new Request("https://example.com/", {
      headers: { "X-Api-Key": "wrong" },
    });
    expect(checkCondition(request, { header: "X-Api-Key", value: "secret-key" })).toBe(false);
  });

  it("matches a query_param condition", () => {
    const request = new Request("https://example.com/?token=mytoken");
    expect(checkCondition(request, { query_param: "token", value: "mytoken" })).toBe(true);
  });

  it("matches a path_prefix condition", () => {
    const request = new Request("https://example.com/files/report.pdf");
    expect(checkCondition(request, { path_prefix: "/files/" })).toBe(true);
  });

  it("fails a path_prefix condition when the path doesn't start with it", () => {
    const request = new Request("https://example.com/other/report.pdf");
    expect(checkCondition(request, { path_prefix: "/files/" })).toBe(false);
  });
});

describe("matchRoute", () => {
  it("returns the first route whose condition matches", () => {
    const request = new Request("https://example.com/files/a.txt");
    const routes: Route[] = [
      { condition: { header: "target-app", value: "b" }, upstream: "https://b.example.com" },
      { condition: { path_prefix: "/files/" }, upstream: "https://files.example.com" },
      { upstream: "https://default.example.com" },
    ];
    expect(matchRoute(request, routes)?.upstream).toBe("https://files.example.com");
  });

  it("returns the catch-all route (no condition) when nothing else matches", () => {
    const request = new Request("https://example.com/other");
    const routes: Route[] = [
      { condition: { path_prefix: "/files/" }, upstream: "https://files.example.com" },
      { upstream: "https://default.example.com" },
    ];
    expect(matchRoute(request, routes)?.upstream).toBe("https://default.example.com");
  });

  it("returns undefined when no route matches and there is no catch-all", () => {
    const request = new Request("https://example.com/other");
    const routes: Route[] = [
      { condition: { path_prefix: "/files/" }, upstream: "https://files.example.com" },
    ];
    expect(matchRoute(request, routes)).toBeUndefined();
  });
});
