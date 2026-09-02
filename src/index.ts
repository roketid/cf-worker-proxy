export default {
  async fetch(_request: Request, _env: unknown, _ctx: unknown): Promise<Response> {
    return new Response("ok");
  },
};
