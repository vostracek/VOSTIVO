import { assertDevToolingTarget, assertNotDogfoodTarget } from "@vostivo/database";
import { requireDisposableDatabaseUrl } from "../../packages/test-fixtures/src/assert-disposable-test-database.js";

// Dogfood Environment V1 — integration tests truncate/insert freely and must
// never run against the dogfood database (checked before any test connects).
assertNotDogfoodTarget(process.env, "integration tests");

// Name and host checks first, so nothing connects to an unsafe target. The
// connection then refuses a renamed or marker-carrying dogfood database.
const databaseUrl = requireDisposableDatabaseUrl("DATABASE_URL");
await assertDevToolingTarget(databaseUrl, "integration tests", process.env);
