import {
  YclientsApiError,
  YclientsNetworkError,
  YclientsRateLimitError,
} from './errors.js';
import type { QueryParams, YclientsEnvelope } from './types.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RetryOptions {
  /** How many times to retry after the first attempt. Default `4`. Set `0` to disable. */
  retries?: number;
  /** Base delay for exponential backoff, in ms. Default `1000`. */
  minDelayMs?: number;
  /** Upper bound for a single wait, in ms (also caps `Retry-After`). Default `30000`. */
  maxDelayMs?: number;
  /**
   * HTTP statuses that are retried for idempotent requests (GET, PUT, DELETE).
   * `429` is always retried for every method, because a rate-limited request was not processed.
   * Default `[429, 502, 503, 504]`.
   */
  retryStatuses?: readonly number[];
  /** Retry network failures and timeouts for idempotent requests. Default `true`. */
  retryNetworkErrors?: boolean;
}

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  method: HttpMethod;
  /** Request URL with query values removed. */
  path: string;
  status?: number;
  error?: unknown;
}

export interface TransportOptions {
  baseUrl: string;
  partnerToken: string;
  userToken?: string | undefined;
  fetch: typeof fetch;
  timeoutMs: number;
  retry: Required<RetryOptions>;
  headers: Record<string, string>;
  userAgent?: string | undefined;
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /** Injected for tests. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected for tests; returns a number in [0, 1). */
  random: () => number;
}

export interface RequestOptions {
  method?: HttpMethod;
  /** Path relative to `baseUrl`, e.g. `records/123`. An absolute URL is used as is. */
  path: string;
  query?: QueryParams | undefined;
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Per-request header overrides. */
  headers?: Record<string, string> | undefined;
  /** Send only the partner token even if the client has a user token. */
  partnerOnly?: boolean | undefined;
}

export const DEFAULT_RETRY: Required<RetryOptions> = {
  retries: 4,
  minDelayMs: 1000,
  maxDelayMs: 30_000,
  retryStatuses: [429, 502, 503, 504],
  retryNetworkErrors: true,
};

const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'PUT', 'DELETE']);

export const YCLIENTS_ACCEPT = 'application/vnd.yclients.v2+json';

export function buildAuthorizationHeader(partnerToken: string, userToken?: string): string {
  return userToken ? `Bearer ${partnerToken}, User ${userToken}` : `Bearer ${partnerToken}`;
}

