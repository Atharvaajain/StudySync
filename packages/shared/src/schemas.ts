import { z } from 'zod';
import { BREAK_DURATIONS_MINUTES } from './constants';

/**
 * Shared Zod schemas for every client → server boundary (ARCHITECTURE §9.8).
 * All objects are strict: unknown keys are rejected, so a client can never smuggle in
 * timestamps or durations (R14: the server is the source of truth).
 */

export const uuidSchema = z.uuid();

/** R4: only 5, 10, 15 or 30. Any other value (incl. "10" as a string) is rejected. */
export const breakMinutesSchema = z.literal(BREAK_DURATIONS_MINUTES);

/** PHASE 0 ONLY — prototype identity sent in the Socket.IO handshake (no authentication yet). */
export const prototypeIdentitySchema = z.strictObject({
  userId: uuidSchema,
  name: z.string().trim().min(1).max(50),
});

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

export const syncStateSchema = z.strictObject({});

export type PrototypeIdentity = z.infer<typeof prototypeIdentitySchema>;
export type JoinRoomPayload = z.input<typeof joinRoomSchema>;
export type LeaveRoomPayload = z.input<typeof leaveRoomSchema>;
export type StartStudyPayload = z.input<typeof startStudySchema>;
export type TakeBreakPayload = z.input<typeof takeBreakSchema>;
export type ResumeStudyPayload = z.input<typeof resumeStudySchema>;
export type EndStudyPayload = z.input<typeof endStudySchema>;
export type SyncStatePayload = z.input<typeof syncStateSchema>;
