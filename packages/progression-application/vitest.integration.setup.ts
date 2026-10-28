import { assertNotDogfoodTarget } from "@vostivo/database";

// Dogfood Environment V1 — integration tests truncate/insert freely and must
// never run against the dogfood database (checked before any test connects).
assertNotDogfoodTarget(process.env, "integration tests");
