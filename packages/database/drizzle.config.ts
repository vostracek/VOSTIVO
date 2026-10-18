import { defineConfig } from "drizzle-kit";

/**
 * Drizzle migration infrastructure only — no product schema yet (spec
 * section 17: physical schema grows per vertical slice). Always the
 * migration/admin role (Security Hardening Follow-Up V1, "Postgres least
 * privilege") — never the API runtime role's `DATABASE_URL` — read only
 * by the CLI at generate/migrate time, never bundled into app code.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? "postgres://localhost:5432/vostivo_placeholder",
  },
  strict: true,
  verbose: true,
});
