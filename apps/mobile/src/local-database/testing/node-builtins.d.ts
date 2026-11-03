/**
 * TEST-ONLY ambient types for the few Node built-ins the real-SQLite test
 * adapter (`node-sqlite-database.ts`), the source-scanning tests and the
 * CC-02 crash-recovery test (real child process + SIGKILL) use
 * under vitest. Deliberately not `@types/node`: that would add Node globals
 * (timers, `process`, ...) to a React Native app's type environment. Never imported by app code — Metro
 * never bundles these modules.
 */
declare module "node:sqlite" {
  export interface StatementResultingChanges {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    columns(): readonly unknown[];
    all(...parameters: unknown[]): Record<string, unknown>[];
    run(...parameters: unknown[]): StatementResultingChanges;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:fs" {
  export function rmSync(path: string, options?: { readonly force?: boolean; readonly recursive?: boolean }): void;
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function mkdirSync(path: string, options?: { readonly recursive?: boolean }): void;
  export function readdirSync(path: string | URL): string[];
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    readonly status: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
  }
  export function spawnSync(command: string, args: readonly string[], options: { readonly encoding: "utf8" }): SpawnSyncResult;
}
