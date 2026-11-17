/**
 * Entity shapes returned by the YCLIENTS REST API.
 *
 * YCLIENTS returns many more fields than are listed here and adds new ones over time,
 * so every entity keeps an index signature: listed fields are typed, the rest stay
 * reachable as `unknown`. Fields are optional unless the API reliably sends them.
 */

/** Calendar date in `YYYY-MM-DD` format, as YCLIENTS expects in query parameters. */
export type IsoDate = string;

/** Numeric IDs are sent as numbers by YCLIENTS; the client also accepts numeric strings. */
export type Id = number | string;

/** Standard YCLIENTS response envelope. */
export interface YclientsEnvelope<T> {
  success: boolean;
  data: T;
  meta?: YclientsMeta;
  [key: string]: unknown;
}

export interface YclientsMeta {
  /** Total number of items matching a list request, when the endpoint reports it. */
  total_count?: number;
  message?: string;
  [key: string]: unknown;
}

/** One page of a list endpoint. */
export interface Page<T> {
  data: T[];
  meta: YclientsMeta;
  page: number;
  count: number;
}

export interface Company {
  id: number;
  title: string;
  public_title?: string;
  short_descr?: string;
  country_id?: number;
  city_id?: number;
  city?: string;
  timezone?: number;
  timezone_name?: string;
  address?: string;
  coordinate_lat?: number;
  coordinate_lon?: number;
  phone?: string;
  phones?: string[];
  site?: string;
  currency_short_title?: string;
  main_group_id?: number;
  active?: number;
  [key: string]: unknown;
}

export interface StaffPosition {
  id: number;
  title: string;
  [key: string]: unknown;
}

export interface Staff {
  id: number;
  name: string;
  specialization?: string;
  position?: StaffPosition | [] | null;
  avatar?: string;
  avatar_big?: string;
  rating?: number;
  votes_count?: number;
  bookable?: boolean;
  fired?: number;
  hidden?: number;
  status?: number;
  is_deleted?: boolean;
  user_id?: number | null;
  weight?: number;
  [key: string]: unknown;
}

