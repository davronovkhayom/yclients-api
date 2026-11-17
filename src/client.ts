import {
  DEFAULT_RETRY,
  Transport,
  defaultSleep,
  type RequestOptions,
  type RetryEvent,
  type RetryOptions,
} from './http.js';
import { collect, paginate, type PaginateOptions } from './pagination.js';
import type {
  AnalyticsParams,
  Client,
  Company,
  FinanceTransaction,
  Good,
  Id,
  IsoDate,
  ListClientsParams,
  ListCompaniesParams,
  ListGoodsParams,
  ListRecordsParams,
  ListTransactionsParams,
  Page,
  QueryParams,
  ScheduleDay,
  Service,
  Staff,
  Storage,
  UserAuthResult,
  YclientsEnvelope,
  YclientsRecord,
} from './types.js';

/** YCLIENTS moved its API to the `.ru` domain; `.com` is the legacy host. */
export const DEFAULT_BASE_URL = 'https://api.yclients.ru/api/v1';

export interface YclientsClientOptions {
  /** Partner (developer) token issued by YCLIENTS. Required. */
  partnerToken: string;
  /** User token for company-scoped endpoints. Get one with `auth.getUserToken()`. */
  userToken?: string | undefined;
  /** API root. Default `https://api.yclients.ru/api/v1`. */
  baseUrl?: string;
  /** Custom fetch implementation (proxies, tests). Default: global `fetch`. */
  fetch?: typeof fetch;
  /** Per-attempt timeout in ms. Default `30000`. */
  timeoutMs?: number;
  /** Retry/backoff settings for 429, 5xx gateway errors and network failures. */
  retry?: RetryOptions;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** `User-Agent` to send (ignored by browsers). */
  userAgent?: string;
  /** Called before every retry wait, e.g. for logging. */
  onRetry?: (event: RetryEvent) => void;
  /** @internal Test hooks. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** @internal Test hooks. */
  random?: () => number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

type ListAllOptions = Omit<PaginateOptions, 'count'> & { signal?: AbortSignal };

const RECORDS_PAGE_SIZE = 200;
const CLIENTS_PAGE_SIZE = 200;
const TRANSACTIONS_PAGE_SIZE = 200;
const GOODS_PAGE_SIZE = 100;

function id(value: Id, name: string): string {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`${name} must be a numeric ID, got "${text}"`);
  return text;
}

function isoDate(value: IsoDate | Date, name: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${name} is an invalid Date`);
    return value.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${name} must be YYYY-MM-DD, got "${value}"`);
  return value;
}

function toPage<T>(envelope: YclientsEnvelope<T[] | unknown>, page: number, count: number): Page<T> {
  const data = Array.isArray(envelope.data) ? (envelope.data as T[]) : [];
  return { data, meta: envelope.meta ?? {}, page, count };
}

/**
 * Typed client for the YCLIENTS REST API.
 *
 * ```ts
 * const yc = new YclientsClient({ partnerToken, userToken });
 * const records = await yc.records.listAll(companyId, { start_date: '2026-01-01', end_date: '2026-01-31' });
 * ```
 */
export class YclientsClient {
  readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly clientOptions: YclientsClientOptions;

  constructor(options: YclientsClientOptions) {
    if (!options || typeof options.partnerToken !== 'string' || !options.partnerToken.trim()) {
      throw new TypeError('YclientsClient: partnerToken is required');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('YclientsClient: no fetch implementation available; pass options.fetch');
    }
    this.clientOptions = options;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.transport = new Transport({
      baseUrl: this.baseUrl,
      partnerToken: options.partnerToken.trim(),
      userToken: options.userToken?.trim() || undefined,
      fetch: fetchImpl,
      timeoutMs: options.timeoutMs ?? 30_000,
      retry: { ...DEFAULT_RETRY, ...options.retry },
      headers: options.headers ?? {},
      userAgent: options.userAgent,
      onRetry: options.onRetry,
      sleep: options.sleep ?? defaultSleep,
      random: options.random ?? Math.random,
    });
  }

  /** Return a new client that shares all settings but uses another user token. */
  withUserToken(userToken: string): YclientsClient {
    return new YclientsClient({ ...this.clientOptions, userToken });
  }

  /** Low-level escape hatch: call any endpoint and get the full envelope back. */
  request<T = unknown>(options: RequestOptions): Promise<YclientsEnvelope<T>> {
    return this.transport.request<T>(options);
  }

  private async getData<T>(path: string, query?: QueryParams, call?: CallOptions): Promise<T> {
    const envelope = await this.transport.request<T>({ path, query, signal: call?.signal });
    return envelope.data;
  }

  private async getPage<T>(path: string, query: QueryParams, page: number, count: number, signal?: AbortSignal): Promise<Page<T>> {
    const envelope = await this.transport.request<T[]>({ path, query: { ...query, page, count }, signal });
    return toPage<T>(envelope, page, count);
  }

  /* ---------------- auth ---------------- */

