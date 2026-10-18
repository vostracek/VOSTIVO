import type { MeResponse } from "@vostivo/contracts";

/**
 * Missed Workout / Schedule Adaptation V1 — Slice D: the ONE-TIME training
 * time zone bootstrap. The athlete's training time zone is explicit
 * scheduling context that is SET ONCE, NOT TRACKED: only when the server
 * profile has none (`MeResponse.trainingTimeZone === null`) is the device's
 * current IANA zone sent — once — and never again on later launches, even
 * if the device zone later differs (travel never moves the training day).
 * No IP/geolocation, no location permission: the only input is the
 * device's own IANA zone id, and a numeric offset is never sent.
 */
export interface TrainingTimeZoneBootstrapPorts {
  getMe(): Promise<MeResponse>;
  setTrainingTimeZone(trainingTimeZone: string): Promise<MeResponse>;
  /** The device's current zone id as the runtime reports it (`Intl`), or `null` when unavailable. */
  deviceTimeZone(): string | null;
  /** Technical failures only (never tokens, never profile data). */
  logFailure(message: string): void;
}

export type TrainingTimeZoneBootstrapOutcome =
  /** The profile already has a zone — never overwritten. */
  | { readonly kind: "ALREADY_SET"; readonly trainingTimeZone: string }
  | { readonly kind: "SET"; readonly trainingTimeZone: string }
  /** The device reported nothing usable (empty, an offset, an offset-style Etc zone) — nothing was sent. */
  | { readonly kind: "DEVICE_ZONE_UNUSABLE" }
  | { readonly kind: "FAILED" };

/**
 * A usable IANA id: `Area/Location[/Sub]` (letters, digits, `_`, `-`, `+`
 * inside location names, e.g. `America/Port-au-Prince`) or exactly `UTC` /
 * `Etc/UTC`. Rejects numeric offsets (`+02:00`, `GMT+2`, `UTC+01:00`) and
 * the offset-only `Etc/GMT±N` zones. The server re-validates against the
 * real IANA database (`Intl`) — this is a cheap client-side guard so an
 * offset is never even sent.
 */
export function isUsableIanaTimeZone(value: string | null | undefined): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  if (value === "UTC" || value === "Etc/UTC") return true;
  if (/^Etc\//.test(value)) return false;
  return /^[A-Za-z]+(?:\/[A-Za-z0-9_\-+]+)+$/.test(value) && !/(^|\/)(GMT|UTC)[+-]/.test(value);
}

/** The device zone via the JS runtime's own Intl (Hermes) — no native module, no permission. */
export function readDeviceTimeZone(): string | null {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.length > 0 ? zone : null;
  } catch {
    return null;
  }
}

export async function bootstrapTrainingTimeZone(ports: TrainingTimeZoneBootstrapPorts): Promise<TrainingTimeZoneBootstrapOutcome> {
  try {
    const me = await ports.getMe();
    if (me.trainingTimeZone !== null) return { kind: "ALREADY_SET", trainingTimeZone: me.trainingTimeZone };
    const deviceZone = ports.deviceTimeZone();
    if (!isUsableIanaTimeZone(deviceZone)) {
      ports.logFailure("training time zone bootstrap: device time zone is not a usable IANA id");
      return { kind: "DEVICE_ZONE_UNUSABLE" };
    }
    await ports.setTrainingTimeZone(deviceZone);
    // Refresh /me so what we report is what the server actually stored (its canonical id).
    const refreshed = await ports.getMe();
    if (refreshed.trainingTimeZone === null) {
      ports.logFailure("training time zone bootstrap: profile still has no time zone after PUT");
      return { kind: "FAILED" };
    }
    return { kind: "SET", trainingTimeZone: refreshed.trainingTimeZone };
  } catch (error: unknown) {
    ports.logFailure(`training time zone bootstrap failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { kind: "FAILED" };
  }
}

/**
 * At most ONE bootstrap per app process: concurrent callers share the
 * in-flight run, and once it completed (any outcome but FAILED) it is
 * marked done and never re-run. A FAILED run may be retried explicitly
 * (`retry`) — e.g. the "Try again" action — never in a loop.
 */
export class TrainingTimeZoneBootstrapper {
  private inFlight: Promise<TrainingTimeZoneBootstrapOutcome> | null = null;
  private completed: TrainingTimeZoneBootstrapOutcome | null = null;

  constructor(private readonly ports: TrainingTimeZoneBootstrapPorts) {}

  ensure(): Promise<TrainingTimeZoneBootstrapOutcome> {
    if (this.completed !== null) return Promise.resolve(this.completed);
    this.inFlight ??= bootstrapTrainingTimeZone(this.ports).then((outcome) => {
      this.inFlight = null;
      if (outcome.kind !== "FAILED") this.completed = outcome;
      return outcome;
    });
    return this.inFlight;
  }

  /** Explicit retry after a failure (never automatic). A completed bootstrap is never redone. */
  retry(): Promise<TrainingTimeZoneBootstrapOutcome> {
    return this.ensure();
  }
}
