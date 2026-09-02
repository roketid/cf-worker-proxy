import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("toolchain smoke test", () => {
  it("runs the worker inside workerd", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://example.com/"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(await response.text()).toBe("ok");
  });
});
