import type { ProgressionApplicationCommandResponseV1 } from "@vostivo/contracts";

/**
 * Progression Application V1 — Slice E — pure, framework-free mapping
 * from the server's own closed vocabularies (Slice D/C's
 * `ApplyRejectionReason`, and the HTTP error envelope's `message` for the
 * two 409 cases) to the small set of athlete-safe UI states this screen
 * renders (task §20). Never a raw machine code reaches copy — every
 * caller renders off `.kind`, never off a `reason`/`message` string
 * directly.
 */

export type ProgressionCommandUiOutcome =
  | { readonly kind: "applied" }
  | { readonly kind: "kept-original" }
  /** `PROPOSAL_REFRESH_REQUIRED` (task §12/§20) — the ONLY reason that keeps the review open and re-fetches, rather than a terminal "can't be applied." */
  | { readonly kind: "refresh-required" }
  /** Every other closed-vocabulary rejection reason (STALE, SUPERSEDED, LOADING_CAPABILITY_UNAVAILABLE, LOADING_CAPABILITY_INVALID, CAPABILITY_INCOMPATIBLE, CURRENT_LOAD_UNSUPPORTED, NO_SUITABLE_INCREMENT, NO_CURRENT_LOAD, ...) — task §20's single concise "This change can't be applied right now." */
  | { readonly kind: "unavailable" };

export function mapCommandResponseToUiOutcome(response: ProgressionApplicationCommandResponseV1): ProgressionCommandUiOutcome {
  if (response.status === "APPLIED") return { kind: "applied" };
  if (response.status === "KEPT_ORIGINAL") return { kind: "kept-original" };
  if (response.reason === "PROPOSAL_REFRESH_REQUIRED") return { kind: "refresh-required" };
  return { kind: "unavailable" };
}

export type ProgressionHttpErrorUiOutcome =
  /** The application disappeared / is no longer owned by this actor (task §20's `NOT_FOUND` — close + refresh). */
  | { readonly kind: "not-found" }
  /** Current mode authority changed since the review was opened (task §20's `MODE_ACTION_NOT_ALLOWED` — close controls + refresh). */
  | { readonly kind: "mode-changed" }
  /** Anything else — a genuine transient/infrastructure failure, or the (should-not-normally-happen) `COMMAND_CONFLICT` — review stays open, Retry is offered (task §30). */
  | { readonly kind: "transient"; readonly message: string };

export function mapHttpErrorToUiOutcome(status: number, message: string): ProgressionHttpErrorUiOutcome {
  if (status === 404) return { kind: "not-found" };
  if (status === 409 && message === "MODE_ACTION_NOT_ALLOWED") return { kind: "mode-changed" };
  return { kind: "transient", message };
}
