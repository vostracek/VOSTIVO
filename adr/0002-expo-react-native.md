# ADR-0002: Expo + React Native for mobile

- **Status**: Accepted
- **Date**: 2026-09-02

## Context

Vostivo's Active Workout requires offline-first behavior, durable local
persistence, and eventually native modules (encrypted SQLite, background
sync). The team needs a mobile stack with strong DX, OTA update support,
and a mature native-module ecosystem, without hand-rolling native project
configuration for two platforms.

## Decision

Use Expo (SDK 57, development-build-oriented, not Expo Go-only) with React
Native 0.86.3, Expo Router for file-based navigation, and TypeScript strict
mode.

## Alternatives considered

- **Bare React Native (no Expo)**: rejected — would mean owning native
  project config/upgrades by hand for no concrete benefit yet; Expo's
  config plugins cover the native requirements (SQLite, SecureStore)
  Foundation Bootstrap needs today.
- **Flutter**: rejected — the team's existing TypeScript domain/contracts
  packages would not be shareable with a Dart mobile app.
- **Expo Go-only (no development build)**: rejected — Expo Go cannot load
  custom native modules, which future encrypted-SQLite work will need
  (see docs/architecture/FOUNDATION.md's SQLCipher note).

## Consequences

- A development build (not Expo Go) is required once any native module
  outside Expo's default set is added.
- pnpm requires `node-linker=hoisted` for RN autolinking to resolve native
  modules correctly in this workspace layout.
- SQLCipher/encrypted local storage is deferred; it needs a native
  development build and is out of scope for Foundation Bootstrap.
