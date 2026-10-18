/**
 * Architectural boundary enforcement (spec section 20).
 *
 * These two rules are the ones that matter for Foundation Bootstrap:
 * - packages/domain must stay framework/vendor free.
 * - packages/training-engine must stay deterministic and infrastructure free.
 *
 * Run with: pnpm boundaries:check
 */
const FORBIDDEN_MODULES = [
  "^@nestjs/",
  "^next(/|$)",
  "^react(/|$)",
  "^react-dom(/|$)",
  "^react-native",
  "^expo",
  "^drizzle-orm",
  "^drizzle-kit",
  "^@supabase/",
  "^pg$",
  "^postgres$",
  "^fastify",
  "^jose$",
];

/**
 * `packages/progression-application` is shared SERVER APPLICATION logic
 * (Progression Evaluation Orchestration V1's framework-boundary cleanup) —
 * unlike domain/training-engine it legitimately depends on `drizzle-orm`
 * and `@vostivo/database` (it IS the database-application layer), so it
 * cannot reuse `FORBIDDEN_MODULES` above wholesale. It must still never
 * depend on NestJS — apps/api adapts its plain classes into Nest DI itself,
 * never the other way around.
 */
const NEST_MODULES = ["^@nestjs/"];

module.exports = {
  forbidden: [
    {
      name: "domain-must-be-framework-free",
      comment:
        "packages/domain is pure business/domain TypeScript. It must never depend on a framework, ORM, or vendor SDK.",
      severity: "error",
      from: { path: "^packages/domain" },
      to: { path: FORBIDDEN_MODULES.join("|"), dependencyTypesNot: ["core"] },
    },
    {
      name: "training-engine-must-be-infrastructure-free",
      comment:
        "packages/training-engine must stay pure and deterministic: no DB, no network, no framework.",
      severity: "error",
      from: { path: "^packages/training-engine" },
      to: { path: FORBIDDEN_MODULES.join("|"), dependencyTypesNot: ["core"] },
    },
    {
      name: "no-circular",
      comment: "Circular dependencies make module boundaries meaningless.",
      severity: "warn",
      from: {},
      to: { circular: true },
    },
    {
      name: "worker-must-not-depend-on-api",
      comment:
        "apps/worker must never import apps/api source (Progression Evaluation Orchestration V1). Anything both runtimes need (job contracts, ProgressionEvaluationService, ...) belongs in a shared package such as @vostivo/progression-application, never in a direct cross-app import.",
      severity: "error",
      from: { path: "^apps/worker/src" },
      to: { path: "^apps/api/src" },
    },
    {
      name: "progression-application-must-not-depend-on-nestjs",
      comment:
        "packages/progression-application is shared server APPLICATION logic used directly by both apps/api and apps/worker (Orchestration V1 framework-boundary cleanup) — it must never depend on NestJS. apps/api adapts its plain, undecorated classes into Nest DI via its own useFactory providers; the dependency never runs the other way.",
      severity: "error",
      from: { path: "^packages/progression-application" },
      to: { path: NEST_MODULES.join("|"), dependencyTypesNot: ["core"] },
    },
    {
      name: "progression-application-must-not-depend-on-apps",
      comment:
        "packages/progression-application is consumed BY apps/api and apps/worker — it must never depend on either app's source. That would invert the intended dependency direction and could reintroduce a worker->api coupling transitively through this package.",
      severity: "error",
      from: { path: "^packages/progression-application" },
      to: { path: "^apps/(api|worker)/src" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
