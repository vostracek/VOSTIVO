import { isProgressNotFound } from "./progress-api-client";

/** One server page, adapted: rows + the opaque cursor + whatever heads the screen (e.g. the exercise name). */
export interface HistoryPage<TItem, THeader> {
  readonly header: THeader;
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
}

export type PagedHistoryState<TItem, THeader> =
  | { readonly kind: "LOADING" }
  | {
      readonly kind: "READY";
      readonly header: THeader;
      readonly items: readonly TItem[];
      /** `null` = the end of history; Load more is not offered. */
      readonly nextCursor: string | null;
      readonly more: "IDLE" | "LOADING" | "ERROR";
    }
  /** 404 on the first page — unknown, foreign or non-visible history; never says which. */
  | { readonly kind: "NOT_AVAILABLE" }
  | { readonly kind: "ERROR_INITIAL" };

export interface PagedHistoryEffects<TItem, THeader> {
  onStateChange(state: PagedHistoryState<TItem, THeader>): void;
  logFailure(message: string): void;
}

/**
 * Progress & Feedback V1 — Slice B: a keyset-paged history list ("Load
 * more", no infinite scroll). The server cursor is passed back VERBATIM —
 * never decoded or built here. At most one request in flight: a repeated
 * Load more tap while loading is ignored, and a failed page keeps every
 * row already shown (`more: "ERROR"` → Retry asks for the same cursor).
 */
export class PagedHistoryController<TItem, THeader> {
  private state: PagedHistoryState<TItem, THeader> = { kind: "LOADING" };
  private inFlight = false;
  private disposed = false;

  constructor(
    private readonly fetchPage: (before: string | null) => Promise<HistoryPage<TItem, THeader>>,
    /** Stable row identity — a row already shown is never appended twice. */
    private readonly itemKey: (item: TItem) => string,
    private readonly effects: PagedHistoryEffects<TItem, THeader>,
  ) {}

  getState(): PagedHistoryState<TItem, THeader> {
    return this.state;
  }

  /** First page (and Retry after ERROR_INITIAL). */
  async load(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    this.setState({ kind: "LOADING" });
    try {
      const page = await this.fetchPage(null);
      if (this.disposed) return;
      this.setState({ kind: "READY", header: page.header, items: dedupe([], page.items, this.itemKey), nextCursor: page.nextCursor, more: "IDLE" });
    } catch (error: unknown) {
      if (this.disposed) return;
      if (isProgressNotFound(error)) {
        this.setState({ kind: "NOT_AVAILABLE" });
      } else {
        this.effects.logFailure(`progress history failed: ${error instanceof Error ? error.message : "unknown error"}`);
        this.setState({ kind: "ERROR_INITIAL" });
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** Next page (and Retry after a failed page). No-op without a cursor or while a request is in flight. */
  async loadMore(): Promise<void> {
    const state = this.state;
    if (this.inFlight || state.kind !== "READY" || state.nextCursor === null) return;
    this.inFlight = true;
    this.setState({ ...state, more: "LOADING" });
    try {
      const page = await this.fetchPage(state.nextCursor);
      if (this.disposed) return;
      this.setState({ ...state, items: dedupe(state.items, page.items, this.itemKey), nextCursor: page.nextCursor, more: "IDLE" });
    } catch (error: unknown) {
      if (this.disposed) return;
      this.effects.logFailure(`progress history page failed: ${error instanceof Error ? error.message : "unknown error"}`);
      this.setState({ ...state, more: "ERROR" });
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  private setState(state: PagedHistoryState<TItem, THeader>): void {
    this.state = state;
    if (!this.disposed) this.effects.onStateChange(state);
  }
}

function dedupe<TItem>(existing: readonly TItem[], incoming: readonly TItem[], key: (item: TItem) => string): TItem[] {
  const seen = new Set(existing.map(key));
  const result = [...existing];
  for (const item of incoming) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    result.push(item);
  }
  return result;
}
