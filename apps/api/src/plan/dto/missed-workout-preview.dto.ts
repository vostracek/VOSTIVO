/**
 * Missed Workout V1 Slice B: intentionally EMPTY. With the global
 * `forbidNonWhitelisted` ValidationPipe, any client-supplied field (a date,
 * slots, workout ids, a timeline) is rejected with 400 — the preview's
 * inputs are server-derived only.
 */
export class MissedWorkoutPreviewRequestDto {}
