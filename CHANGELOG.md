# Changelog

## 0.1.0 (unreleased)

First version.

- `YclientsClient` with typed methods for companies, staff, services, records, clients, finance transactions, schedules, goods, storages, analytics, user auth (`POST /auth`) and Marketplace activation.
- Default base URL `https://api.yclients.ru/api/v1`; configurable for the legacy `.com` host.
- Retries with exponential backoff and jitter on 429 (all methods) and on 502/503/504 and network errors (idempotent methods), honoring `Retry-After`.
- `listAll()` / `iterate()` pagination that throws `YclientsPaginationError` instead of returning a truncated list.
- Error classes: `YclientsError`, `YclientsApiError`, `YclientsRateLimitError`, `YclientsNetworkError`, `YclientsPaginationError`.
