import { vi } from 'vitest';
import { YclientsClient, type YclientsClientOptions } from '../src/index.js';

export type Reply = Response | Error | (() => Response | Promise<Response>);

export interface MockFetch {
  fetch: typeof fetch;
  calls: Array<{ url: URL; init: RequestInit }>;
}

/** A fetch mock that answers with the queued replies, in order. It never touches the network. */
export function mockFetch(...replies: Reply[]): MockFetch {
  const queue = [...replies];
  const calls: MockFetch['calls'] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: new URL(String(input)), init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`Unexpected request #${calls.length}: ${String(input)}`);
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next;
  });
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

export function ok<T>(data: T, meta: Record<string, unknown> = {}): Response {
  return json({ success: true, data, meta });
}

export const PARTNER = 'test-partner-token';
export const USER = 'test-user-token';

export function makeClient(fetchImpl: typeof fetch, options: Partial<YclientsClientOptions> = {}) {
  const sleep = vi.fn(async (_ms: number) => {});
  const client = new YclientsClient({
    partnerToken: PARTNER,
    userToken: USER,
    fetch: fetchImpl,
    sleep,
    random: () => 0.5,
    ...options,
  });
  return { client, sleep };
}

export function header(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}
