import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { Type } from "@nestjs/common";
import { AppModule } from "../app.module.js";
import { HealthController } from "../health/health.controller.js";
import { AuthGuard } from "./auth.guard.js";

/**
 * CORE-AUDIT-01 F-06: authentication is opt-in per controller
 * (`@UseGuards(AuthGuard)`, no global APP_GUARD), so a new controller
 * without it would be silently public. This walks the REAL AppModule import
 * graph — not a hand-maintained list — and fails for any route handler that
 * AuthGuard does not cover (class- or method-level). The only intentionally
 * public surface is HealthController (liveness/readiness, no athlete data).
 * AuthGuard's own behavior (401/403, actor from the token only) is covered
 * by me.controller.test.ts and the per-controller HTTP tests.
 */
// Nest's own reflect-metadata keys (@nestjs/common/constants, which this
// package's module resolution does not expose as a typed subpath).
const GUARDS_METADATA = "__guards__";
const METHOD_METADATA = "method";
const PATH_METADATA = "path";
const MODULE_METADATA = { CONTROLLERS: "controllers", IMPORTS: "imports" } as const;

const PUBLIC_CONTROLLERS: ReadonlySet<Type> = new Set([HealthController]);

function collectControllers(root: Type): Type[] {
  const seen = new Set<unknown>();
  const controllers = new Set<Type>();
  const visit = (entry: unknown): void => {
    // A dynamic module (e.g. ConfigModule.forRoot) is `{ module, controllers?, imports? }`.
    const moduleType =
      typeof entry === "function" ? entry : (entry as { module?: unknown } | null)?.module;
    if (moduleType === undefined || seen.has(entry)) return;
    seen.add(entry);
    const dynamic =
      typeof entry === "function" ? {} : (entry as { controllers?: Type[]; imports?: unknown[] });
    const ownControllers =
      (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleType as object) as
        Type[] | undefined) ?? [];
    for (const controller of [...ownControllers, ...(dynamic.controllers ?? [])])
      controllers.add(controller);
    const imports =
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleType as object) as
        unknown[] | undefined) ?? [];
    for (const imported of [...imports, ...(dynamic.imports ?? [])]) visit(imported);
  };
  visit(root);
  return [...controllers];
}

function routeHandlers(controller: Type): string[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).filter((name) => {
    const handler = prototype[name];
    return (
      name !== "constructor" &&
      typeof handler === "function" &&
      Reflect.getMetadata(METHOD_METADATA, handler) !== undefined &&
      Reflect.getMetadata(PATH_METADATA, handler) !== undefined
    );
  });
}

function guardsOf(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];
}

describe("F-06: every non-public controller route is protected by AuthGuard", () => {
  const controllers = collectControllers(AppModule);

  it("discovers the real controller set from AppModule (sanity: a broken walk must not pass vacuously)", () => {
    const names = controllers.map((controller) => controller.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "GuidedLoadingSetupController",
        "HealthController",
        "MeController",
        "PlanController",
        "ProgressController",
        "ProgressionController",
        "WorkoutSyncController",
      ]),
    );
  });

  it("no route handler outside the public allowlist lacks AuthGuard", () => {
    const unprotected: string[] = [];
    for (const controller of controllers) {
      if (PUBLIC_CONTROLLERS.has(controller)) continue;
      const classGuarded = guardsOf(controller).includes(AuthGuard);
      const handlers = routeHandlers(controller);
      expect(handlers.length, `${controller.name} has no discovered routes`).toBeGreaterThan(0);
      for (const name of handlers) {
        const handler = (controller.prototype as Record<string, object>)[name]!;
        if (!classGuarded && !guardsOf(handler).includes(AuthGuard))
          unprotected.push(`${controller.name}.${name}`);
      }
    }
    expect(unprotected).toEqual([]);
  });
});
