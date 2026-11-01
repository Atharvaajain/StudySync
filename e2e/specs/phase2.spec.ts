/**
 * Phase 2 E2E (TESTING_STRATEGY §5.8): rooms with three real browsers (separate contexts).
 *   E2E-4 Study with friends · E2E-5 join by code while studying · E2E-7 independent timers ·
 *   E2E-8 room tasks · E2E-9 (navigation part) back-to-room banner · E2E-10 idle auto-save ·
 *   E2E-12 room reuse · E2E-13 Today in this room.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  MIN,
  advanceServerClock,
  createRoomViaUi,
  elapsed,
  joinRoomViaUi,
  registerViaUi,
} from '../helpers/app';

const SHOTS = fileURLToPath(new URL('../../docs/phase-2/screenshots/', import.meta.url));
const CAPTURE = process.env.CAPTURE_SCREENSHOTS === '1';
if (CAPTURE) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, file: string) => {
  if (CAPTURE) await page.screenshot({ path: `${SHOTS}${file}`, fullPage: true });
};

const WITHIN_1S = { timeout: 1_000 };
const phase = (page: Page) => page.getByTestId('timer-phase');
const member = (page: Page, name: string) =>
  page.locator(`[data-testid="member-row"][data-user-name="${name}"]`);
const task = (page: Page, title: string) =>
  page.locator(`[data-testid="task-row"][data-task-title="${title}"]`);

test.describe.configure({ mode: 'serial' });

const contexts: BrowserContext[] = [];
async function context(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  contexts.push(ctx);
  return ctx;
}
test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
});

let atharva: Page;
let bilal: Page;
let chen: Page;
let code: string;

test('E2E-4: solo → Study with friends → the room is created and the timer keeps running', async ({
  browser,
}) => {
  atharva = await (await context(browser)).newPage();
  await registerViaUi(atharva, 'Atharva');
  await atharva.getByTestId('start-study').click();
  await expect(phase(atharva)).toHaveAttribute('data-phase', 'STUDYING');
  await atharva.waitForTimeout(2_200);
  const before = await elapsed(atharva);
  await atharva.getByTestId('study-with-friends').click();
  await atharva.getByTestId('friends-room-name').fill('DSA Night Study');
  await atharva.getByTestId('friends-create').click();
  await expect(atharva.getByTestId('room-name')).toHaveText('DSA Night Study');
  code = await atharva.getByTestId('room-code').innerText();
  await expect(phase(atharva)).toHaveAttribute('data-phase', 'STUDYING');
  expect(await elapsed(atharva)).toBeGreaterThanOrEqual(before); // moved, not reset
  await expect(member(atharva, 'Atharva')).toHaveAttribute('data-status', 'STUDYING');
});

test('E2E-5: join by code while solo-studying → the session moves; a second room says End Study first', async ({
  browser,
}) => {
  const ctx = await context(browser);
  bilal = await ctx.newPage();
  await registerViaUi(bilal, 'Bilal');
  await bilal.getByTestId('start-study').click();
  await expect(phase(bilal)).toHaveAttribute('data-phase', 'STUDYING');
  await joinRoomViaUi(bilal, 'Bilal', code);
  await expect(phase(bilal)).toHaveAttribute('data-phase', 'STUDYING');
  await expect(member(atharva, 'Bilal')).toHaveAttribute('data-status', 'STUDYING', WITHIN_1S);

  // Chen creates a second room; Bilal tries to join it while his session lives in the first.
  const created = await createRoomViaUi(await context(browser), 'Chen', 'Algorithms');
  chen = created.page;
  const otherCode = created.code;
  await bilal.getByRole('link', { name: 'Dashboard' }).click();
  await bilal.getByTestId('room-code-input').fill(otherCode);
  await bilal.getByTestId('join-room').click();
  await expect(bilal.getByTestId('error')).toContainText(
    'End your study session in the other room first.',
  );
  await bilal.getByTestId('back-to-room').getByRole('link').click();
  await expect(bilal.getByTestId('room-name')).toHaveText('DSA Night Study');
});

test('E2E-7 / E2E-13: three members, independent timers, countdown and Today in this room', async () => {
  await joinRoomViaUi(chen, 'Chen', code);
  for (const p of [atharva, bilal, chen]) {
    await expect(member(p, 'Chen')).toHaveAttribute('data-status', 'IDLE');
  }
  await atharva.getByTestId('take-break').click();
  await atharva.getByTestId('break-10').click();
  for (const p of [bilal, chen]) {
    await expect(member(p, 'Atharva')).toHaveAttribute('data-status', 'ON_BREAK', WITHIN_1S);
    await expect(member(p, 'Atharva').getByTestId('member-status')).toContainText(
      /On Break (10:00|0\d:\d\d)/,
    );
  }
  await expect(phase(bilal)).toHaveAttribute('data-phase', 'STUDYING'); // unaffected
  await expect(phase(chen)).toHaveAttribute('data-phase', 'NO_SESSION');
  const today = chen.getByTestId('today-in-room');
  await expect(today.locator('[data-testid="today-member"][data-user-name="Bilal"]')).toBeVisible();
  await expect(today.locator('[data-testid="today-member"]')).toHaveCount(2); // Chen hasn't studied
  await shot(chen, '01-room-three-members.png');
});

test('E2E-8: room tasks — A adds, B checks off, C sees it within 1 s; delete rights', async () => {
  await atharva.getByTestId('task-title-input').fill('Dijkstra practice');
  await atharva.getByTestId('task-add').click();
  await expect(task(chen, 'Dijkstra practice')).toBeVisible(WITHIN_1S);
  await task(bilal, 'Dijkstra practice').getByTestId('task-toggle').click();
  await expect(task(chen, 'Dijkstra practice')).toHaveAttribute('data-status', 'DONE', WITHIN_1S);
  await expect(task(chen, 'Dijkstra practice').getByTestId('task-people')).toContainText(
    'added by Atharva · ✓ by Bilal',
  );
  // Only the task creator or the room creator sees Delete (Chen is neither).
  await expect(task(chen, 'Dijkstra practice').getByTestId('task-delete')).toHaveCount(0);
  await expect(task(atharva, 'Dijkstra practice').getByTestId('task-delete')).toHaveCount(1);
  await shot(atharva, '02-room-tasks.png');
});

test('E2E-9 (navigation): leaving the room screen shows the save countdown; back in time → nothing lost', async () => {
  await bilal.getByRole('link', { name: 'Dashboard' }).click();
  await expect(bilal.getByTestId('back-to-room-countdown')).toHaveText(/^0?[12]:\d\d$/);
  await expect(member(atharva, 'Bilal').getByTestId('member-status')).toContainText('reconnecting');
  await shot(bilal, '03-back-to-room-banner.png');
  await bilal.getByTestId('back-to-room').getByRole('link').click();
  await expect(phase(bilal)).toHaveAttribute('data-phase', 'STUDYING');
  await expect(member(atharva, 'Bilal').getByTestId('member-status')).not.toContainText(
    'reconnecting',
  );
  await expect(bilal.getByTestId('auto-saved-notice')).toHaveCount(0);
});

test('E2E-10: Break Over + 30 min → auto-saved (idle); the member shows Idle', async () => {
  await advanceServerClock(atharva, 10 * MIN); // Atharva's 10-minute break ends
  await expect(phase(atharva)).toHaveAttribute('data-phase', 'BREAK_OVER');
  await expect(atharva.getByTestId('idle-countdown')).toContainText(
    /Auto-saving in (30:00|29:\d\d)/,
  );
  await advanceServerClock(atharva, 30 * MIN);
  await expect(atharva.getByTestId('auto-saved-notice')).toContainText(
    'after 30 minutes in Break Over',
  );
  await expect(phase(atharva)).toHaveAttribute('data-phase', 'NO_SESSION');
  await expect(member(chen, 'Atharva')).toHaveAttribute('data-status', 'IDLE');
  // Bilal kept studying through all of it.
  await expect(phase(bilal)).toHaveAttribute('data-phase', 'STUDYING');
  await shot(atharva, '04-idle-auto-saved.png');
  await atharva.getByTestId('auto-saved-notice').getByRole('button', { name: 'Dismiss' }).click();
  await expect(atharva.getByTestId('auto-saved-notice')).toHaveCount(0);
});

test('E2E-12: rooms are reusable — leave, rejoin from My Rooms, tasks and membership persist', async () => {
  await chen.getByTestId('leave-room').click();
  await expect(chen.getByTestId('left-room')).toBeVisible();
  await chen.getByRole('link', { name: 'Dashboard' }).click();
  const rooms = chen.getByTestId('my-room');
  await expect(rooms).toHaveCount(2);
  await chen
    .locator('[data-testid="my-room"][data-room-name="DSA Night Study"]')
    .getByRole('link')
    .click();
  await expect(chen.getByTestId('room-name')).toHaveText('DSA Night Study');
  await expect(task(chen, 'Dijkstra practice')).toHaveAttribute('data-status', 'DONE');
  await expect(member(atharva, 'Chen')).toHaveAttribute('data-status', 'IDLE');
});
