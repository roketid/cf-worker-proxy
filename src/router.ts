import { getConfig } from "./config";
import { applyResponseHeaders, buildUpstreamRequest } from "./modifier";
import type { Env, ProxyConfig, ProxyCondition, Route } from "./types";
import { WILDCARD_HOST } from "./types";

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

function effectiveConfig(config: ProxyConfig, route: Route): ProxyConfig {
  return {
    ...config,
    upstream: route.upstream,
    path_rewrite_regex: route.path_rewrite_regex ?? config.path_rewrite_regex,
    path_rewrite_replacement: route.path_rewrite_replacement ?? config.path_rewrite_replacement,
  };
}

export async function serveProxy(request: Request, config: ProxyConfig): Promise<Response> {
  if (!config.upstream) {
    return jsonError(500, "Invalid upstream URL");
  }
  const upstreamRequest = buildUpstreamRequest(request, config.upstream, config);
  try {
    const upstreamResponse = await fetch(upstreamRequest);
    return applyResponseHeaders(upstreamResponse, config);
  } catch {
    return jsonError(502, "Bad gateway");
  }
}

export async function handleFallback(request: Request, config: ProxyConfig): Promise<Response> {
  switch (config.fallback_behavior) {
    case "fallback_upstream":
      if (config.fallback_upstream) {
        return serveProxy(request, { ...config, upstream: config.fallback_upstream });
      }
      return jsonError(502, "No fallback upstream configured");
    case "404":
      return jsonError(404, "Not found");
    case "bad_gateway":
      return jsonError(502, "Bad gateway");
    default:
      return jsonError(403, "Forbidden");
  }
}

export async function handleNoMatch(
  request: Request,
  config: ProxyConfig | undefined,
  env: Env
): Promise<Response> {
  if (!config) {
    return jsonError(502, "No upstream for host");
  }
  if (config.upstream) {
    return serveProxy(request, config);
  }
  if (config.static_index_file && env.ASSETS) {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = config.static_index_file;
    return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  }
  return jsonError(502, "No upstream for host");
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const configs = getConfig(env);
  const host = new URL(request.url).hostname;
  const config = configs[host];

  if (!config) {
    return handleNoMatch(request, configs[WILDCARD_HOST], env);
  }

  if (config.routes && config.routes.length > 0) {
    const route = matchRoute(request, config.routes);
    if (route) {
      return serveProxy(request, effectiveConfig(config, route));
    }
    return handleFallback(request, config);
  }

  if (config.condition && !checkCondition(request, config.condition)) {
    return handleFallback(request, config);
  }

  return serveProxy(request, config);
}
