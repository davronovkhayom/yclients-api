import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RETRY,
  YclientsNetworkError,
  YclientsRateLimitError,
  computeDelay,
  parseRetryAfter,
} from '../src/index.js';
import { json, makeClient, mockFetch, ok } from './helpers.js';

const rateLimited = (headers: Record<string, string> = {}) =>
  json({ success: false, meta: { message: 'Too many requests' } }, { status: 429, headers });

describe('retry on 429', () => {
  it('retries and honors a Retry-After in seconds', async () => {
    const mock = mockFetch(rateLimited({ 'Retry-After': '2' }), ok([{ id: 1, name: 'A' }]));
    const onRetry = vi.fn();
    const { client, sleep } = makeClient(mock.fetch, { onRetry });
    const staff = await client.staff.list(1);
    expect(staff).toEqual([{ id: 1, name: 'A' }]);
    expect(mock.calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe(2000);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, delayMs: 2000, status: 429, method: 'GET', path: '/api/v1/company/1/staff' }),
    );
  });

  it('uses exponential backoff when there is no Retry-After', async () => {
    const mock = mockFetch(rateLimited(), rateLimited(), rateLimited(), ok([]));
    const { client, sleep } = makeClient(mock.fetch, { retry: { minDelayMs: 100, maxDelayMs: 10_000 } });
    await client.staff.list(1);
    // random() = 0.5 → delay = 0.75 × min(max, min × 2^attempt)
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([75, 150, 300]);
  });

  it('throws YclientsRateLimitError once retries are spent', async () => {
    const mock = mockFetch(rateLimited({ 'Retry-After': '1' }), rateLimited({ 'Retry-After': '1' }), rateLimited({ 'Retry-After': '5' }));
    const { client, sleep } = makeClient(mock.fetch, { retry: { retries: 2 } });
    const error = (await client.staff.list(1).catch((caught: unknown) => caught)) as YclientsRateLimitError;
    expect(error).toBeInstanceOf(YclientsRateLimitError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(5000);
    expect(mock.calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('retries 429 for POST too, because the request was not processed', async () => {
    const mock = mockFetch(rateLimited(), ok({ user_token: 't' }));
    const { client } = makeClient(mock.fetch);
    await client.auth.getUserToken({ login: 'a', password: 'b' });
    expect(mock.calls).toHaveLength(2);
  });

  it('can be disabled with retries: 0', async () => {
    const mock = mockFetch(rateLimited());
    const { client } = makeClient(mock.fetch, { retry: { retries: 0 } });
    await expect(client.staff.list(1)).rejects.toBeInstanceOf(YclientsRateLimitError);
    expect(mock.calls).toHaveLength(1);
  });
});

describe('retry on gateway errors and network failures', () => {
  it('retries 503 for GET', async () => {
    const mock = mockFetch(new Response('Service Unavailable', { status: 503 }), ok([]));
    const { client } = makeClient(mock.fetch);
    await expect(client.staff.list(1)).resolves.toEqual([]);
    expect(mock.calls).toHaveLength(2);
  });

  it('does not retry 503 for POST (it may have been applied)', async () => {
    const mock = mockFetch(new Response('Service Unavailable', { status: 503 }));
    const { client } = makeClient(mock.fetch);
    await expect(client.auth.getUserToken({ login: 'a', password: 'b' })).rejects.toMatchObject({ status: 503 });
    expect(mock.calls).toHaveLength(1);
  });

  it('retries network failures for GET', async () => {
    const mock = mockFetch(new TypeError('fetch failed'), ok([]));
    const { client } = makeClient(mock.fetch);
    await expect(client.staff.list(1)).resolves.toEqual([]);
    expect(mock.calls).toHaveLength(2);
  });

  it('does not retry network failures for POST', async () => {
    const mock = mockFetch(new TypeError('fetch failed'));
    const { client } = makeClient(mock.fetch);
    const error = (await client.auth.getUserToken({ login: 'a', password: 'b' }).catch((caught: unknown) => caught)) as YclientsNetworkError;
    expect(error).toBeInstanceOf(YclientsNetworkError);
    expect(error.timedOut).toBe(false);
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('reports a timeout as YclientsNetworkError with timedOut = true', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const { client } = makeClient(hanging, { timeoutMs: 20, retry: { retries: 0 } });
    const error = (await client.staff.list(1).catch((caught: unknown) => caught)) as YclientsNetworkError;
    expect(error).toBeInstanceOf(YclientsNetworkError);
    expect(error.timedOut).toBe(true);
  });

  it('stops immediately when the caller aborts', async () => {
    const controller = new AbortController();
    const mock = mockFetch(rateLimited(), ok([]));
    const { client } = makeClient(mock.fetch, {
      sleep: async () => {
        controller.abort(new Error('caller gave up'));
      },
    });
    await expect(client.staff.list(1, { signal: controller.signal })).rejects.toThrow('caller gave up');
    expect(mock.calls).toHaveLength(1);
  });
});

describe('backoff helpers', () => {
  it('parseRetryAfter reads seconds and HTTP dates', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('0.5')).toBe(500);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('computeDelay stays within [half, full] of the exponential step and under maxDelayMs', () => {
    const retry = { ...DEFAULT_RETRY, minDelayMs: 1000, maxDelayMs: 8000 };
    expect(computeDelay(0, retry, () => 0)).toBe(500);
    expect(computeDelay(0, retry, () => 0.999999)).toBe(1000);
    expect(computeDelay(10, retry, () => 0.999999)).toBe(8000);
    expect(computeDelay(0, retry, () => 0, 60_000)).toBe(8000);
    expect(computeDelay(0, retry, () => 0, 3000)).toBe(3000);
  });
});