export interface Service {
  id: number;
  title: string;
  category_id?: number;
  price_min?: number;
  price_max?: number;
  discount?: number;
  comment?: string;
  weight?: number;
  active?: number | boolean;
  /** Duration in seconds. */
  duration?: number;
  staff?: Array<{ id: number; seance_length?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface RecordService {
  id: number;
  title: string;
  cost?: number;
  cost_to_pay?: number;
  manual_cost?: number;
  first_cost?: number;
  discount?: number;
  amount?: number;
  [key: string]: unknown;
}

export interface RecordClient {
  id: number;
  name?: string;
  surname?: string;
  patronymic?: string;
  display_name?: string;
  phone?: string;
  email?: string;
  [key: string]: unknown;
}

/**
 * A booking ("запись").
 * `attendance` / `visit_attendance`: 2 = client confirmed, 1 = client came,
 * 0 = waiting, -1 = client did not come.
 */
export interface YclientsRecord {
  id: number;
  company_id: number;
  staff_id: number;
  services?: RecordService[];
  staff?: Partial<Staff>;
  client?: RecordClient | null;
  /** Local date-time of the visit, e.g. `2026-05-01 14:00:00`. */
  date?: string;
  datetime?: string;
  create_date?: string;
  last_change_date?: string;
  comment?: string;
  /** Visit length in seconds. */
  seance_length?: number;
  length?: number;
  attendance?: number;
  visit_attendance?: number;
  confirmed?: number;
  online?: boolean;
  visit_id?: number;
  deleted?: boolean;
  paid_full?: number;
  [key: string]: unknown;
}

export interface Client {
  id: number;
  name?: string;
  surname?: string;
  patronymic?: string;
  display_name?: string;
  phone?: string;
  email?: string;
  sex_id?: number;
  sex?: string;
  birth_date?: string;
  discount?: number;
  card?: string;
  comment?: string;
  categories?: Array<{ id: number; title: string; [key: string]: unknown }>;
  visits_count?: number;
  sold_amount?: number;
  paid?: number;
  spent?: number;
  balance?: number;
  last_change_date?: string;
  custom_fields?: Record<string, unknown> | unknown[];
  [key: string]: unknown;
}

export interface FinanceTransaction {
  id: number;
  document_id?: number;
  date?: string;
  type_id?: number;
  expense_id?: number;
  account_id?: number;
  amount?: number;
  client_id?: number;
  master_id?: number;
  supplier_id?: number;
  comment?: string;
  record_id?: number;
  visit_id?: number;
  sold_item_id?: number;
  sold_item_type?: string;
  deleted?: boolean;
  [key: string]: unknown;
}

export interface Good {
  good_id: number;
  title: string;
  value?: string;
  label?: string;
  article?: string;
  category?: string;
  category_id?: number;
  cost?: number;
  actual_cost?: number;
  unit_id?: number;
  barcode?: string;
  [key: string]: unknown;
}

export interface Storage {
  id: number;
  title: string;
  for_services?: number;
  for_sale?: number;
  [key: string]: unknown;
}

/** One working day in a staff schedule. */
export interface ScheduleDay {
  date: IsoDate;
  is_working?: boolean | number;
  slots?: Array<{ from: string; to: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Response of `POST /auth`. */
export interface UserAuthResult {
  id?: number;
  user_token: string;
  name?: string;
  phone?: string;
  login?: string;
  email?: string;
  [key: string]: unknown;
}

/* ---------- Query parameter shapes ---------- */

export interface PaginationParams {
  /** 1-based page number. */
  page?: number | undefined;
  /** Items per page. YCLIENTS caps this per endpoint (commonly 200–1000). */
  count?: number | undefined;
}

export interface ListRecordsParams extends PaginationParams {
  start_date?: IsoDate | undefined;
  end_date?: IsoDate | undefined;
  staff_id?: Id | undefined;
  client_id?: Id | undefined;
  /** Only records changed after this moment (`YYYY-MM-DD` or `YYYY-MM-DD HH:mm:ss`). */
  changed_after?: string | undefined;
  changed_before?: string | undefined;
  c_start_date?: IsoDate | undefined;
  c_end_date?: IsoDate | undefined;
  /** `1` to include deleted records. */
  with_deleted?: 0 | 1 | undefined;
  [key: string]: QueryValue;
}

export interface ListClientsParams extends PaginationParams {
  /** Phone number filter (digits). */
  phone?: string | undefined;
  fullname?: string | undefined;
  email?: string | undefined;
  changed_after?: string | undefined;
  [key: string]: QueryValue;
}

export interface ListTransactionsParams extends PaginationParams {
  start_date?: IsoDate | undefined;
  end_date?: IsoDate | undefined;
  master_id?: Id | undefined;
  client_id?: Id | undefined;
  account_id?: Id | undefined;
  type?: number | undefined;
  real_money?: 0 | 1 | undefined;
  deleted?: 0 | 1 | undefined;
  [key: string]: QueryValue;
}

export interface ListCompaniesParams {
  /** `1` returns only companies the user token has access to. */
  my?: 0 | 1 | undefined;
  group_id?: Id | undefined;
  active?: 0 | 1 | undefined;
  city_id?: Id | undefined;
  [key: string]: QueryValue;
}

export interface ListGoodsParams extends PaginationParams {
  term?: string | undefined;
  category_id?: Id | undefined;
  [key: string]: QueryValue;
}

export interface AnalyticsParams {
  date_from: IsoDate;
  date_to: IsoDate;
  staff_id?: Id | undefined;
  user_id?: Id | undefined;
  [key: string]: QueryValue;
}

export type QueryScalar = string | number | boolean;
export type QueryValue = QueryScalar | readonly QueryScalar[] | null | undefined;
export type QueryParams = Record<string, QueryValue>;
