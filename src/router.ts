import { getConfig } from "./config";
import { applyResponseHeaders, buildUpstreamRequest } from "./modifier";
import { LOG_METADATA_HEADER } from "./request-log";
import type { CacheConfig, Env, ProxyConfig, ProxyCondition, Route } from "./types";
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
    // Both come from the route, so a host-level binding never overrides a route's URL.
    upstream: route.upstream,
    binding: route.binding,
    path_rewrite_regex: route.path_rewrite_regex ?? config.path_rewrite_regex,
    path_rewrite_replacement: route.path_rewrite_replacement ?? config.path_rewrite_replacement,
  };
}

function matchesCacheExtension(request: Request, cache: CacheConfig): boolean {
  const path = new URL(request.url).pathname.toLowerCase();
  return cache.extensions.some((ext) => path.endsWith(ext.toLowerCase()));
}

/** Returns the service binding called `name`, or undefined if `env` has no such service. */
export function resolveBinding(env: Env, name: string): Fetcher | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== "object" || value === null) return undefined;
  return typeof (value as Fetcher).fetch === "function" ? (value as Fetcher) : undefined;
}

export async function serveProxy(
  request: Request,
  config: ProxyConfig,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  let service: Fetcher | undefined;
  if (config.binding) {
    service = resolveBinding(env, config.binding);
    if (!service) {
      return jsonError(502, "Upstream not configured");
    }
  } else if (!config.upstream) {
    return jsonError(500, "Invalid upstream URL");
  }

  const isCacheableMethod = request.method === "GET" || request.method === "HEAD";
  const cacheable = Boolean(config.cache) && isCacheableMethod && matchesCacheExtension(request, config.cache!);
  const cache = caches.default;
  const cacheKey = new Request(request.url, request);

  if (cacheable) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  // A bound Worker is addressed by the binding, not the URL, so it keeps the incoming origin.
  const target = service ? new URL(request.url).origin : config.upstream!;
  const upstreamRequest = buildUpstreamRequest(request, target, config);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await (service ? service.fetch(upstreamRequest) : fetch(upstreamRequest));
  } catch {
    return jsonError(502, "Bad gateway");
  }

  const response = applyResponseHeaders(upstreamResponse, config);

  if (cacheable && response.ok && ctx) {
    const cacheHeaders = new Headers(response.headers);
    // Metadata describes this one request; it must not be replayed on later cache hits.
    cacheHeaders.delete(LOG_METADATA_HEADER);
    cacheHeaders.set("Cache-Control", `public, max-age=${config.cache!.ttl_seconds}`);
    const responseToCache = new Response(response.clone().body, {
      status: response.status,
      statusText: response.statusText,
      headers: cacheHeaders,
    });
    ctx.waitUntil(cache.put(cacheKey, responseToCache));
  }

  return response;
}

export async function handleFallback(
  request: Request,
  config: ProxyConfig,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  switch (config.fallback_behavior) {
    case "fallback_upstream":
      if (config.fallback_upstream) {
        return serveProxy(
          request,
          { ...config, upstream: config.fallback_upstream, binding: undefined },
          env,
          ctx
        );
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
  if (config.upstream || config.binding) {
    return serveProxy(request, config, env);
  }
  if (config.static_index_file && env.ASSETS) {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = config.static_index_file;
    return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  }
  return jsonError(502, "No upstream for host");
}

export async function handleRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const configs = getConfig(env);
  const host = new URL(request.url).hostname;
  const config = configs[host];

  if (!config) {
    return handleNoMatch(request, configs[WILDCARD_HOST], env);
  }

  if (config.routes && config.routes.length > 0) {
    const route = matchRoute(request, config.routes);
    if (route) {
      return serveProxy(request, effectiveConfig(config, route), env, ctx);
    }
    return handleFallback(request, config, env, ctx);
  }

  if (config.condition && !checkCondition(request, config.condition)) {
    return handleFallback(request, config, env, ctx);
  }

  return serveProxy(request, config, env, ctx);
}
