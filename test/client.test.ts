import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URL,
  YclientsApiError,
  YclientsClient,
  YclientsPaginationError,
} from '../src/index.js';
import { PARTNER, USER, header, json, makeClient, mockFetch, ok } from './helpers.js';

describe('YclientsClient: configuration and auth', () => {
  it('defaults to the api.yclients.ru host', async () => {
    expect(DEFAULT_BASE_URL).toBe('https://api.yclients.ru/api/v1');
    const mock = mockFetch(ok({ id: 1, title: 'Main' }));
    const { client } = makeClient(mock.fetch);
    await client.companies.get(1);
    expect(mock.calls[0]!.url.toString()).toBe('https://api.yclients.ru/api/v1/company/1');
  });

  it('sends partner and user tokens with the v2 Accept header', async () => {
    const mock = mockFetch(ok([]));
    const { client } = makeClient(mock.fetch);
    await client.staff.list(42);
    const init = mock.calls[0]!.init;
    expect(header(init, 'Authorization')).toBe(`Bearer ${PARTNER}, User ${USER}`);
    expect(header(init, 'Accept')).toBe('application/vnd.yclients.v2+json');
    expect(init.method).toBe('GET');
    expect(header(init, 'Content-Type')).toBeUndefined();
  });

  it('sends only the partner token when no user token is set', async () => {
    const mock = mockFetch(ok([]));
    const { client } = makeClient(mock.fetch, { userToken: undefined });
    await client.companies.list();
    expect(header(mock.calls[0]!.init, 'Authorization')).toBe(`Bearer ${PARTNER}`);
  });

  it('honors a custom base URL, e.g. the legacy .com host', async () => {
    const mock = mockFetch(ok([]));
    const { client } = makeClient(mock.fetch, { baseUrl: 'https://api.yclients.com/api/v1/' });
    await client.staff.list(7);
    expect(mock.calls[0]!.url.toString()).toBe('https://api.yclients.com/api/v1/company/7/staff');
  });

  it('exchanges login and password for a user token with the partner token only', async () => {
    const mock = mockFetch(ok({ id: 5, user_token: 'fresh-user-token', name: 'Test User' }));
    const { client } = makeClient(mock.fetch);
    const result = await client.auth.getUserToken({ login: 'user@example.test', password: 'secret' });
    expect(result.user_token).toBe('fresh-user-token');
    const call = mock.calls[0]!;
    expect(call.url.pathname).toBe('/api/v1/auth');
    expect(call.init.method).toBe('POST');
    expect(header(call.init, 'Authorization')).toBe(`Bearer ${PARTNER}`);
    expect(header(call.init, 'Content-Type')).toBe('application/json');
    expect(JSON.parse(String(call.init.body))).toEqual({ login: 'user@example.test', password: 'secret' });
  });

  it('withUserToken returns a client that uses the new token', async () => {
    const mock = mockFetch(ok([]));
    const { client } = makeClient(mock.fetch, { userToken: undefined });
    await client.withUserToken('other-user').staff.list(1);
    expect(header(mock.calls[0]!.init, 'Authorization')).toBe(`Bearer ${PARTNER}, User other-user`);
  });

  it('merges custom headers and a User-Agent', async () => {
    const mock = mockFetch(ok([]));
    const { client } = makeClient(mock.fetch, { headers: { 'X-Trace': 'abc' }, userAgent: 'my-app/1.0' });
    await client.staff.list(1);
    expect(header(mock.calls[0]!.init, 'X-Trace')).toBe('abc');
    expect(header(mock.calls[0]!.init, 'User-Agent')).toBe('my-app/1.0');
  });

  it('requires a partner token', () => {
    expect(() => new YclientsClient({ partnerToken: '' })).toThrow(/partnerToken is required/);
  });

  it('rejects non-numeric IDs before sending anything', async () => {
    const mock = mockFetch();
    const { client } = makeClient(mock.fetch);
    await expect(client.records.get('12/../../admin', 1)).rejects.toThrow(TypeError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('YclientsClient: endpoints', () => {
  it('records.list sends filters and returns the page with meta', async () => {
    const mock = mockFetch(ok([{ id: 1, company_id: 9, staff_id: 3 }], { total_count: 1 }));
    const { client } = makeClient(mock.fetch);
    const page = await client.records.list(9, { start_date: '2026-01-01', end_date: '2026-01-31', staff_id: 3 });
    const url = mock.calls[0]!.url;
    expect(url.pathname).toBe('/api/v1/records/9');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start_date: '2026-01-01',
      end_date: '2026-01-31',
      staff_id: '3',
      page: '1',
      count: '200',
    });
    expect(page).toEqual({ data: [{ id: 1, company_id: 9, staff_id: 3 }], meta: { total_count: 1 }, page: 1, count: 200 });
  });

  it('records.get, clients.get and staff.get build the documented paths', async () => {
    const mock = mockFetch(ok({ id: 11 }), ok({ id: 12 }), ok({ id: 13 }));
    const { client } = makeClient(mock.fetch);
    await client.records.get(1, 11);
    await client.clients.get(1, 12);
    await client.staff.get(1, 13);
    expect(mock.calls.map((call) => call.url.pathname)).toEqual([
      '/api/v1/record/1/11',
      '/api/v1/client/1/12',
      '/api/v1/company/1/staff/13',
    ]);
  });

  it('companies.list passes filters', async () => {
    const mock = mockFetch(ok([{ id: 1, title: 'A' }]));
    const { client } = makeClient(mock.fetch);
    const companies = await client.companies.list({ my: 1 });
    expect(mock.calls[0]!.url.search).toBe('?my=1');
    expect(companies).toHaveLength(1);
  });

  it('services.list accepts both array and { services } payloads', async () => {
    const mock = mockFetch(ok([{ id: 1, title: 'Cut' }]), ok({ services: [{ id: 2, title: 'Shave' }] }));
    const { client } = makeClient(mock.fetch);
    expect(await client.services.list(5)).toEqual([{ id: 1, title: 'Cut' }]);
    expect(await client.services.list(5)).toEqual([{ id: 2, title: 'Shave' }]);
    expect(mock.calls[0]!.url.pathname).toBe('/api/v1/services/5');
  });

  it('schedule.get validates and formats dates', async () => {
    const mock = mockFetch(ok([{ date: '2026-03-01', is_working: true }]));
    const { client } = makeClient(mock.fetch);
    const days = await client.schedule.get(1, 2, new Date('2026-03-01T00:00:00Z'), '2026-03-07');
    expect(mock.calls[0]!.url.pathname).toBe('/api/v1/schedule/1/2/2026-03-01/2026-03-07');
    expect(days).toHaveLength(1);
    await expect(client.schedule.get(1, 2, '01.03.2026', '2026-03-07')).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('transactions.list and analytics.overall send their query parameters', async () => {
    const mock = mockFetch(ok([]), ok({ income_total_stats: { current_sum: '100' } }));
    const { client } = makeClient(mock.fetch);
    await client.transactions.list(3, { start_date: '2026-01-01', end_date: '2026-01-02', master_id: 8, deleted: 0 });
    await client.analytics.overall(3, { date_from: '2026-01-01', date_to: '2026-01-31' });
    expect(mock.calls[0]!.url.searchParams.get('master_id')).toBe('8');
    expect(mock.calls[0]!.url.searchParams.get('deleted')).toBe('0');
    expect(mock.calls[1]!.url.pathname).toBe('/api/v1/company/3/analytics/overall');
    expect(mock.calls[1]!.url.searchParams.get('date_from')).toBe('2026-01-01');
  });

  it('serializes array and boolean query values the way YCLIENTS expects', async () => {
    const mock = mockFetch(ok([]));
    const { client } = makeClient(mock.fetch);
    await client.records.list(1, { staff_id: undefined, with_deleted: 1, extra_flag: true, 'ids': [1, 2] });
    const params = mock.calls[0]!.url.searchParams;
    expect(params.has('staff_id')).toBe(false);
    expect(params.get('with_deleted')).toBe('1');
    expect(params.get('extra_flag')).toBe('1');
    expect(params.getAll('ids[]')).toEqual(['1', '2']);
  });

  it('accepts legacy endpoints that answer with a bare array', async () => {
    const mock = mockFetch(json([{ id: 1, title: 'Storage' }]));
    const { client } = makeClient(mock.fetch);
    expect(await client.storages.list(1)).toEqual([{ id: 1, title: 'Storage' }]);
  });

  it('marketplace.activate posts to the host origin with the partner token only', async () => {
    const mock = mockFetch(ok(null));
    const { client } = makeClient(mock.fetch);
    await client.marketplace.activate({ salonId: '123', applicationId: 456 });
    const call = mock.calls[0]!;
    expect(call.url.toString()).toBe('https://api.yclients.ru/marketplace/partner/callback');
    expect(header(call.init, 'Authorization')).toBe(`Bearer ${PARTNER}`);
    expect(JSON.parse(String(call.init.body))).toEqual({ salon_id: 123, application_id: 456 });
  });

  it('request() reaches any endpoint and returns the full envelope', async () => {
    const mock = mockFetch(ok({ id: 1 }, { foo: 'bar' }));
    const { client } = makeClient(mock.fetch);
    const envelope = await client.request<{ id: number }>({ method: 'PUT', path: '/record/1/2', body: { comment: 'x' } });
    expect(envelope).toEqual({ success: true, data: { id: 1 }, meta: { foo: 'bar' } });
    expect(mock.calls[0]!.url.pathname).toBe('/api/v1/record/1/2');
  });
});

describe('YclientsClient: errors', () => {
  it('turns success:false into YclientsApiError with the API message', async () => {
    const mock = mockFetch(json({ success: false, data: null, meta: { message: 'Нет доступа' } }));
    const { client } = makeClient(mock.fetch);
    const error = await client.staff.list(1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(YclientsApiError);
    expect((error as YclientsApiError).apiMessage).toBe('Нет доступа');
    expect((error as YclientsApiError).status).toBe(200);
  });

  it('does not retry 4xx errors and exposes the status', async () => {
    const mock = mockFetch(json({ success: false, meta: { message: 'Not found' } }, { status: 404 }));
    const { client, sleep } = makeClient(mock.fetch);
    const error = (await client.records.get(1, 2).catch((caught: unknown) => caught)) as YclientsApiError;
    expect(error).toBeInstanceOf(YclientsApiError);
    expect(error.status).toBe(404);
    expect(error.message).toContain('Not found');
    expect(mock.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps query values (phones, names) out of error messages', async () => {
    const mock = mockFetch(json({ success: false }, { status: 403 }));
    const { client } = makeClient(mock.fetch);
    const error = (await client.clients.list(1, { phone: '70000000000' }).catch((caught: unknown) => caught)) as YclientsApiError;
    expect(error.message).not.toContain('70000000000');
    expect(error.url).not.toContain('70000000000');
    expect(error.message).toContain('/clients/1');
  });

  it('reports a non-JSON success body as an error', async () => {
    const mock = mockFetch(new Response('<html>maintenance</html>', { status: 200 }));
    const { client } = makeClient(mock.fetch);
    await expect(client.staff.list(1)).rejects.toThrow(/non-JSON/);
  });
});

describe('YclientsClient: pagination', () => {
  it('listAll reads pages until a short page', async () => {
    const mock = mockFetch(ok([{ id: 1 }, { id: 2 }]), ok([{ id: 3 }, { id: 4 }]), ok([{ id: 5 }]));
    const { client } = makeClient(mock.fetch);
    const records = await client.records.listAll(1, { start_date: '2026-01-01', end_date: '2026-01-31', count: 2 });
    expect(records.map((record) => record.id)).toEqual([1, 2, 3, 4, 5]);
    expect(mock.calls.map((call) => call.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(mock.calls.every((call) => call.url.searchParams.get('start_date') === '2026-01-01')).toBe(true);
  });

  it('stops at meta.total_count without requesting an extra empty page', async () => {
    const mock = mockFetch(ok([{ id: 1 }, { id: 2 }], { total_count: 4 }), ok([{ id: 3 }, { id: 4 }], { total_count: 4 }));
    const { client } = makeClient(mock.fetch);
    const clients = await client.clients.listAll(1, { count: 2 });
    expect(clients.map((item) => item.id)).toEqual([1, 2, 3, 4]);
    expect(mock.calls).toHaveLength(2);
  });

  it('stops on an empty page', async () => {
    const mock = mockFetch(ok([{ id: 1 }, { id: 2 }]), ok([]));
    const { client } = makeClient(mock.fetch);
    expect(await client.transactions.listAll(1, { count: 2 })).toHaveLength(2);
  });

  it('throws instead of returning a truncated list when maxPages is reached', async () => {
    const mock = mockFetch(ok([{ id: 1 }]), ok([{ id: 2 }]), ok([{ id: 3 }]));
    const { client } = makeClient(mock.fetch);
    const error = await client.goods.listAll(1, { count: 1 }, { maxPages: 2 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(YclientsPaginationError);
    expect((error as YclientsPaginationError).itemsRead).toBe(2);
  });

  it('throws when the server repeats the same page', async () => {
    const mock = mockFetch(ok([{ id: 1 }, { id: 2 }]), ok([{ id: 1 }, { id: 2 }]));
    const { client } = makeClient(mock.fetch);
    await expect(client.clients.listAll(1, { count: 2 })).rejects.toThrow(/repeated/);
  });

  it('iterate streams items lazily and can stop early', async () => {
    const mock = mockFetch(ok([{ id: 1 }, { id: 2 }]), ok([{ id: 3 }, { id: 4 }]));
    const { client } = makeClient(mock.fetch);
    const seen: number[] = [];
    for await (const record of client.records.iterate(1, { count: 2 })) {
      seen.push(record.id);
      if (record.id === 2) break;
    }
    expect(seen).toEqual([1, 2]);
    expect(mock.calls).toHaveLength(1);
  });
});
