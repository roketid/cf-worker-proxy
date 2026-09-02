export interface ProxyCondition {
  header?: string;
  query_param?: string;
  path_prefix?: string;
  value?: string;
}

export interface Route {
  condition?: ProxyCondition;
  upstream: string;
  path_rewrite_regex?: string;
  path_rewrite_replacement?: string;
}

export interface ProxyConfig {
  upstream?: string;
  request_headers?: Record<string, string>;
  response_headers?: Record<string, string>;
  remove_headers?: string[];
  condition?: ProxyCondition;
  fallback_behavior?: string;
  fallback_upstream?: string;
  path_rewrite_regex?: string;
  path_rewrite_replacement?: string;
  routes?: Route[];
  static_index_file?: string;
}

export type ProxyConfigMap = Record<string, ProxyConfig>;

export const WILDCARD_HOST = "*";

export interface Env {
  PROXY_CONFIG?: string;
  DEFAULT_UPSTREAM?: string;
  DEFAULT_STATIC_INDEX_FILE?: string;
  ASSETS?: Fetcher;
}
