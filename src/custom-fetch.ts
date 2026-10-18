/**
 * Custom `fetch` support for Soroban RPC traffic (#862).
 *
 * `@stellar/stellar-sdk` v12 issues every RPC request through a process-wide
 * axios instance and exposes no `fetch` hook, so a `ConduitConfig.customFetch`
 * (Cloudflare Workers, proxies, tracing headers, per-request timeouts) cannot
 * be handed to `SorobanRpc.Server` directly. Instead an axios request
 * interceptor routes requests for a registered RPC URL through the supplied
 * `fetch`, and leaves every other URL on axios's default adapter.
 *
 * Registration is therefore per RPC URL, process-wide: if two clients target
 * the same `rpcUrl` with different `customFetch` functions, the most recently
 * constructed one wins.
 */

import { SorobanRpc } from '@stellar/stellar-sdk';

const registry = new Map<string, typeof fetch>();
let installed = false;

/** Minimal slice of the axios request config the adapter reads. */
interface RequestConfig {
  url?: string;
  method?: string;
  data?: unknown;
  headers?: { toJSON?: () => Record<string, unknown> } & Record<string, unknown>;
  timeout?: number;
  signal?: AbortSignal;
  adapter?: unknown;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function headerRecord(config: RequestConfig): Record<string, string> {
  const raw = typeof config.headers?.toJSON === 'function' ? config.headers.toJSON() : config.headers ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/**
 * Retry policy for idempotent RPC reads (#980).
 *
 * Public Soroban RPC endpoints answer 502/503/504 during routine deploys and
 * load-balancer rotations; a single failed GET used to surface as a hard error
 * even though the same request succeeds a second later. Only idempotent methods
 * are retried — replaying a POST could submit a transaction twice.
 */
export interface CustomFetchRetryPolicy {
  /** Total attempts, including the first one. `1` disables retrying. */
  maxAttempts: number;
  /** Delay before the second attempt; doubles on every further attempt. */
  baseDelayMs: number;
  /** Upper bound for a single backoff delay, before jitter. */
  maxDelayMs: number;
}

const DEFAULT_RETRY_POLICY: CustomFetchRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
};

let retryPolicy: CustomFetchRetryPolicy = { ...DEFAULT_RETRY_POLICY };

/** Override the retry policy. Mainly for tests and long-running workers. */
export function setCustomFetchRetryPolicy(policy: Partial<CustomFetchRetryPolicy>): void {
  const next = { ...retryPolicy, ...policy };
  if (!Number.isFinite(next.maxAttempts) || next.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a finite number >= 1');
  }
  if (!Number.isFinite(next.baseDelayMs) || next.baseDelayMs < 0) {
    throw new RangeError('baseDelayMs must be a finite number >= 0');
  }
  if (!Number.isFinite(next.maxDelayMs) || next.maxDelayMs < 0) {
    throw new RangeError('maxDelayMs must be a finite number >= 0');
  }
  retryPolicy = { maxAttempts: Math.trunc(next.maxAttempts), baseDelayMs: next.baseDelayMs, maxDelayMs: next.maxDelayMs };
}

/** Restore the default retry policy. */
export function resetCustomFetchRetryPolicy(): void {
  retryPolicy = { ...DEFAULT_RETRY_POLICY };
}

/** HTTP methods safe to replay: they do not change server state. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Soroban RPC is POST-only, so the HTTP verb says nothing about safety: the
 * JSON-RPC method does. These are read-only and safe to replay. Anything not
 * listed here — `sendTransaction` above all — is never retried.
 */
const READ_ONLY_RPC_METHODS = new Set([
  'getHealth',
  'getNetwork',
  'getVersionInfo',
  'getLatestLedger',
  'getLedgerEntries',
  'getAccount',
  'getContractData',
  'getContractCode',
  'getEvents',
  'getTransaction',
  'getTransactions',
  'getFeeStats',
  'simulateTransaction',
]);

/** Decide from the verb *and* the JSON-RPC method whether replaying is safe. */
function isIdempotentRequest(method: string, body: unknown): boolean {
  if (IDEMPOTENT_METHODS.has(method)) return true;
  if (method !== 'POST' || typeof body !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  return calls.every((call) => {
    const name = (call as { method?: unknown } | null)?.method;
    return typeof name === 'string' && READ_ONLY_RPC_METHODS.has(name);
  });
}

/** A 5xx that is worth another attempt. 501 means "not implemented" — retrying is pointless. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600 && status !== 501;
}

function backoffDelayMs(attempt: number): number {
  const exponential = retryPolicy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, retryPolicy.maxDelayMs);
  // Jitter keeps a fleet of workers from retrying in lockstep.
  return capped * (0.5 + Math.random() * 0.5);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error('aborted'));
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Call `customFetch`, retrying transient 5xx responses and network failures for
 * idempotent methods. Returns the last response even when it is still a 5xx so
 * the caller keeps its single error path.
 */
async function fetchWithRetry(
  customFetch: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const canRetry = isIdempotentRequest(method, init.body);
  const attempts = canRetry ? retryPolicy.maxAttempts : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    try {
      const res = await customFetch(url, init);
      if (!isRetryableStatus(res.status) || attempt === attempts) return res;
      // Drain the body so the connection can be reused before retrying.
      await res.text().catch(() => undefined);
    } catch (err) {
      lastError = err;
      if (!canRetry || attempt === attempts) throw err;
    }
    await sleep(backoffDelayMs(attempt), signal);
  }

  throw lastError ?? new Error('customFetch failed');
}

async function fetchAdapter(config: RequestConfig): Promise<unknown> {
  const url = config.url ?? '';
  const customFetch = registry.get(stripTrailingSlash(url));
  if (!customFetch) throw new Error(`No custom fetch registered for ${url}`);

  const signals: AbortSignal[] = [];
  if (config.signal) signals.push(config.signal);
  if (config.timeout && config.timeout > 0 && typeof AbortSignal.timeout === 'function') {
    signals.push(AbortSignal.timeout(config.timeout));
  }

  const init: RequestInit = {
    method: (config.method ?? 'post').toUpperCase(),
    headers: headerRecord(config),
  };
  if (config.data !== undefined) init.body = typeof config.data === 'string' ? config.data : JSON.stringify(config.data);
  if (signals.length === 1) init.signal = signals[0]!;
  else if (signals.length > 1 && typeof AbortSignal.any === 'function') init.signal = AbortSignal.any(signals);

  const res = await fetchWithRetry(customFetch, url, init, init.signal ?? undefined);
  const text = await res.text();
  const response = {
    // axios's transformResponse parses JSON from a string body.
    data: text,
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    config,
    request: {},
  };

  if (res.status >= 200 && res.status < 300) return response;

  // Mirror axios's rejection shape: callers (RateLimitError.fromRpcError)
  // inspect `err.response.status` and `err.response.headers['retry-after']`.
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* keep raw text */ }
  throw Object.assign(new Error(`Request failed with status code ${res.status}`), {
    isAxiosError: true,
    config,
    response: { ...response, data },
  });
}

function install(): void {
  if (installed) return;
  installed = true;
  SorobanRpc.AxiosClient.interceptors.request.use((config) => {
    const req = config as unknown as RequestConfig;
    if (req.url && registry.has(stripTrailingSlash(req.url))) {
      req.adapter = fetchAdapter;
    }
    return config;
  });
}

/** Route Soroban RPC requests for `rpcUrl` through `customFetch`. */
export function registerCustomFetch(rpcUrl: string, customFetch: typeof fetch): void {
  if (typeof customFetch !== 'function') {
    throw new TypeError('customFetch must be a function');
  }
  install();
  registry.set(stripTrailingSlash(rpcUrl), customFetch);
}

/** Remove a registration made by {@link registerCustomFetch}. Mainly for tests. */
export function unregisterCustomFetch(rpcUrl: string): void {
  registry.delete(stripTrailingSlash(rpcUrl));
}
