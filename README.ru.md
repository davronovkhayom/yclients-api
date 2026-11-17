# yclients-api

[English version](./README.md)

Типизированный клиент REST API [YCLIENTS](https://yclients.ru) на TypeScript без runtime-зависимостей.

- **Типизированные методы**: филиалы, сотрудники, услуги, записи, клиенты, финансовые транзакции, графики работы, товары, склады, аналитика, авторизация пользователя и активация приложения в Маркетплейсе.
- **По умолчанию `https://api.yclients.ru/api/v1`**: YCLIENTS переехал с `yclients.com` на `yclients.ru`. Базовый адрес можно поменять.
- **Учитывает лимиты запросов**: повторяет HTTP 429 с экспоненциальной задержкой и джиттером, соблюдает `Retry-After`.
- **Безопасная пагинация**: `listAll()` / `iterate()` читают страницы, пока список точно не закончится, и бросают ошибку вместо того, чтобы молча вернуть обрезанный список.
- **Без зависимостей**: используется глобальный `fetch` (Node.js 20+, Deno, Bun, edge-среды).
- **Понятные ошибки**: `YclientsApiError`, `YclientsRateLimitError`, `YclientsNetworkError`, `YclientsPaginationError`. Значения параметров запроса (например, телефоны) не попадают в текст ошибок.

> Это неофициальная библиотека, которую поддерживает сообщество; она не связана с компанией YCLIENTS.
> Набор методов взят из работающей интеграции и публичной документации API.
> Тесты используют подменённый `fetch` и никогда не обращаются к настоящему API.

## Установка

```bash
npm install yclients-api
```

## Быстрый старт

```ts
import { YclientsClient } from 'yclients-api';

const yc = new YclientsClient({
  partnerToken: process.env.YCLIENTS_PARTNER_TOKEN!,
  userToken: process.env.YCLIENTS_USER_TOKEN, // необязателен, но нужен для большинства данных филиала
});

const companyId = 123456;

const staff = await yc.staff.list(companyId);
const services = await yc.services.list(companyId);

// Все записи за январь, сколько бы страниц ни понадобилось
const records = await yc.records.listAll(companyId, {
  start_date: '2026-01-01',
  end_date: '2026-01-31',
});
```

Храните токены только на сервере. Партнёрский токен идентифицирует ваше приложение, его нельзя отдавать в браузер.

## Авторизация

В YCLIENTS два токена:

| Токен | Кто выдаёт | Заголовок |
| --- | --- | --- |
| Партнёрский | YCLIENTS, на аккаунт разработчика | `Authorization: Bearer <partner>` |
| Пользовательский | `POST /auth`, для конкретного пользователя YCLIENTS | `Authorization: Bearer <partner>, User <user>` |

Клиент сам собирает заголовок. Получить пользовательский токен:

```ts
const yc = new YclientsClient({ partnerToken });
const { user_token } = await yc.auth.getUserToken({ login, password });

const asUser = yc.withUserToken(user_token); // те же настройки, другой пользователь
```

Сохраняйте токен, а не пароль.

## Методы

ID принимаются числом или строкой из цифр и проверяются до отправки запроса.
Последний необязательный аргумент каждого метода — `{ signal }` для отмены.

| Метод | Эндпоинт |
| --- | --- |
| `companies.list(params?)` | `GET /companies` (`{ my: 1 }` — филиалы, доступные пользователю) |
| `companies.get(companyId)` | `GET /company/{id}` |
| `staff.list(companyId)` | `GET /company/{id}/staff` |
| `staff.get(companyId, staffId)` | `GET /company/{id}/staff/{staff_id}` |
| `services.list(companyId, params?)` | `GET /services/{id}` |
| `records.list(companyId, params?)` | `GET /records/{id}`, одна страница |
| `records.listAll / iterate(companyId, params?, options?)` | все страницы |
| `records.get(companyId, recordId)` | `GET /record/{id}/{record_id}` |
| `clients.list(companyId, params?)` | `GET /clients/{id}`, одна страница |
| `clients.listAll / iterate(...)` | все страницы |
| `clients.get(companyId, clientId)` | `GET /client/{id}/{client_id}` |
| `transactions.list / listAll / iterate(...)` | `GET /transactions/{id}` |
| `schedule.get(companyId, staffId, from, to)` | `GET /schedule/{id}/{staff_id}/{from}/{to}` |
| `goods.list / listAll / iterate(...)` | `GET /goods/{id}` |
| `storages.list(companyId)` | `GET /storages/{id}` |
| `analytics.overall(companyId, { date_from, date_to })` | `GET /company/{id}/analytics/overall` |
| `auth.getUserToken({ login, password })` | `POST /auth` |
| `marketplace.activate({ salonId, applicationId })` | `POST /marketplace/partner/callback` |
| `request({ method, path, query, body })` | любой другой эндпоинт, возвращает весь ответ |

Даты передаются строкой `YYYY-MM-DD`; `schedule.get` и `analytics.overall` принимают и `Date`.
Типы сущностей (`YclientsRecord`, `Client`, `Staff`, ...) описывают основные поля и оставляют индексную сигнатуру, поэтому новые поля YCLIENTS тоже доступны.

### Если нужного метода нет

```ts
const envelope = await yc.request<{ id: number }>({
  method: 'PUT',
  path: `record/${companyId}/${recordId}`,
  body: { comment: 'Перенесли по телефону' },
});
console.log(envelope.success, envelope.data, envelope.meta);
```

## Пагинация

`list()` возвращает одну страницу: `{ data, meta, page, count }`.

`listAll()` и `iterate()` проходят страницы и останавливаются, когда:

- пришла пустая страница, или
- страница короче `count`, или
- прочитано столько элементов, сколько указано в `meta.total_count`.

Если раньше достигнут `maxPages` (по умолчанию 1000) или сервер дважды подряд вернул одну и ту же страницу, бросается `YclientsPaginationError`. Неполный список никогда не выдаётся за полный.

```ts
for await (const client of yc.clients.iterate(companyId, { count: 200 })) {
  await save(client); // постранично, без накопления в памяти
}

const recent = await yc.clients.listAll(
  companyId,
  { changed_after: '2026-01-01' },
  { maxPages: 50 },
);
```

## Повторы и лимиты

| Ситуация | GET / PUT / DELETE | POST / PATCH |
| --- | --- | --- |
| HTTP 429 | повторяется | повторяется (запрос не был обработан) |
| HTTP 502, 503, 504 | повторяется | не повторяется (мог быть применён) |
| Сетевая ошибка или таймаут | повторяется | не повторяется |
| Прочие 4xx / 5xx | ошибка | ошибка |

Пауза: `min(maxDelayMs, max(Retry-After, экспоненциальная задержка с джиттером))`.

```ts
const yc = new YclientsClient({
  partnerToken,
  userToken,
  timeoutMs: 20_000, // на одну попытку, по умолчанию 30 000
  retry: {
    retries: 4, // по умолчанию 4; 0 отключает повторы
    minDelayMs: 1000, // по умолчанию 1000
    maxDelayMs: 30_000, // по умолчанию 30 000
    retryStatuses: [429, 502, 503, 504],
    retryNetworkErrors: true,
  },
  onRetry: ({ attempt, delayMs, status, path }) => {
    console.warn(`YCLIENTS ${path} → ${status ?? 'сеть'}, повтор №${attempt} через ${delayMs} мс`);
  },
});
```

Когда попытки закончились, `YclientsRateLimitError` содержит `retryAfterMs`, чтобы задачу можно было перенести.

## Ошибки

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
    // 429 после всех повторов; error.retryAfterMs
  } else if (error instanceof YclientsApiError) {
    // не 2xx или { success: false }; error.status, error.apiMessage, error.body
  } else if (error instanceof YclientsNetworkError) {
    // ответа нет; error.timedOut отличает таймаут от обрыва соединения
  } else if (error instanceof YclientsPaginationError) {
    // список не удалось прочитать целиком
  }
}
```

Все они наследуются от `YclientsError`.

## Переход с `api.yclients.com`

По умолчанию клиент обращается к `https://api.yclients.ru/api/v1`. Чтобы на время перехода остаться на старом адресе:

```ts
new YclientsClient({ partnerToken, baseUrl: 'https://api.yclients.com/api/v1' });
```

`marketplace.activate()` берёт домен из `baseUrl`, поэтому переключается вместе с ним.

## Разработка

```bash
npm install
npm test          # vitest, только подменённый fetch
npm run typecheck
npm run build     # собирает dist/ (ESM + .d.ts)
```

Будем рады помощи: новые эндпоинты, более точные типы ответов, баг-репорты с обезличенными данными. Никогда не публикуйте в issues настоящие токены, телефоны и данные клиентов.

## Лицензия

[MIT](./LICENSE)
