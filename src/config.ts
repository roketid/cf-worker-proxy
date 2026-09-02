import type { Env, ProxyConfigMap } from "./types";
import { WILDCARD_HOST } from "./types";

const cache = new Map<string, ProxyConfigMap>();

export function parseConfig(raw: string): ProxyConfigMap {
  if (!raw) return {};
  const json = atob(raw);
  return JSON.parse(json) as ProxyConfigMap;
}

function applyEnvFallback(configs: ProxyConfigMap, env: Env): void {
  if (configs[WILDCARD_HOST]) return;

  const upstream = env.DEFAULT_UPSTREAM ?? "";
  const staticIndexFile = env.DEFAULT_STATIC_INDEX_FILE ?? "";
  if (!upstream && !staticIndexFile) return;

  configs[WILDCARD_HOST] = {
    ...(upstream ? { upstream } : {}),
    ...(staticIndexFile ? { static_index_file: staticIndexFile } : {}),
  };
}

export function getConfig(env: Env): ProxyConfigMap {
  const raw = env.PROXY_CONFIG ?? "";
  const cacheKey = `${raw}|${env.DEFAULT_UPSTREAM ?? ""}|${env.DEFAULT_STATIC_INDEX_FILE ?? ""}`;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const configs = parseConfig(raw);
  applyEnvFallback(configs, env);
  cache.set(cacheKey, configs);
  return configs;
}

export function clearConfigCache(): void {
  cache.clear();
}
