/**
 * Development seed (DATABASE_DESIGN §11), simplified for Phase 1. Development only: the env
 * guard refuses NODE_ENV=production, and existing demo users are never overwritten.
 *
 * Creates three demo users in different timezones, makes them members of the demo room
 * "DSA Night Study" (code DSA7K2), adds personal tasks, and records two weeks of study history
 * THROUGH THE REAL SESSION SERVICE with a fake clock (breaks, midnight-spanning sessions and
 * solo → room moves included), so totals, streaks and history look realistic.
 *
 *   npm run db:seed      (password for every demo user: studysync-demo)
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { minutesToMs } from '@studysync/shared';
import { loadEnv } from '../src/config/env';
import { ManualClock } from '../src/lib/clock';
import { createLogger } from '../src/lib/logger';
import { createStudySyncServer } from '../src/server';
import type { PresenceContext } from '../src/modules/sessions/sessionService';

const envFile = new URL('../.env', import.meta.url);
try {
  process.loadEnvFile(envFile);
} catch {
  // no .env: rely on the environment
}
const env = loadEnv();

const DEMO_PASSWORD = 'studysync-demo';
/** The demo room (the Phase 0 prototype room's name and code). Join it by code: DSA7K2. */
const PROTOTYPE_ROOM = {
  id: '5e1f0d5a-0000-4000-8000-000000000001',
  name: 'DSA Night Study',
  code: 'DSA7K2',
} as const;
const USERS = [
  { name: 'Atharva', email: 'atharva@demo.studysync.local', timezone: 'Asia/Kolkata' },
  { name: 'Maya', email: 'maya@demo.studysync.local', timezone: 'America/New_York' },
  { name: 'Leo', email: 'leo@demo.studysync.local', timezone: 'Australia/Lord_Howe' },
] as const;

const DAY = 86_400_000;
const now = Date.now();
const clock = new ManualClock(now - 15 * DAY);
const server = createStudySyncServer({ env, clock, logger: createLogger('warn') });
const { db, sessions } = server;

const solo: PresenceContext = { userPresenceRoomId: null, callerRoomId: null };
const inRoom: PresenceContext = {
  userPresenceRoomId: PROTOTYPE_ROOM.id,
  callerRoomId: PROTOTYPE_ROOM.id,
};

async function study(
  userId: string,
  startAt: number,
  plan: { studyMin: number[]; breakMin: (5 | 10 | 15 | 30)[]; room: boolean },
): Promise<void> {
  if (startAt + DAY > now) return; // never write the future
  clock.set(startAt);
  const presence = plan.room ? inRoom : solo;
  const started = await sessions.execute(userId, presence, {
    type: 'START',
    commandId: randomUUID(),
    roomId: plan.room ? PROTOTYPE_ROOM.id : null,
  });
  const sessionId = started.session!.id;
  for (let i = 0; i < plan.studyMin.length; i++) {
    clock.advance(minutesToMs(plan.studyMin[i]!));
    const brk = plan.breakMin[i];
    if (brk === undefined) break;
    await sessions.execute(userId, presence, {
      type: 'TAKE_BREAK',
      commandId: randomUUID(),
      sessionId,
      durationMinutes: brk,
    });
    clock.advance(minutesToMs(brk) + 30_000);
    await sessions.execute(userId, presence, {
      type: 'RESUME',
      commandId: randomUUID(),
      sessionId,
    });
  }
  await sessions.execute(userId, presence, { type: 'END', commandId: randomUUID(), sessionId });
}

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, env.BCRYPT_COST);
  const created: { id: string; timezone: string; name: string }[] = [];
  for (const u of USERS) {
    const existing = await db.user.findUnique({ where: { email: u.email } });
    if (existing) {
      console.log(`• ${u.name} already exists — skipped (the seed never overwrites data)`);
      continue;
    }
    const user = await db.user.create({
      data: { ...u, passwordHash, createdAt: new Date(clock.now()) },
    });
    created.push(user);
  }
  if (created.length === 0) return;

  // Prototype room, everyone a member (membership is permanent, D-2).
  const roomOwner = await db.user.findUniqueOrThrow({ where: { email: USERS[0].email } });
  await db.room.upsert({
    where: { id: PROTOTYPE_ROOM.id },
    update: {},
    create: { ...PROTOTYPE_ROOM, createdById: roomOwner.id, createdAt: new Date(clock.now()) },
  });
  for (const user of created) {
    await db.roomMember.upsert({
      where: { roomId_userId: { roomId: PROTOTYPE_ROOM.id, userId: user.id } },
      update: {},
      create: { roomId: PROTOTYPE_ROOM.id, userId: user.id, joinedAt: new Date(clock.now()) },
    });
    for (const [i, title] of [
      'Revise graphs',
      'Dynamic programming set',
      'Mock interview',
    ].entries()) {
      await db.task.create({
        data: {
          id: randomUUID(),
          userId: user.id,
          title,
          dueDate: new Date(Math.floor(now / DAY) * DAY + (i + 1) * DAY),
        },
      });
    }
  }

  // Two weeks of history. Day offsets with no entry are rest days (they break streaks).
  for (const [index, user] of created.entries()) {
    for (let day = 14; day >= 1; day--) {
      if ((day + index) % 6 === 0) continue; // a rest day now and then
      const base = Math.floor((now - day * DAY) / DAY) * DAY + (index * 3 + 3) * 3_600_000;
      await study(user.id, base, {
        studyMin: [25 + ((day * 7) % 20), 20 + ((day * 3) % 15)],
        breakMin: [day % 2 === 0 ? 10 : 5],
        room: day % 3 === 0,
      });
      if (day % 4 === 0) {
        // A late session that crosses local midnight in this user's timezone.
        await study(user.id, base + 12 * 3_600_000, { studyMin: [50], breakMin: [], room: false });
      }
    }
    console.log(`• ${user.name} (${user.timezone}) — demo history recorded`);
  }
  console.log(`\nDemo users ready. Password: ${DEMO_PASSWORD}`);
  for (const u of USERS) console.log(`  ${u.email}`);
}

try {
  await main();
} finally {
  await server.close();
  await db.$disconnect();
}
