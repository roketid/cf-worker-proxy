import { handleRequest } from "./router";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const response = await handleRequest(request, env);
    const url = new URL(request.url);
    console.log(`${request.method} ${url.hostname}${url.pathname} -> ${response.status}`);
    return response;
  },
} satisfies ExportedHandler<Env>;