  readonly auth = {
    /**
     * Exchange a YCLIENTS user's login and password for a user token (`POST /auth`).
     * Store the token, not the password.
     */
    getUserToken: async (credentials: { login: string; password: string }, call?: CallOptions): Promise<UserAuthResult> => {
      const envelope = await this.transport.request<UserAuthResult>({
        method: 'POST',
        path: 'auth',
        body: { login: credentials.login, password: credentials.password },
        partnerOnly: true,
        signal: call?.signal,
      });
      return envelope.data;
    },
  };

  /* ---------------- companies ---------------- */

  readonly companies = {
    /** `GET /companies`. Pass `{ my: 1 }` to list only companies the user token can access. */
    list: async (params: ListCompaniesParams = {}, call?: CallOptions): Promise<Company[]> =>
      this.getData<Company[]>('companies', params, call).then((data) => (Array.isArray(data) ? data : [])),

    /** `GET /company/{company_id}`. */
    get: async (companyId: Id, call?: CallOptions): Promise<Company> =>
      this.getData<Company>(`company/${id(companyId, 'companyId')}`, undefined, call),
  };

  /* ---------------- staff ---------------- */

  readonly staff = {
    /** `GET /company/{company_id}/staff`. Includes fired/hidden staff; filter on `fired`/`hidden`/`is_deleted`. */
    list: async (companyId: Id, call?: CallOptions): Promise<Staff[]> =>
      this.getData<Staff[]>(`company/${id(companyId, 'companyId')}/staff`, undefined, call).then((data) =>
        Array.isArray(data) ? data : [],
      ),

    /** `GET /company/{company_id}/staff/{staff_id}`. */
    get: async (companyId: Id, staffId: Id, call?: CallOptions): Promise<Staff> =>
      this.getData<Staff>(`company/${id(companyId, 'companyId')}/staff/${id(staffId, 'staffId')}`, undefined, call),
  };

  /* ---------------- services ---------------- */

  readonly services = {
    /** `GET /services/{company_id}`. */
    list: async (companyId: Id, params: QueryParams = {}, call?: CallOptions): Promise<Service[]> =>
      this.getData<Service[] | { services?: Service[] }>(`services/${id(companyId, 'companyId')}`, params, call).then(
        (data) => (Array.isArray(data) ? data : Array.isArray(data?.services) ? data.services : []),
      ),
  };

  /* ---------------- records (bookings) ---------------- */

  readonly records = {
    /** One page of `GET /records/{company_id}`. */
    list: async (companyId: Id, params: ListRecordsParams = {}, call?: CallOptions): Promise<Page<YclientsRecord>> => {
      const { page = 1, count = RECORDS_PAGE_SIZE, ...query } = params;
      return this.getPage<YclientsRecord>(`records/${id(companyId, 'companyId')}`, query, Number(page), Number(count), call?.signal);
    },

    /** Iterate every record matching `params`, page by page. */
    iterate: (
      companyId: Id,
      params: Omit<ListRecordsParams, 'page'> = {},
      options: ListAllOptions = {},
    ): AsyncGenerator<YclientsRecord, void, undefined> => {
      const { count = RECORDS_PAGE_SIZE, ...query } = params;
      const path = `records/${id(companyId, 'companyId')}`;
      return paginate((page, size, signal) => this.getPage<YclientsRecord>(path, query, page, size, signal), Number(count), options);
    },

    /** Read every record matching `params` into an array. */
    listAll: async (
      companyId: Id,
      params: Omit<ListRecordsParams, 'page'> = {},
      options: ListAllOptions = {},
    ): Promise<YclientsRecord[]> => collect(this.records.iterate(companyId, params, options)),

    /** `GET /record/{company_id}/{record_id}`. */
    get: async (companyId: Id, recordId: Id, call?: CallOptions): Promise<YclientsRecord> =>
      this.getData<YclientsRecord>(`record/${id(companyId, 'companyId')}/${id(recordId, 'recordId')}`, undefined, call),
  };

  /* ---------------- clients ---------------- */

  readonly clients = {
    /** One page of `GET /clients/{company_id}`. */
    list: async (companyId: Id, params: ListClientsParams = {}, call?: CallOptions): Promise<Page<Client>> => {
      const { page = 1, count = CLIENTS_PAGE_SIZE, ...query } = params;
      return this.getPage<Client>(`clients/${id(companyId, 'companyId')}`, query, Number(page), Number(count), call?.signal);
    },

    /** Iterate every client matching `params`, page by page. */
    iterate: (
      companyId: Id,
      params: Omit<ListClientsParams, 'page'> = {},
      options: ListAllOptions = {},
    ): AsyncGenerator<Client, void, undefined> => {
      const { count = CLIENTS_PAGE_SIZE, ...query } = params;
      const path = `clients/${id(companyId, 'companyId')}`;
      return paginate((page, size, signal) => this.getPage<Client>(path, query, page, size, signal), Number(count), options);
    },

    /** Read every client matching `params` into an array. */
    listAll: async (
      companyId: Id,
      params: Omit<ListClientsParams, 'page'> = {},
      options: ListAllOptions = {},
    ): Promise<Client[]> => collect(this.clients.iterate(companyId, params, options)),

    /** `GET /client/{company_id}/{client_id}`. */
    get: async (companyId: Id, clientId: Id, call?: CallOptions): Promise<Client> =>
      this.getData<Client>(`client/${id(companyId, 'companyId')}/${id(clientId, 'clientId')}`, undefined, call),
  };

