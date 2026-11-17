import { YclientsPaginationError } from './errors.js';
import type { Page } from './types.js';

export interface PaginateOptions {
  /** Items per page. */
  count?: number;
  /** First page to read (1-based). Default `1`. */
  startPage?: number;
  /**
   * Safety limit. When it is reached before the list ends, a
   * `YclientsPaginationError` is thrown instead of returning a truncated list.
   * Default `1000`.
   */
  maxPages?: number;
  signal?: AbortSignal | undefined;
}

export type PageFetcher<T> = (page: number, count: number, signal?: AbortSignal) => Promise<Page<T>>;

/**
 * Walk a page-numbered YCLIENTS list until it provably ends:
 *  - an empty page, or
 *  - a page shorter than `count`, or
 *  - the number of items read reaches `meta.total_count`.
 *
 * Throws `YclientsPaginationError` if `maxPages` is hit first or if the server
 * returns the same non-empty page twice in a row (a stalled cursor).
 */
export async function* paginate<T>(
  fetchPage: PageFetcher<T>,
  defaultCount: number,
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  const count = options.count ?? defaultCount;
  if (!Number.isInteger(count) || count <= 0) throw new RangeError('count must be a positive integer');
  const startPage = options.startPage ?? 1;
  const maxPages = options.maxPages ?? 1000;

  let itemsRead = 0;
  let pagesRead = 0;
  let previousFingerprint: string | undefined;

  for (let page = startPage; ; page += 1) {
    if (pagesRead >= maxPages) {
      throw new YclientsPaginationError(
        `Stopped after ${pagesRead} pages without reaching the end of the list (maxPages=${maxPages})`,
        { pagesRead, itemsRead },
      );
    }
    options.signal?.throwIfAborted();
    const result = await fetchPage(page, count, options.signal);
    pagesRead += 1;
    const items = result.data;

    if (items.length > 0) {
      const fingerprint = JSON.stringify(items);
      if (fingerprint === previousFingerprint) {
        throw new YclientsPaginationError(
          `Page ${page} repeated the previous page; the list cannot be read completely`,
          { pagesRead, itemsRead },
        );
      }
      previousFingerprint = fingerprint;
    }

    for (const item of items) {
      itemsRead += 1;
      yield item;
    }

    const total = result.meta.total_count;
    if (items.length === 0) return;
    if (items.length < count) return;
    if (typeof total === 'number' && Number.isFinite(total) && itemsRead + (startPage - 1) * count >= total) return;
  }
}

/** Collect every item of an async iterable into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
