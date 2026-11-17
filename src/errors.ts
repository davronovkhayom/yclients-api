/** Base class for every error thrown by this library. */
export class YclientsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'YclientsError';
  }
}

export interface YclientsApiErrorInit {
  status: number;
  method: string;
  url: string;
  /** Parsed JSON body, if the response had one. */
  body?: unknown;
  /** Raw response text when the body was not JSON. */
  rawBody?: string;
}

/**
 * The API answered, but not with a successful envelope:
 * either a non-2xx HTTP status or `{ "success": false }`.
 */
export class YclientsApiError extends YclientsError {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly rawBody: string | undefined;
  /** Message reported by YCLIENTS in `meta.message` / `message` / `error`, if any. */
  readonly apiMessage: string | undefined;

  constructor(init: YclientsApiErrorInit, message?: string) {
    const apiMessage = extractApiMessage(init.body);
    super(message ?? `YCLIENTS ${init.method} ${redactUrl(init.url)} failed with HTTP ${init.status}${apiMessage ? `: ${apiMessage}` : ''}`);
    this.name = 'YclientsApiError';
    this.status = init.status;
    this.method = init.method;
    this.url = redactUrl(init.url);
    this.body = init.body;
    this.rawBody = init.rawBody;
    this.apiMessage = apiMessage;
  }
}

/** HTTP 429 that was still rate-limited after all retries were spent. */
export class YclientsRateLimitError extends YclientsApiError {
  /** Delay the server asked for (from `Retry-After`), in milliseconds, if it sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(init: YclientsApiErrorInit & { retryAfterMs?: number | undefined }) {
    super(init);
    this.name = 'YclientsRateLimitError';
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** The request never got an HTTP response: DNS, TLS, connection reset or timeout. */
export class YclientsNetworkError extends YclientsError {
  readonly method: string;
  readonly url: string;
  readonly timedOut: boolean;

  constructor(init: { method: string; url: string; timedOut: boolean; cause: unknown }) {
    super(
      init.timedOut
        ? `YCLIENTS ${init.method} ${redactUrl(init.url)} timed out`
        : `YCLIENTS ${init.method} ${redactUrl(init.url)} failed before a response was received`,
      { cause: init.cause },
    );
    this.name = 'YclientsNetworkError';
    this.method = init.method;
    this.url = redactUrl(init.url);
    this.timedOut = init.timedOut;
  }
}

/**
 * Pagination stopped before the list was provably complete
 * (page limit reached, or the server repeated a page).
 * Thrown instead of silently returning a truncated list.
 */
export class YclientsPaginationError extends YclientsError {
  readonly pagesRead: number;
  readonly itemsRead: number;

  constructor(message: string, init: { pagesRead: number; itemsRead: number }) {
    super(message);
    this.name = 'YclientsPaginationError';
    this.pagesRead = init.pagesRead;
    this.itemsRead = init.itemsRead;
  }
}

function extractApiMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const meta = record.meta;
  const candidates = [
    meta && typeof meta === 'object' ? (meta as Record<string, unknown>).message : undefined,
    record.message,
    record.error,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().replace(/[\r\n]+/g, ' ').slice(0, 500);
    }
  }
  return undefined;
}

/** Strip query-string values that may contain personal data (phones, names) from error messages. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.set(key, '…');
    }
    return parsed.toString().replace(/%E2%80%A6/g, '…');
  } catch {
    return url.split('?')[0] ?? url;
  }
}