export function buildUrl(baseUrl: string, path: string, query?: QueryParams): URL {
  const url = /^https?:\/\//i.test(path)
    ? new URL(path)
    : new URL(path.replace(/^\/+/, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        const arrayKey = key.endsWith('[]') ? key : `${key}[]`;
        for (const item of value) url.searchParams.append(arrayKey, String(item));
      } else {
        url.searchParams.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
      }
    }
  }
  return url;
}

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 * Returns `undefined` when the header is missing or unusable.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1000);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Exponential backoff with "full jitter", honoring the server's Retry-After when it is longer. */
export function computeDelay(
  attempt: number,
  retry: Required<RetryOptions>,
  random: () => number,
  retryAfterMs?: number,
): number {
  const exponential = Math.min(retry.maxDelayMs, retry.minDelayMs * 2 ** attempt);
  const jittered = Math.round(exponential / 2 + random() * (exponential / 2));
  const delay = retryAfterMs !== undefined ? Math.max(retryAfterMs, jittered) : jittered;
  return Math.min(retry.maxDelayMs, delay);
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Transport {
  constructor(readonly options: TransportOptions) {}

  /** Perform a request and return the full YCLIENTS envelope. */
  async request<T>(request: RequestOptions): Promise<YclientsEnvelope<T>> {
    const method: HttpMethod = request.method ?? 'GET';
    const url = buildUrl(this.options.baseUrl, request.path, request.query);
    const { retry } = this.options;
    const idempotent = IDEMPOTENT_METHODS.has(method);

    for (let attempt = 0; ; attempt += 1) {
      request.signal?.throwIfAborted();
      const canRetry = attempt < retry.retries;

      let response: Response;
      try {
        response = await this.send(method, url, request);
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason ?? error;
        const timedOut = isTimeout(error);
        const networkError = new YclientsNetworkError({ method, url: url.toString(), timedOut, cause: error });
        if (!(canRetry && idempotent && retry.retryNetworkErrors)) throw networkError;
        await this.wait(attempt, method, url, { error: networkError }, request.signal);
        continue;
      }

      if (response.ok) {
        return this.parseSuccess<T>(response, method, url);
      }

      const { body, rawBody } = await readBody(response);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      const retryable =
        response.status === 429 || (idempotent && retry.retryStatuses.includes(response.status));

      if (canRetry && retryable) {
        await this.wait(attempt, method, url, { status: response.status, retryAfterMs }, request.signal);
        continue;
      }

      const init = { status: response.status, method, url: url.toString(), body, rawBody };
      if (response.status === 429) throw new YclientsRateLimitError({ ...init, retryAfterMs });
      throw new YclientsApiError(init);
    }
  }

  private async send(method: HttpMethod, url: URL, request: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: YCLIENTS_ACCEPT,
      Authorization: buildAuthorizationHeader(
        this.options.partnerToken,
        request.partnerOnly ? undefined : this.options.userToken,
      ),
      ...this.options.headers,
      ...(this.options.userAgent ? { 'User-Agent': this.options.userAgent } : {}),
      ...request.headers,
    };
    let body: string | undefined;
    if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.body);
    }

    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const signal = request.signal ? anySignal([request.signal, timeoutSignal]) : timeoutSignal;
    const init: RequestInit = { method, headers, signal };
    if (body !== undefined) init.body = body;
    return this.options.fetch(url, init);
  }

  private async parseSuccess<T>(response: Response, method: HttpMethod, url: URL): Promise<YclientsEnvelope<T>> {
    const { body, rawBody } = await readBody(response);
    if (body === undefined) {
      if (!rawBody) {
        // 204 No Content or an empty body: treat as success without data.
        return { success: true, data: undefined as T, meta: {} };
      }
      throw new YclientsApiError(
        { status: response.status, method, url: url.toString(), rawBody },
        `YCLIENTS ${method} ${url.pathname} returned a non-JSON body`,
      );
    }
    if (isEnvelope(body)) {
      if (body.success === false) {
        throw new YclientsApiError({ status: response.status, method, url: url.toString(), body });
      }
      return body as YclientsEnvelope<T>;
    }
    // A few legacy endpoints answer with a bare array or object.
    return { success: true, data: body as T, meta: {} };
  }

  private async wait(
    attempt: number,
    method: HttpMethod,
    url: URL,
    info: { status?: number; retryAfterMs?: number | undefined; error?: unknown },
    signal?: AbortSignal,
  ): Promise<void> {
    const delayMs = computeDelay(attempt, this.options.retry, this.options.random, info.retryAfterMs);
    const event: RetryEvent = { attempt: attempt + 1, delayMs, method, path: url.pathname };
    if (info.status !== undefined) event.status = info.status;
    if (info.error !== undefined) event.error = info.error;
    this.options.onRetry?.(event);
    await this.options.sleep(delayMs, signal);
  }
}

function isEnvelope(body: unknown): body is YclientsEnvelope<unknown> {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'success' in body &&
    typeof (body as { success: unknown }).success === 'boolean'
  );
}

async function readBody(response: Response): Promise<{ body: unknown; rawBody: string }> {
  let rawBody = '';
  try {
    rawBody = await response.text();
  } catch {
    return { body: undefined, rawBody: '' };
  }
  if (!rawBody.trim()) return { body: undefined, rawBody };
  try {
    return { body: JSON.parse(rawBody) as unknown, rawBody };
  } catch {
    return { body: undefined, rawBody: rawBody.slice(0, 2000) };
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** `AbortSignal.any` is Node 20.3+; this keeps the library working on every Node 20. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