  /* ---------------- finance transactions ---------------- */

  readonly transactions = {
    /** One page of `GET /transactions/{company_id}`. */
    list: async (companyId: Id, params: ListTransactionsParams = {}, call?: CallOptions): Promise<Page<FinanceTransaction>> => {
      const { page = 1, count = TRANSACTIONS_PAGE_SIZE, ...query } = params;
      return this.getPage<FinanceTransaction>(`transactions/${id(companyId, 'companyId')}`, query, Number(page), Number(count), call?.signal);
    },

    iterate: (
      companyId: Id,
      params: Omit<ListTransactionsParams, 'page'> = {},
      options: ListAllOptions = {},
    ): AsyncGenerator<FinanceTransaction, void, undefined> => {
      const { count = TRANSACTIONS_PAGE_SIZE, ...query } = params;
      const path = `transactions/${id(companyId, 'companyId')}`;
      return paginate((page, size, signal) => this.getPage<FinanceTransaction>(path, query, page, size, signal), Number(count), options);
    },

    listAll: async (
      companyId: Id,
      params: Omit<ListTransactionsParams, 'page'> = {},
      options: ListAllOptions = {},
    ): Promise<FinanceTransaction[]> => collect(this.transactions.iterate(companyId, params, options)),
  };

  /* ---------------- schedule ---------------- */

  readonly schedule = {
    /** `GET /schedule/{company_id}/{staff_id}/{start_date}/{end_date}`. */
    get: async (
      companyId: Id,
      staffId: Id,
      startDate: IsoDate | Date,
      endDate: IsoDate | Date,
      call?: CallOptions,
    ): Promise<ScheduleDay[]> =>
      this.getData<ScheduleDay[]>(
        `schedule/${id(companyId, 'companyId')}/${id(staffId, 'staffId')}/${isoDate(startDate, 'startDate')}/${isoDate(endDate, 'endDate')}`,
        undefined,
        call,
      ).then((data) => (Array.isArray(data) ? data : [])),
  };

  /* ---------------- goods & storages ---------------- */

  readonly goods = {
    /** One page of `GET /goods/{company_id}`. */
    list: async (companyId: Id, params: ListGoodsParams = {}, call?: CallOptions): Promise<Page<Good>> => {
      const { page = 1, count = GOODS_PAGE_SIZE, ...query } = params;
      return this.getPage<Good>(`goods/${id(companyId, 'companyId')}`, query, Number(page), Number(count), call?.signal);
    },

    iterate: (
      companyId: Id,
      params: Omit<ListGoodsParams, 'page'> = {},
      options: ListAllOptions = {},
    ): AsyncGenerator<Good, void, undefined> => {
      const { count = GOODS_PAGE_SIZE, ...query } = params;
      const path = `goods/${id(companyId, 'companyId')}`;
      return paginate((page, size, signal) => this.getPage<Good>(path, query, page, size, signal), Number(count), options);
    },

    listAll: async (
      companyId: Id,
      params: Omit<ListGoodsParams, 'page'> = {},
      options: ListAllOptions = {},
    ): Promise<Good[]> => collect(this.goods.iterate(companyId, params, options)),
  };

  readonly storages = {
    /** `GET /storages/{company_id}`. */
    list: async (companyId: Id, call?: CallOptions): Promise<Storage[]> =>
      this.getData<Storage[]>(`storages/${id(companyId, 'companyId')}`, undefined, call).then((data) =>
        Array.isArray(data) ? data : [],
      ),
  };

  /* ---------------- analytics ---------------- */

  readonly analytics = {
    /** `GET /company/{company_id}/analytics/overall`: revenue, visits and occupancy summary. */
    overall: async (companyId: Id, params: AnalyticsParams, call?: CallOptions): Promise<Record<string, unknown>> =>
      this.getData<Record<string, unknown>>(
        `company/${id(companyId, 'companyId')}/analytics/overall`,
        { ...params, date_from: isoDate(params.date_from, 'date_from'), date_to: isoDate(params.date_to, 'date_to') },
        call,
      ),
  };

  /* ---------------- marketplace ---------------- */

  readonly marketplace = {
    /**
     * Confirm that a salon has connected your Marketplace application
     * (`POST {origin}/marketplace/partner/callback`). Uses the partner token only.
     */
    activate: async (
      input: { salonId: Id; applicationId: Id; [key: string]: unknown },
      call?: CallOptions,
    ): Promise<unknown> => {
      const { salonId, applicationId, ...extra } = input;
      const origin = new URL(this.baseUrl).origin;
      const envelope = await this.transport.request<unknown>({
        method: 'POST',
        path: `${origin}/marketplace/partner/callback`,
        body: { ...extra, salon_id: Number(id(salonId, 'salonId')), application_id: Number(id(applicationId, 'applicationId')) },
        partnerOnly: true,
        signal: call?.signal,
      });
      return envelope.data;
    },
  };
}
