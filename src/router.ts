import type { ProxyCondition, Route } from "./types";

export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function checkCondition(request: Request, cond: ProxyCondition): boolean {
  const url = new URL(request.url);

  if (cond.path_prefix) {
    return url.pathname.startsWith(cond.path_prefix);
  }

  let actual = "";
  if (cond.header) {
    actual = request.headers.get(cond.header) ?? "";
  } else if (cond.query_param) {
    actual = url.searchParams.get(cond.query_param) ?? "";
  }
  return actual === (cond.value ?? "");
}

export function matchRoute(request: Request, routes: Route[]): Route | undefined {
  for (const route of routes) {
    if (!route.condition || checkCondition(request, route.condition)) {
      return route;
    }
  }
  return undefined;
}
