import { isProgressNotFound } from "./progress-api-client";

/**
 * One server read (the Progress overview, or one workout's detail). A
 * refetch never blanks what is already shown: a failed refresh keeps the
 * last READY data (no flash of an error over real history).
 */
export type ProgressReadState<T> =
  | { readonly kind: "LOADING" }
  | { readonly kind: "READY"; readonly data: T }
  /** 404 — unknown, foreign or non-visible; the UI never says which. */
  | { readonly kind: "NOT_AVAILABLE" }
  | { readonly kind: "ERROR" };

export interface ProgressReadEffects<T> {
  onStateChange(state: ProgressReadState<T>): void;
  /** Technical failures only (never tokens or training data). */
  logFailure(message: string): void;
}

/**
 * Progress & Feedback V1 — Slice B: framework-free read logic (screens only
 * render `state` and forward taps), same architecture as the Today flows.
 * Overlapping loads resolve last-call-wins via a generation counter.
 */
export class ProgressReadController<T> {
  private state: ProgressReadState<T> = { kind: "LOADING" };
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly read: () => Promise<T>,
    private readonly effects: ProgressReadEffects<T>,
  ) {}

  getState(): ProgressReadState<T> {
    return this.state;
  }

  /** Initial load, focus refetch and Retry. Keeps READY data visible meanwhile. */
  async load(): Promise<void> {
    const generation = ++this.generation;
    if (this.state.kind !== "READY") this.setState({ kind: "LOADING" });
    try {
      const data = await this.read();
      if (generation !== this.generation || this.disposed) return;
      this.setState({ kind: "READY", data });
    } catch (error: unknown) {
      if (generation !== this.generation || this.disposed) return;
      if (isProgressNotFound(error)) {
        this.setState({ kind: "NOT_AVAILABLE" });
        return;
      }
      this.effects.logFailure(`progress read failed: ${error instanceof Error ? error.message : "unknown error"}`);
      if (this.state.kind !== "READY") this.setState({ kind: "ERROR" });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
  }

  private setState(state: ProgressReadState<T>): void {
    this.state = state;
    if (!this.disposed) this.effects.onStateChange(state);
  }
}
