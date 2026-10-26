import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Auth & Local Athlete Boundary V1 Slice B — "no hidden path around the
 * IdentityGate" (AUTH-LOCAL-007), checked structurally over the real source:
 * nothing can open a local database, build a runtime or start sync outside
 * the gate's READY state.
 */
const MOBILE_ROOT = new URL("../../", import.meta.url);

function sourceFiles(relativeDirectory: string): { readonly path: string; readonly text: string }[] {
  const directory = new URL(relativeDirectory, MOBILE_ROOT);
  const files: { path: string; text: string }[] = [];
  for (const entry of readdirSync(directory)) {
    const relative = `${relativeDirectory}${entry}`;
    if (/\.tsx?$/.test(entry)) {
      if (!/\.test\.tsx?$|\.d\.ts$/.test(entry) && !relative.includes("/testing/")) files.push({ path: relative, text: readFileSync(new URL(relative, MOBILE_ROOT), "utf8") });
    } else if (!entry.includes(".")) {
      files.push(...sourceFiles(`${relative}/`));
    }
  }
  return files;
}

const APP_SOURCES = [...sourceFiles("app/"), ...sourceFiles("src/")];

function filesMatching(pattern: RegExp): string[] {
  return APP_SOURCES.filter((file) => pattern.test(file.text)).map((file) => file.path);
}

describe("no hidden path around the IdentityGate", () => {
  it("the whole screen Stack is rendered inside <IdentityGate>", () => {
    const layout = readFileSync(new URL("app/_layout.tsx", MOBILE_ROOT), "utf8");
    expect(layout).toMatch(/<IdentityGate>\s*<Stack[^>]*\/>\s*<\/IdentityGate>/);
    expect(layout).not.toMatch(/startOutboxSyncRecovery|plan-runtime|local-database/);
  });

  it("only the native client opens SQLite, and only the IdentityGate opens an athlete database", () => {
    expect(filesMatching(/from "expo-sqlite"/)).toEqual(["src/local-database/client.ts"]);
    expect(filesMatching(/local-database\/client"/)).toEqual(["src/identity/identity-gate.tsx"]);
  });

  it("only the runtime opener builds a runtime, and only the IdentityGate starts sync triggers", () => {
    expect(filesMatching(/createAthleteRuntime\(\{/)).toEqual(["src/identity/athlete-runtime-opener.ts"]);
    expect(filesMatching(/startOutboxSyncRecovery\(/).sort()).toEqual(["src/identity/identity-gate.tsx", "src/infrastructure/sync-recovery.ts"]);
  });

  it("screens reach services only through useAthleteRuntime() — no module-level runtime singletons remain", () => {
    expect(filesMatching(/\bget(WorkoutApplicationService|WorkoutSyncCoordinator|PlanApplicationService|ProgressApiClient|ProgressionApiClient)\(/)).toEqual([]);
    expect(filesMatching(/^let cached/m)).toEqual([]);
  });

  it("AUTH-LOCAL-011: the legacy vostivo.db and its device key are named only by the quarantine constants", () => {
    expect(filesMatching(/"vostivo\.db"/)).toEqual(["src/local-database/athlete-database.ts"]);
    expect(filesMatching(/"vostivo\.local-db-encryption-key"/)).toEqual(["src/local-database/athlete-database.ts"]);
  });

  it("Auth Slice C: Supabase is the identity provider only — one client, auth only, no data access, no plaintext session storage", () => {
    expect(filesMatching(/\bcreateClient\(/)).toEqual(["src/auth/supabase-auth-client.ts"]);
    expect(filesMatching(/from "@supabase\//).every((path) => path.startsWith("src/auth/"))).toBe(true);
    // The Data API is disabled; athlete data goes only through the Vostivo API.
    expect(filesMatching(/\.(from|rpc|channel)\(\s*["'`]|\.storage\.from\(|\.functions\.invoke\(/)).toEqual([]);
    expect(filesMatching(/from "@react-native-async-storage\//)).toEqual([]);
    const client = readFileSync(new URL("src/auth/supabase-auth-client.ts", MOBILE_ROOT), "utf8");
    expect(client).toMatch(/detectSessionInUrl: false/);
    expect(client).toMatch(/new SupabaseAuthSessionSource\(client\.auth/);
  });

  it("Auth Slice C: no secret/service-role key name and no ANON_KEY leftover anywhere in the app", () => {
    expect(filesMatching(/SERVICE_ROLE|SUPABASE_SECRET|EXPO_PUBLIC_SUPABASE_ANON_KEY/)).toEqual([]);
    const gate = readFileSync(new URL("src/identity/identity-gate.tsx", MOBILE_ROOT), "utf8");
    expect(gate).toContain("process.env.EXPO_PUBLIC_SUPABASE_URL");
    expect(gate).toContain("process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  });
});
