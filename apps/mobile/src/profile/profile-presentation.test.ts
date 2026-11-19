import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MeResponse } from "@vostivo/contracts";
import { accountLine, profileIdentity, trainingRows } from "./profile-presentation";

const me: MeResponse = { userId: "u", athleteProfileId: "a", status: "ACTIVE", experienceMode: "GUIDED", unitSystem: "METRIC", trainingTimeZone: "Europe/Prague" };
const plan = { currentBlock: { trainingBlockId: "b", name: "Hypertrophy Block 1", goal: "Hypertrophy — Upper/Lower", currentCycleOrder: 4, cycleCount: 6, daysPerWeek: 4 } };

describe("Profile V1 presentation", () => {
  it("PROF-001: identity is the real block goal + mode + days per week — never an invented name", () => {
    expect(profileIdentity(me, plan)).toEqual({ title: "Hypertrophy — Upper/Lower", meta: "Guided · 4 days / week" });
    expect(profileIdentity(null, { currentBlock: null })).toEqual({ title: "No active plan", meta: null });
    expect(profileIdentity(null, null)).toEqual({ title: "Your training", meta: null });
  });

  it("PROF-002: training rows are exactly the /me + plan facts, with an honest unset time zone", () => {
    expect(trainingRows(me, plan)[0]).toEqual({ key: "block", title: "Current block", description: "Hypertrophy Block 1", value: "Week 4 / 6" });
    expect(trainingRows(me, plan).map((row) => [row.title, row.value])).toEqual([
      ["Current block", "Week 4 / 6"],
      ["Experience mode", "Guided"],
      ["Units", "Metric · kg"],
      ["Training time zone", "Europe/Prague"],
    ]);
    expect(trainingRows({ ...me, trainingTimeZone: null }, null).at(-1)?.value).toBe("Not set yet");
  });

  it("PROF-003: the account line never shows a token; dev builds say so plainly", () => {
    expect(accountLine("EMAIL_OTP", "athlete@example.com")).toEqual({ title: "Account", description: "athlete@example.com" });
    expect(accountLine("DEV_TOKEN", null).title).toBe("Developer sign-in");
  });

  it("PROF-004: the Profile screen renders no fake coaching / subscription / notification / equipment / integration controls", () => {
    const source = readFileSync(new URL("../../app/profile/index.tsx", import.meta.url), "utf8");
    for (const forbidden of [/Vostivo Pro\b/, /Coaching/, /Notifications/, /Integrations/, /Gyms & Equipment/, /Subscription/, /Restrictions/]) {
      expect(source).not.toMatch(forbidden);
    }
    expect(source).toContain('<BottomNav active="profile" />');
  });
});
