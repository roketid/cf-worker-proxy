import { withRequestLog } from "./request-log";
import { handleRequest } from "./router";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await withRequestLog(request, env, ctx, (req) => handleRequest(req, env, ctx));
    const url = new URL(request.url);
    console.log(`${request.method} ${url.hostname}${url.pathname} -> ${response.status}`);
    return response;
  },
} satisfies ExportedHandler<Env>;
