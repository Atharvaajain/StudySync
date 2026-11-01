import { z } from 'zod';
import { BREAK_DURATIONS_MINUTES } from './constants';
import { isValidTimeZone } from './time';

/**
 * Shared Zod schemas for every client → server boundary (ARCHITECTURE §9.8, §17.3).
 * All objects are strict: unknown keys are rejected, so a client can never smuggle in
 * timestamps or durations (R14: the server is the source of truth).
 */

export const uuidSchema = z.uuid();

/** R4: only 5, 10, 15 or 30. Any other value (incl. "10" as a string) is rejected. */
export const breakMinutesSchema = z.literal(BREAK_DURATIONS_MINUTES);

/** YYYY-MM-DD calendar date (no timezone). */
export const localDateSchema = z.iso.date();

// ───────────── accounts (API_DESIGN §5) ─────────────

export const nameSchema = z.string().trim().min(1).max(50);
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: 'INVALID_TIMEZONE' });

/** UTF-8 byte length (same result as TextEncoder; lone surrogates count as U+FFFD = 3 bytes). */
export function utf8Bytes(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}
/** 10–72 UTF-8 bytes: bcrypt silently ignores everything past 72 bytes (§17.1). */
export const passwordSchema = z
  .string()
  .refine((p) => utf8Bytes(p) >= 10, { message: 'Password must be at least 10 bytes' })
  .refine((p) => utf8Bytes(p) <= 72, { message: 'Password must be at most 72 bytes' });

export const registerSchema = z.strictObject({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  timezone: timezoneSchema,
});

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const updateProfileSchema = z
  .strictObject({ name: nameSchema.optional(), timezone: timezoneSchema.optional() })
  .refine((v) => v.name !== undefined || v.timezone !== undefined, {
    message: 'Nothing to update',
  });

// ───────────── rooms & timer (API_DESIGN §7) ─────────────

export const joinRoomSchema = z.strictObject({ roomId: uuidSchema });
export const leaveRoomSchema = z.strictObject({ roomId: uuidSchema });

export const startStudySchema = z.strictObject({
  commandId: uuidSchema,
  roomId: uuidSchema.nullable(),
  taskId: uuidSchema.nullable().optional(),
});

export const takeBreakSchema = z.strictObject({
  commandId: uuidSchema,
  sessionId: uuidSchema,
  durationMinutes: breakMinutesSchema,
});

export const resumeStudySchema = z.strictObject({
  commandId: uuidSchema,
  sessionId: uuidSchema,
});

export const endStudySchema = z.strictObject({
  commandId: uuidSchema,
  sessionId: uuidSchema,
});

export const setSessionTaskSchema = z.strictObject({
  commandId: uuidSchema,
  sessionId: uuidSchema,
  taskId: uuidSchema.nullable(),
});

export const syncStateSchema = z.strictObject({});
export const authRenewSchema = z.strictObject({ token: z.string().min(1).max(4096) });

// ───────────── tasks (API_DESIGN §7, F-25–F-27) ─────────────

const taskTitleSchema = z.string().trim().min(1).max(200);
const taskDescriptionSchema = z.string().trim().max(2000);

export const taskAddSchema = z.strictObject({
  id: uuidSchema,
  roomId: uuidSchema.nullable(),
  title: taskTitleSchema,
  description: taskDescriptionSchema.nullable().optional(),
  dueDate: localDateSchema.nullable().optional(),
});

export const taskToggleSchema = z.strictObject({ taskId: uuidSchema, done: z.boolean() });

export const taskUpdateSchema = z
  .strictObject({
    taskId: uuidSchema,
    expectedVersion: z.int().min(1),
    title: taskTitleSchema.optional(),
    description: taskDescriptionSchema.nullable().optional(),
    dueDate: localDateSchema.nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.description !== undefined || v.dueDate !== undefined, {
    message: 'Nothing to update',
  });

export const taskDeleteSchema = z.strictObject({ taskId: uuidSchema });

// ───────────── reads (API_DESIGN §5) ─────────────

export const dailyStatsQuerySchema = z.strictObject({ from: localDateSchema, to: localDateSchema });

export const historyQuerySchema = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type RegisterPayload = z.input<typeof registerSchema>;
export type LoginPayload = z.input<typeof loginSchema>;
export type UpdateProfilePayload = z.input<typeof updateProfileSchema>;
export type JoinRoomPayload = z.input<typeof joinRoomSchema>;
export type LeaveRoomPayload = z.input<typeof leaveRoomSchema>;
export type StartStudyPayload = z.input<typeof startStudySchema>;
export type TakeBreakPayload = z.input<typeof takeBreakSchema>;
export type ResumeStudyPayload = z.input<typeof resumeStudySchema>;
export type EndStudyPayload = z.input<typeof endStudySchema>;
export type SetSessionTaskPayload = z.input<typeof setSessionTaskSchema>;
export type SyncStatePayload = z.input<typeof syncStateSchema>;
export type AuthRenewPayload = z.input<typeof authRenewSchema>;
export type TaskAddPayload = z.input<typeof taskAddSchema>;
export type TaskTogglePayload = z.input<typeof taskToggleSchema>;
export type TaskUpdatePayload = z.input<typeof taskUpdateSchema>;
export type TaskDeletePayload = z.input<typeof taskDeleteSchema>;
