import type { ProxyConfig } from "./types";

const regexCache = new Map<string, RegExp>();

function getCompiledRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

export function buildUpstreamRequest(
  request: Request,
  upstream: string,
  config: Pick<ProxyConfig, "request_headers" | "path_rewrite_regex" | "path_rewrite_replacement">
): Request {
  const target = new URL(upstream);
  const originalUrl = new URL(request.url);

  let path = originalUrl.pathname;
  if (config.path_rewrite_regex && config.path_rewrite_replacement !== undefined) {
    const re = getCompiledRegex(config.path_rewrite_regex);
    path = path.replace(re, config.path_rewrite_replacement);
  }

  const outgoingUrl = new URL(target.toString());
  outgoingUrl.pathname = path;
  outgoingUrl.search = originalUrl.search;

  const headers = new Headers(request.headers);
  if (config.request_headers) {
    for (const [key, value] of Object.entries(config.request_headers)) {
      headers.set(key, value);
    }
  }
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(outgoingUrl.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
  });
}

export function applyResponseHeaders(
  response: Response,
  config: Pick<ProxyConfig, "remove_headers" | "response_headers">
): Response {
  const headers = new Headers(response.headers);
  if (config.remove_headers) {
    for (const header of config.remove_headers) {
      headers.delete(header);
    }
  }
  if (config.response_headers) {
    for (const [key, value] of Object.entries(config.response_headers)) {
      headers.set(key, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
