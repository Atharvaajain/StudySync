/**
 * E2E-0 (TESTING_STRATEGY §5.8): two real browsers in the hardcoded room, driving the real UI.
 * Covers the Phase 0 acceptance scenarios end to end and captures side-by-side screenshots
 * and per-browser videos for the Phase 0 report. Since Phase 1 both users register real
 * accounts (separate browser contexts = separate cookies); since Phase 2 Alice creates the room
 * and Bob joins it by code.
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
  seconds,
} from '../helpers/app';

const SHOTS = fileURLToPath(new URL('../../docs/phase-0/screenshots/', import.meta.url));
const VIDEOS = fileURLToPath(new URL('../.artifacts/videos/', import.meta.url));
/** Regenerate the report screenshots only on request (CAPTURE_SCREENSHOTS=1). */
const CAPTURE = process.env.CAPTURE_SCREENSHOTS === '1';
if (CAPTURE) mkdirSync(SHOTS, { recursive: true });

/** Roadmap Phase 0 acceptance: the other browser sees a status change within 1 s. */
const WITHIN_1S = { timeout: 1_000 };

const member = (page: Page, name: string) =>
  page.locator(`[data-testid="member-row"][data-user-name="${name}"]`);

test.describe.configure({ mode: 'serial' });

let browserRef: Browser;
let ctxA: BrowserContext;
let ctxB: BrowserContext;
let alice: Page;
let bob: Page;

/** Side-by-side screenshot of both browsers (for the report). */
async function sideBySide(file: string, caption: string): Promise<void> {
  if (!CAPTURE) return;
  const [a, b] = await Promise.all([alice.screenshot(), bob.screenshot()]);
  const composer = await browserRef.newContext(); // not recorded
  const page = await composer.newPage();
  await page.setViewportSize({ width: 2 * 1280 + 24, height: 760 });
  await page.setContent(`
    <body style="margin:0;font-family:system-ui;background:#0f172a;color:white">
      <p style="margin:8px 12px;font-size:18px">${caption}</p>
      <div style="display:flex;gap:24px;padding:0 0 0 0">
        <figure style="margin:0"><figcaption style="padding:4px 12px">Browser A — Alice</figcaption>
          <img style="width:1280px" src="data:image/png;base64,${a.toString('base64')}"></figure>
        <figure style="margin:0"><figcaption style="padding:4px 12px">Browser B — Bob</figcaption>
          <img style="width:1280px" src="data:image/png;base64,${b.toString('base64')}"></figure>
      </div>
    </body>`);
  await page.screenshot({ path: `${SHOTS}${file}`, fullPage: true });
  await composer.close();
}

test.beforeAll(async ({ browser }) => {
  browserRef = browser;
  const options = {
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: VIDEOS, size: { width: 1280, height: 720 } },
  };
  ctxA = await browser.newContext(options);
  ctxB = await browser.newContext(options);
});

test.afterAll(async () => {
  const videos = [alice?.video(), bob?.video()];
  await ctxA?.close();
  await ctxB?.close();
  await videos[0]?.saveAs(`${VIDEOS}browser-a-alice.webm`);
  await videos[1]?.saveAs(`${VIDEOS}browser-b-bob.webm`);
});

test('1. two browsers join the same room and see each other', async () => {
  // Since Phase 2 the room is a real room: Alice creates it, Bob joins with its code.
  const created = await createRoomViaUi(ctxA, 'Alice', 'DSA Night Study');
  alice = created.page;
  bob = await joinRoomViaUi(ctxB, 'Bob', created.code);
  for (const page of [alice, bob]) {
    await expect(member(page, 'Alice')).toHaveAttribute('data-status', 'IDLE');
    await expect(member(page, 'Bob')).toHaveAttribute('data-status', 'IDLE');
  }
  await expect(alice.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'NO_SESSION');
});

test('2. both users start independent timers', async () => {
  await alice.getByTestId('start-study').click();
  await expect(alice.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'STUDYING');
  await alice.waitForTimeout(3_000); // Alice studies 3 s longer than Bob
  await bob.getByTestId('start-study').click();
  await expect(bob.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'STUDYING');

  await expect(member(bob, 'Alice')).toHaveAttribute('data-status', 'STUDYING', WITHIN_1S);
  await expect(member(alice, 'Bob')).toHaveAttribute('data-status', 'STUDYING', WITHIN_1S);
  const [a, b] = [await elapsed(alice), await elapsed(bob)];
  expect(a - b).toBeGreaterThanOrEqual(2); // two different, independent timers
  await sideBySide(
    '01-both-studying-independently.png',
    'Both studying — two independent timers (Alice started 3 s earlier)',
  );
});

