-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "SessionEndReason" AS ENUM ('USER', 'DISCONNECTED', 'IDLE_TIMEOUT');

-- CreateEnum
CREATE TYPE "SegmentEndReason" AS ENUM ('BREAK', 'ENDED_BY_USER', 'DISCONNECTED', 'ROOM_MOVE');

-- CreateEnum
CREATE TYPE "BreakCloseReason" AS ENUM ('RESUMED', 'ENDED_BY_USER', 'DISCONNECTED', 'IDLE_TIMEOUT');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'DONE');

-- CreateEnum
CREATE TYPE "TimerPhase" AS ENUM ('NO_SESSION', 'STUDYING', 'ON_BREAK', 'BREAK_OVER', 'ENDED');

-- CreateEnum
CREATE TYPE "SessionEventType" AS ENUM ('STARTED', 'BREAK_TAKEN', 'RESUMED', 'ENDED', 'MOVED_TO_ROOM', 'TASK_SET', 'DISCONNECTED', 'LEASE_LOST', 'RECONNECTED', 'GRACE_EXPIRED', 'IDLE_TIMEOUT');

-- CreateEnum
CREATE TYPE "EventActor" AS ENUM ('USER', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(100) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by_id" UUID,
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "code" CHAR(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_members" (
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_visited_at" TIMESTAMPTZ(3),

    CONSTRAINT "room_members_pkey" PRIMARY KEY ("room_id","user_id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "room_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "due_date" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "room_id" UUID,
    "task_id" UUID,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" "SessionEndReason",
    "current_segment_started_at" TIMESTAMPTZ(3),
    "break_ends_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "disconnected_at" TIMESTAMPTZ(3),
    "summary_seen_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "study_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_segments" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "room_id" UUID,
    "timezone" VARCHAR(64) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" "SegmentEndReason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_breaks" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" "BreakCloseReason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_breaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_events" (
    "id" BIGSERIAL NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "SessionEventType" NOT NULL,
    "actor" "EventActor" NOT NULL,
    "from_phase" "TimerPhase" NOT NULL,
    "to_phase" "TimerPhase" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "command_id" UUID,
    "payload" JSONB,

    CONSTRAINT "session_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_code_key" ON "rooms"("code");

-- CreateIndex
CREATE INDEX "room_members_user_id_last_visited_at_idx" ON "room_members"("user_id", "last_visited_at" DESC);

-- CreateIndex
CREATE INDEX "study_sessions_user_id_started_at_idx" ON "study_sessions"("user_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "study_sessions_room_id_idx" ON "study_sessions"("room_id");

-- CreateIndex
CREATE INDEX "study_segments_user_id_started_at_idx" ON "study_segments"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "study_segments_room_id_started_at_idx" ON "study_segments"("room_id", "started_at");

-- CreateIndex
CREATE INDEX "study_segments_session_id_started_at_idx" ON "study_segments"("session_id", "started_at");

-- CreateIndex
CREATE INDEX "study_breaks_session_id_started_at_idx" ON "study_breaks"("session_id", "started_at");

-- CreateIndex
CREATE INDEX "study_breaks_user_id_started_at_idx" ON "study_breaks"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "session_events_session_id_id_idx" ON "session_events"("session_id", "id");

-- CreateIndex
CREATE INDEX "session_events_recorded_at_idx" ON "session_events"("recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "session_events_user_id_command_id_key" ON "session_events"("user_id", "command_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_segments" ADD CONSTRAINT "study_segments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "study_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_segments" ADD CONSTRAINT "study_segments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_segments" ADD CONSTRAINT "study_segments_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_breaks" ADD CONSTRAINT "study_breaks_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "study_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_breaks" ADD CONSTRAINT "study_breaks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "study_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════
-- Hand-written constraints and indexes — verbatim from DATABASE_DESIGN.md §5.
-- Prisma does not model these. Never let a generated migration DROP them (INT-SCHEMA guards this).
-- ════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- uuid equality inside GiST exclusion constraints

-- ─── users ───
ALTER TABLE users
  ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  ADD CONSTRAINT users_name_not_blank  CHECK (length(btrim(name)) > 0);

-- ─── rooms ───  (F-13: 6 chars, no O/0/I/1)
ALTER TABLE rooms
  ADD CONSTRAINT rooms_code_format    CHECK (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  ADD CONSTRAINT rooms_name_not_blank CHECK (length(btrim(name)) > 0);

-- ─── tasks ───
ALTER TABLE tasks
  ADD CONSTRAINT tasks_title_not_blank CHECK (length(btrim(title)) > 0),
  ADD CONSTRAINT tasks_done_consistent CHECK (
    (status = 'DONE') = (completed_at IS NOT NULL) AND (status = 'DONE') = (completed_by_id IS NOT NULL)),
  ADD CONSTRAINT tasks_version_positive CHECK (version >= 1);
CREATE INDEX tasks_personal_live ON tasks (user_id, created_at) WHERE room_id IS NULL AND deleted_at IS NULL;
CREATE INDEX tasks_room_live     ON tasks (room_id, created_at) WHERE room_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX tasks_completed_by  ON tasks (completed_by_id, completed_at) WHERE completed_at IS NOT NULL;

-- ─── study_sessions ───
-- R6 / F-17: one ACTIVE session per user, ever
CREATE UNIQUE INDEX study_sessions_one_active_per_user ON study_sessions (user_id) WHERE status = 'ACTIVE';
-- sweeper: idle deadline (break_ends_at + 30 min), grace deadline (disconnected_at + 2 min), stale lease
CREATE INDEX study_sessions_break_deadline ON study_sessions (break_ends_at)   WHERE status = 'ACTIVE' AND break_ends_at IS NOT NULL;
CREATE INDEX study_sessions_grace_deadline ON study_sessions (disconnected_at) WHERE status = 'ACTIVE' AND disconnected_at IS NOT NULL;
CREATE INDEX study_sessions_lease          ON study_sessions (last_seen_at)    WHERE status = 'ACTIVE' AND disconnected_at IS NULL;

ALTER TABLE study_sessions
  ADD CONSTRAINT ss_ended_consistent CHECK (
    (status = 'ENDED') = (ended_at IS NOT NULL) AND (status = 'ENDED') = (end_reason IS NOT NULL)),
  -- the four-state model at row level: an ACTIVE session is studying XOR on a break (ON_BREAK/BREAK_OVER)
  ADD CONSTRAINT ss_active_phase_xor CHECK (
    status <> 'ACTIVE' OR ((current_segment_started_at IS NULL) <> (break_ends_at IS NULL))),
  ADD CONSTRAINT ss_ended_clean CHECK (
    status <> 'ENDED' OR (current_segment_started_at IS NULL AND break_ends_at IS NULL AND disconnected_at IS NULL)),
  ADD CONSTRAINT ss_time_order CHECK (ended_at IS NULL OR ended_at >= started_at),
  ADD CONSTRAINT ss_version_positive CHECK (version >= 1);

-- ─── study_segments ───
CREATE UNIQUE INDEX study_segments_one_open_per_session ON study_segments (session_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX study_segments_one_open_per_user    ON study_segments (user_id)    WHERE ended_at IS NULL;
ALTER TABLE study_segments
  ADD CONSTRAINT seg_close_consistent CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  ADD CONSTRAINT seg_time_order       CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- no two study blocks of one user overlap (half-open; open segment = unbounded)
  ADD CONSTRAINT seg_no_overlap_per_user EXCLUDE USING gist (
    user_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&);

-- ─── study_breaks ───
CREATE UNIQUE INDEX study_breaks_one_open_per_session ON study_breaks (session_id) WHERE closed_at IS NULL;
ALTER TABLE study_breaks
  ADD CONSTRAINT brk_duration_allowed CHECK (duration_minutes IN (5, 10, 15, 30)),                      -- R4
  ADD CONSTRAINT brk_ends_exact       CHECK (ends_at = started_at + duration_minutes * interval '1 minute'),
  ADD CONSTRAINT brk_close_consistent CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
  -- R10: a break (incl. Break Over waiting) can never outlive ends_at + 30 min
  ADD CONSTRAINT brk_close_window CHECK (
    closed_at IS NULL OR (closed_at >= started_at AND closed_at <= ends_at + interval '30 minutes')),
  -- R5: Resume is only possible once the countdown has finished
  ADD CONSTRAINT brk_resume_only_after_end CHECK (close_reason IS DISTINCT FROM 'RESUMED' OR closed_at >= ends_at),
  -- R10: idle auto-save happens exactly 30 min after the countdown ends
  ADD CONSTRAINT brk_idle_exact CHECK (close_reason IS DISTINCT FROM 'IDLE_TIMEOUT' OR closed_at = ends_at + interval '30 minutes'),
  ADD CONSTRAINT brk_no_overlap_per_user EXCLUDE USING gist (
    user_id WITH =, tstzrange(started_at, closed_at, '[)') WITH &&);

-- ─── session_events ───
ALTER TABLE session_events
  ADD CONSTRAINT evt_actor_matches_type CHECK (
    (type IN ('STARTED', 'BREAK_TAKEN', 'RESUMED', 'ENDED', 'MOVED_TO_ROOM', 'TASK_SET')) = (actor = 'USER')),
  ADD CONSTRAINT evt_command_only_for_user CHECK (command_id IS NULL OR actor = 'USER'),
  -- R5: a SYSTEM event may keep a session in STUDYING (e.g. RECONNECTED) but never move it INTO STUDYING
  ADD CONSTRAINT evt_no_system_resume CHECK (actor = 'USER' OR to_phase <> 'STUDYING' OR from_phase = 'STUDYING');
