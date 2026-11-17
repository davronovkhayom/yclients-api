# yclients-api

[Русская версия](./README.ru.md)

A typed, zero-dependency TypeScript client for the [YCLIENTS](https://yclients.ru) REST API.

- **Typed** methods for companies, staff, services, records (bookings), clients, finance transactions, schedules, goods, storages, analytics, user auth and Marketplace activation.
- **Defaults to `https://api.yclients.ru/api/v1`**, the API's new home after YCLIENTS moved from `yclients.com` to `yclients.ru`. The base URL is configurable.
- **Rate-limit aware**: retries HTTP 429 with exponential backoff and jitter, and honors `Retry-After`.
- **Safe pagination**: `listAll()` / `iterate()` read until the list provably ends and throw instead of silently returning a truncated list.
- **Zero runtime dependencies**: uses the global `fetch` (Node.js 20+, Deno, Bun, edge runtimes).
- **Clear errors**: `YclientsApiError`, `YclientsRateLimitError`, `YclientsNetworkError` and `YclientsPaginationError`. Query values such as phone numbers are kept out of error messages.

> This is an unofficial, community-maintained library and is not affiliated with YCLIENTS.
> Endpoint coverage comes from a production integration and the public API documentation;
> the test suite uses a mocked `fetch` and never calls the live API.

## Install

```bash
npm install yclients-api
```

## Quick start

```ts
import { YclientsClient } from 'yclients-api';

const yc = new YclientsClient({
  partnerToken: process.env.YCLIENTS_PARTNER_TOKEN!,
  userToken: process.env.YCLIENTS_USER_TOKEN, // optional, needed for most company data
});

const companyId = 123456;

const staff = await yc.staff.list(companyId);
const services = await yc.services.list(companyId);

// Every record in January, across as many pages as needed
const records = await yc.records.listAll(companyId, {
  start_date: '2026-01-01',
  end_date: '2026-01-31',
});
```

Keep tokens on the server. The partner token identifies your application and must never be shipped to a browser.

## Authentication

YCLIENTS uses two tokens:

| Token | Who issues it | Header |
| --- | --- | --- |
| Partner token | YCLIENTS, to your developer account | `Authorization: Bearer <partner>` |
| User token | `POST /auth`, for a specific YCLIENTS user | `Authorization: Bearer <partner>, User <user>` |

The client builds the header for you. To obtain a user token:

```ts
const yc = new YclientsClient({ partnerToken });
const { user_token } = await yc.auth.getUserToken({ login, password });

const asUser = yc.withUserToken(user_token); // same settings, different user
```

Store the token, not the password.

## API

All IDs accept numbers or numeric strings and are validated before a request is sent.
All methods accept an optional last argument `{ signal }` for cancellation.

| Method | Endpoint |
| --- | --- |
| `companies.list(params?)` | `GET /companies` (`{ my: 1 }` for companies the user can access) |
| `companies.get(companyId)` | `GET /company/{id}` |
| `staff.list(companyId)` | `GET /company/{id}/staff` |
| `staff.get(companyId, staffId)` | `GET /company/{id}/staff/{staff_id}` |
| `services.list(companyId, params?)` | `GET /services/{id}` |
| `records.list(companyId, params?)` | `GET /records/{id}`, one page |
| `records.listAll / iterate(companyId, params?, options?)` | every page |
| `records.get(companyId, recordId)` | `GET /record/{id}/{record_id}` |
| `clients.list(companyId, params?)` | `GET /clients/{id}`, one page |
| `clients.listAll / iterate(...)` | every page |
| `clients.get(companyId, clientId)` | `GET /client/{id}/{client_id}` |
| `transactions.list / listAll / iterate(...)` | `GET /transactions/{id}` |
| `schedule.get(companyId, staffId, from, to)` | `GET /schedule/{id}/{staff_id}/{from}/{to}` |
| `goods.list / listAll / iterate(...)` | `GET /goods/{id}` |
| `storages.list(companyId)` | `GET /storages/{id}` |
| `analytics.overall(companyId, { date_from, date_to })` | `GET /company/{id}/analytics/overall` |
| `auth.getUserToken({ login, password })` | `POST /auth` |
| `marketplace.activate({ salonId, applicationId })` | `POST /marketplace/partner/callback` |
| `request({ method, path, query, body })` | any other endpoint, returns the full envelope |

Dates are `YYYY-MM-DD` strings; `schedule.get` and `analytics.overall` also accept `Date` objects.
Entity types (`YclientsRecord`, `Client`, `Staff`, ...) list the common fields and keep an index signature, so fields YCLIENTS adds later remain reachable.

### Anything not covered yet

```ts
const envelope = await yc.request<{ id: number }>({
  method: 'PUT',
  path: `record/${companyId}/${recordId}`,
  body: { comment: 'Moved by phone' },
});
console.log(envelope.success, envelope.data, envelope.meta);
```

## Pagination

`list()` returns one page: `{ data, meta, page, count }`.

`listAll()` and `iterate()` walk the pages and stop when:

- a page comes back empty, or
- a page is shorter than `count`, or
- the number of items read reaches `meta.total_count`.

They throw `YclientsPaginationError` if `maxPages` (default 1000) is reached first, or if the server returns the same page twice in a row. A partial list is never returned as if it were complete.

```ts
for await (const client of yc.clients.iterate(companyId, { count: 200 })) {
  await save(client); // streams page by page, constant memory
}

const recent = await yc.clients.listAll(
  companyId,
  { changed_after: '2026-01-01' },
  { maxPages: 50 },
);
```

## Retries and rate limits

| Situation | GET / PUT / DELETE | POST / PATCH |
| --- | --- | --- |
| HTTP 429 | retried | retried (the request was not processed) |
| HTTP 502, 503, 504 | retried | not retried (it may have been applied) |
| Network error or timeout | retried | not retried |
| Other 4xx / 5xx | thrown | thrown |

The wait is `min(maxDelayMs, max(Retry-After, jittered exponential backoff))`.

```ts
const yc = new YclientsClient({
  partnerToken,
  userToken,
  timeoutMs: 20_000, // per attempt, default 30 000
  retry: {
    retries: 4, // default 4; 0 disables retries
    minDelayMs: 1000, // default 1000
    maxDelayMs: 30_000, // default 30 000
    retryStatuses: [429, 502, 503, 504],
    retryNetworkErrors: true,
  },
  onRetry: ({ attempt, delayMs, status, path }) => {
    console.warn(`YCLIENTS ${path} → ${status ?? 'network error'}, retry #${attempt} in ${delayMs} ms`);
  },
});
```

When retries are spent, a `YclientsRateLimitError` carries `retryAfterMs` so you can reschedule the job.

## Errors

```ts
import {
  YclientsApiError,
  YclientsRateLimitError,
  YclientsNetworkError,
  YclientsPaginationError,
} from 'yclients-api';

try {
  await yc.records.get(companyId, recordId);
} catch (error) {
  if (error instanceof YclientsRateLimitError) {
    // still 429 after all retries; error.retryAfterMs
  } else if (error instanceof YclientsApiError) {
    // non-2xx or { success: false }; error.status, error.apiMessage, error.body
  } else if (error instanceof YclientsNetworkError) {
    // no response; error.timedOut tells a timeout from a connection failure
  } else if (error instanceof YclientsPaginationError) {
    // list could not be read completely
  }
}
```

All of them extend `YclientsError`.

## Migrating from `api.yclients.com`

The client talks to `https://api.yclients.ru/api/v1` by default. To keep the old host while you migrate:

```ts
new YclientsClient({ partnerToken, baseUrl: 'https://api.yclients.com/api/v1' });
```

`marketplace.activate()` uses the origin of `baseUrl`, so it follows the same switch.

## Development

```bash
npm install
npm test          # vitest, mocked fetch only
npm run typecheck
npm run build     # emits dist/ (ESM + .d.ts)
```

Contributions are welcome: endpoint coverage, better types for responses you have seen in the wild, and bug reports with redacted payloads. Never paste real tokens, phone numbers or client data into issues.

## License

[MIT](./LICENSE)
