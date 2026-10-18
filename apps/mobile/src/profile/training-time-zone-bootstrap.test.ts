import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { MeResponse } from "@vostivo/contracts";
import { TrainingTimeZoneBootstrapper, bootstrapTrainingTimeZone, isUsableIanaTimeZone, type TrainingTimeZoneBootstrapPorts } from "./training-time-zone-bootstrap";

const ME: MeResponse = {
  userId: "11111111-1111-7111-8111-111111111111",
  athleteProfileId: "22222222-2222-7222-8222-222222222222",
  status: "ACTIVE",
  experienceMode: "GUIDED",
  unitSystem: "METRIC",
  trainingTimeZone: null,
};

function fakePorts(options: { stored?: string | null; device?: string | null; failGet?: boolean; failPut?: boolean } = {}) {
  let stored = options.stored ?? null;
  const calls = { getMe: 0, puts: [] as string[], logs: [] as string[] };
  const ports: TrainingTimeZoneBootstrapPorts = {
    getMe: () => {
      calls.getMe += 1;
      return options.failGet === true ? Promise.reject(new TypeError("Network request failed")) : Promise.resolve({ ...ME, trainingTimeZone: stored });
    },
    setTrainingTimeZone: (zone) => {
      calls.puts.push(zone);
      if (options.failPut === true) return Promise.reject(new Error("Me API request failed: 500"));
      stored = zone;
      return Promise.resolve({ ...ME, trainingTimeZone: zone });
    },
    deviceTimeZone: () => (options.device === undefined ? "Europe/Prague" : options.device),
    logFailure: (message) => calls.logs.push(message),
  };
  return { ports, calls };
}

describe("training time zone bootstrap", () => {
  it("19/26: NULL profile zone + a valid device IANA zone -> exactly one PUT, then /me is refreshed", async () => {
    const { ports, calls } = fakePorts({ device: "Europe/Prague" });
    expect(await bootstrapTrainingTimeZone(ports)).toEqual({ kind: "SET", trainingTimeZone: "Europe/Prague" });
    expect(calls.puts).toEqual(["Europe/Prague"]);
    expect(calls.getMe).toBe(2);
  });

  it("20: an existing zone -> no PUT", async () => {
    const { ports, calls } = fakePorts({ stored: "Europe/Prague", device: "Europe/Prague" });
    expect(await bootstrapTrainingTimeZone(ports)).toEqual({ kind: "ALREADY_SET", trainingTimeZone: "Europe/Prague" });
    expect(calls.puts).toEqual([]);
  });

  it("21: a later, different device zone (travel) never overwrites the saved training zone", async () => {
    const { ports, calls } = fakePorts({ stored: "Europe/Prague", device: "America/New_York" });
    expect(await bootstrapTrainingTimeZone(ports)).toEqual({ kind: "ALREADY_SET", trainingTimeZone: "Europe/Prague" });
    expect(calls.puts).toEqual([]);
  });

  it.each(["+02:00", "-05:00", "GMT+2", "UTC+01:00", "Etc/GMT-2", "", "Europe Prague", "prague"])("22: an offset / unusable device zone %j is never sent", async (device) => {
    const { ports, calls } = fakePorts({ device });
    expect(await bootstrapTrainingTimeZone(ports)).toEqual({ kind: "DEVICE_ZONE_UNUSABLE" });
    expect(calls.puts).toEqual([]);
  });

  it("isUsableIanaTimeZone accepts real IANA ids, including UTC", () => {
    for (const zone of ["Europe/Prague", "America/New_York", "America/Port-au-Prince", "America/Argentina/Buenos_Aires", "UTC", "Etc/UTC"]) expect(isUsableIanaTimeZone(zone)).toBe(true);
    expect(isUsableIanaTimeZone(null)).toBe(false);
  });

  it("23: no location permission and no geolocation — the only zone input is the device's Intl zone port", () => {
    const source = readFileSync(new URL("./training-time-zone-bootstrap.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']expo-location["']|navigator\.geolocation|requestForegroundPermissionsAsync|PermissionsAndroid/);
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain("expo-location");
  });

  it("24: a network failure is reported as FAILED (logged), never thrown — Today keeps rendering", async () => {
    const { ports, calls } = fakePorts({ failGet: true });
    expect(await bootstrapTrainingTimeZone(ports)).toEqual({ kind: "FAILED" });
    expect(calls.logs).toHaveLength(1);
    const failedPut = fakePorts({ failPut: true });
    expect(await bootstrapTrainingTimeZone(failedPut.ports)).toEqual({ kind: "FAILED" });
  });

  it("runs at most once per process (concurrent callers share it; completed is never redone); a FAILED run may be retried explicitly", async () => {
    const { ports, calls } = fakePorts({ device: "Europe/Prague" });
    const bootstrapper = new TrainingTimeZoneBootstrapper(ports);
    const [first, second] = await Promise.all([bootstrapper.ensure(), bootstrapper.ensure()]);
    expect(first).toEqual(second);
    await bootstrapper.ensure();
    expect(calls.puts).toEqual(["Europe/Prague"]);
    expect(calls.getMe).toBe(2);

    const failing = fakePorts({ failGet: true });
    const retryable = new TrainingTimeZoneBootstrapper(failing.ports);
    expect((await retryable.ensure()).kind).toBe("FAILED");
    expect((await retryable.retry()).kind).toBe("FAILED");
    expect(failing.calls.getMe).toBe(2);
  });
});