test('3. Alice takes a break while Bob keeps studying', async () => {
  await alice.getByTestId('take-break').click();
  // R4: exactly four choices.
  const choices = alice.getByTestId('break-picker').getByRole('button', { name: /min$/ });
  await expect(choices).toHaveText(['5 min', '10 min', '15 min', '30 min']);
  await alice.getByTestId('break-5').click();

  await expect(alice.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'ON_BREAK');
  await expect(alice.getByTestId('resume-study')).toBeDisabled(); // no early resume
  const countdown = seconds(await alice.getByTestId('break-countdown').innerText());
  expect(countdown).toBeGreaterThan(4 * 60 + 50);
  expect(countdown).toBeLessThanOrEqual(5 * 60);

  // Bob sees Alice's countdown; Bob's own timer is unaffected and still running.
  await expect(member(bob, 'Alice')).toHaveAttribute('data-status', 'ON_BREAK', WITHIN_1S);
  await expect(member(bob, 'Alice').getByTestId('member-status')).toContainText(
    /On Break 0[45]:\d\d/,
  );
  await expect(bob.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'STUDYING');
  const b1 = await elapsed(bob);
  await bob.waitForTimeout(2_100);
  expect(await elapsed(bob)).toBeGreaterThanOrEqual(b1 + 2);
  await sideBySide(
    '02-alice-on-break-bob-studying.png',
    "Alice on a 5-minute break — Bob keeps studying and sees Alice's countdown",
  );
});

test('4. refresh while on break rebuilds the countdown from the server', async () => {
  const before = seconds(await alice.getByTestId('break-countdown').innerText());
  await alice.reload();
  await expect(alice.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'ON_BREAK');
  const after = seconds(await alice.getByTestId('break-countdown').innerText());
  expect(after).toBeLessThanOrEqual(before);
  expect(before - after).toBeLessThanOrEqual(5); // only the real seconds the reload took
  await expect(member(alice, 'Bob')).toHaveAttribute('data-status', 'STUDYING');
});

test('5. Alice resumes only after the break expires — never automatically', async () => {
  const studiedBeforeBreak = await elapsed(alice);
  await advanceServerClock(alice, 5 * MIN); // fast-forward the server through the break

  await expect(alice.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'BREAK_OVER');
  await expect(alice.getByTestId('break-over-banner')).toBeVisible();
  await expect(member(bob, 'Alice')).toHaveAttribute('data-status', 'IDLE', WITHIN_1S);
  await alice.waitForTimeout(2_000);
  await expect(alice.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'BREAK_OVER'); // still not studying
  await sideBySide(
    '03-break-over-no-auto-resume.png',
    'Break over — Alice is NOT resumed automatically; Bob sees her as Idle',
  );

  await expect(alice.getByTestId('resume-study')).toBeEnabled();
  await alice.getByTestId('resume-study').click();
  await expect(alice.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'STUDYING');
  await expect(member(bob, 'Alice')).toHaveAttribute('data-status', 'STUDYING', WITHIN_1S);
  // R3: the 5-minute break did not count as study time.
  expect(await elapsed(alice)).toBeLessThan(studiedBeforeBreak + 5);
});

test('6. refresh while studying keeps the same elapsed time', async () => {
  const before = await elapsed(bob);
  const t0 = Date.now();
  await bob.reload();
  await expect(bob.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'STUDYING');
  const after = await elapsed(bob);
  const realSeconds = Math.ceil((Date.now() - t0) / 1000);
  expect(after).toBeGreaterThanOrEqual(before);
  expect(after).toBeLessThanOrEqual(before + realSeconds + 1);
});

test('7. Alice ends study without affecting Bob', async () => {
  const bobBefore = await elapsed(bob);
  await alice.getByTestId('end-study').click();
  await expect(alice.getByTestId('session-summary')).toBeVisible();
  await expect(alice.getByTestId('summary-breaks')).toHaveText('1 (5 min)');
  expect(seconds(await alice.getByTestId('summary-studied').innerText())).toBeLessThan(60); // the break is excluded
  await expect(alice.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'NO_SESSION');

  await expect(member(bob, 'Alice')).toHaveAttribute('data-status', 'IDLE');
  await expect(bob.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'STUDYING');
  await bob.waitForTimeout(1_100);
  expect(await elapsed(bob)).toBeGreaterThan(bobBefore);
  await sideBySide(
    '04-alice-ended-bob-unaffected.png',
    "Alice ended her session (summary shown) — Bob's timer keeps running",
  );
});

test('8. leaving shows "reconnecting" to others; rejoining restores the live status', async () => {
  await alice.getByTestId('leave-room').click();
  await expect(alice.getByTestId('left-room')).toBeVisible();
  await expect(member(bob, 'Alice').getByTestId('member-status')).toContainText('reconnecting');
  await alice.getByTestId('rejoin-room').click();
  await expect(member(alice, 'Bob')).toHaveAttribute('data-status', 'STUDYING');
  await expect(member(bob, 'Alice').getByTestId('member-status')).not.toContainText('reconnecting');
});
