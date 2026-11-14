export interface ProxyCondition {
  header?: string;
  query_param?: string;
  path_prefix?: string;
  value?: string;
}

export interface Route {
  condition?: ProxyCondition;
  upstream?: string;
  /** Name of a service binding declared in wrangler.jsonc. Wins over `upstream`. */
  binding?: string;
  path_rewrite_regex?: string;
  path_rewrite_replacement?: string;
}

export interface CacheConfig {
  extensions: string[];
  ttl_seconds: number;
}

export interface ProxyConfig {
  upstream?: string;
  /** Name of a service binding declared in wrangler.jsonc. Wins over `upstream`. */
  binding?: string;
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
  cache?: CacheConfig;
  /** Overrides REQUEST_LOG_ENABLED for this host. */
  request_log?: boolean;
}

export type ProxyConfigMap = Record<string, ProxyConfig>;

export const WILDCARD_HOST = "*";

export interface Env {
  PROXY_CONFIG?: string;
  DEFAULT_UPSTREAM?: string;
  DEFAULT_STATIC_INDEX_FILE?: string;
  ASSETS?: Fetcher;
  REQUEST_LOG_ENABLED?: string;
  REQUEST_LOG_S3_ENDPOINT?: string;
  REQUEST_LOG_S3_BUCKET?: string;
  REQUEST_LOG_S3_REGION?: string;
  REQUEST_LOG_S3_ACCESS_KEY_ID?: string;
  REQUEST_LOG_S3_SECRET_ACCESS_KEY?: string;
  REQUEST_LOG_S3_PREFIX?: string;
  REQUEST_LOG_MAX_BODY_BYTES?: string;
  REQUEST_LOG_MIN_STATUS?: string;
  REQUEST_LOG_REDACT_HEADERS?: string;
  REQUEST_LOG_ENCRYPTION_KEY?: string;
}
