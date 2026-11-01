/**
 * Phase 1 E2E (TESTING_STRATEGY §5.8): E2E-1, E2E-2, E2E-3, E2E-6, E2E-11 and the personal
 * task flow, through the real UI on the real server and database.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { io } from 'socket.io-client';
import { MIN, PASSWORD, advanceServerClock, elapsed, registerViaUi, seconds } from '../helpers/app';

const SHOTS = fileURLToPath(new URL('../../docs/phase-1/screenshots/', import.meta.url));
const CAPTURE = process.env.CAPTURE_SCREENSHOTS === '1';
if (CAPTURE) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, file: string) => {
  if (CAPTURE) await page.screenshot({ path: `${SHOTS}${file}`, fullPage: true });
};

const phase = (page: Page) => page.getByTestId('timer-phase');

test.describe.configure({ mode: 'serial' });

test('E2E-1: register (timezone detected) → logout → login → reload stays logged in', async ({
  browser,
}) => {
  const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('link', { name: 'Create an account' }).click();
  // Chromium reports India as the legacy id Asia/Calcutta; the app stores Asia/Kolkata.
  const INDIA = 'Asia/Kolkata';
  await expect(page.getByTestId('detected-timezone')).toContainText(INDIA);
  await shot(page, '01-register.png');
  const email = await registerViaUi(page, 'Atharva');
  await expect(page.getByTestId('today')).toContainText(INDIA);

  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/); // the refresh family was revoked

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('wrong password!!');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('error')).toHaveText('Email or password is incorrect.');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('signed-in-as')).toHaveText('Atharva');

  await page.reload(); // in-memory access token is gone; the refresh cookie restores it
  await expect(page.getByTestId('signed-in-as')).toHaveText('Atharva');
  await expect(page.getByTestId('connection')).toHaveAttribute('data-connection', 'connected');
  // No token is ever stored in web storage (§17.1).
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toMatch(/eyJ/);
  await context.close();
});

test('personal tasks: add, edit, complete, delete — synced to my other tab', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await registerViaUi(page, 'Tasker');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByTestId('connection')).toHaveAttribute('data-connection', 'connected');

  await page.getByTestId('task-title-input').fill('Revise graphs');
  await page.getByTestId('task-due-input').fill('2026-11-20');
  await page.getByTestId('task-add').click();
  const row = (p: Page) => p.locator('[data-testid="task-row"][data-task-title="Revise graphs"]');
  await expect(row(page)).toContainText('due 2026-11-20');
  await expect(row(other)).toBeVisible(); // personal_task_updated

  // The checkbox reflects the server's state: click, then wait for the confirmed change.
  await row(page).getByTestId('task-toggle').click();
  await expect(row(page)).toHaveAttribute('data-status', 'DONE');
  await expect(row(other)).toHaveAttribute('data-status', 'DONE');
  await row(page).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Edit title').fill('Revise graphs + DP');
  await page.getByRole('button', { name: 'Save' }).click();
  const renamed = (p: Page) =>
    p.locator('[data-testid="task-row"][data-task-title="Revise graphs + DP"]');
  await expect(renamed(other)).toBeVisible();
  await renamed(page).getByTestId('task-delete').click();
  await expect(renamed(other)).toHaveCount(0);
  await context.close();
});

test('E2E-2: solo session — 10-min break, no early or automatic resume, exact summary', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await registerViaUi(page, 'Solo');
  await page.getByTestId('task-title-input').fill('Binary search');
  await page.getByTestId('task-add').click();
  await page.getByTestId('start-task').selectOption({ label: 'Binary search' });
  await page.getByTestId('start-study').click();
  await expect(phase(page)).toHaveAttribute('data-phase', 'STUDYING');
  await expect(page.getByTestId('session-task')).toHaveValue(/.+/);
  await page.waitForTimeout(2_000);

  await page.getByTestId('take-break').click();
  await page.getByTestId('break-10').click();
  await expect(phase(page)).toHaveAttribute('data-phase', 'ON_BREAK');
  await expect(page.getByTestId('break-hint')).toContainText('Keep StudySync open');
  await expect(page.getByTestId('resume-study')).toBeDisabled();
  const studied = await elapsed(page);
  await shot(page, '02-solo-on-break.png');

  await advanceServerClock(page, 10 * MIN - 5_000);
  await expect(page.getByTestId('resume-study')).toBeDisabled(); // 5 s left
  await advanceServerClock(page, 5_000);
  await expect(phase(page)).toHaveAttribute('data-phase', 'BREAK_OVER');
  await page.waitForTimeout(1_500);
  await expect(phase(page)).toHaveAttribute('data-phase', 'BREAK_OVER'); // never automatic
  await page.getByTestId('resume-study').click();
  await expect(phase(page)).toHaveAttribute('data-phase', 'STUDYING');
  expect(await elapsed(page)).toBeLessThan(studied + 3); // the break did not count
  await page.waitForTimeout(1_000);

  await page.getByTestId('end-study').click();
  await expect(page.getByTestId('session-summary')).toBeVisible();
  await expect(page.getByTestId('summary-breaks')).toHaveText('1 (10 min)');
  await expect(page.getByTestId('summary-where')).toHaveText('Solo');
  await expect(page.getByTestId('summary-task')).toHaveText('Binary search');
  expect(seconds(await page.getByTestId('summary-studied').innerText())).toBeLessThan(15);
  await shot(page, '03-solo-summary.png');

  // History lists the session; its summary page shows the same numbers.
  await page.getByRole('link', { name: 'History' }).click();
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await page.getByTestId('session-row').getByRole('link').click();
  await expect(page.getByTestId('summary-breaks')).toHaveText('1 (10 min)');
  await context.close();
});

test('E2E-3: only 5/10/15/30 in the picker; a crafted 20-minute break is rejected', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = await registerViaUi(page, 'Crafty');
  await page.getByTestId('start-study').click();
  await page.getByTestId('take-break').click();
  const choices = page.getByTestId('break-picker').getByRole('button', { name: /min$/ });
  await expect(choices).toHaveText(['5 min', '10 min', '15 min', '30 min']);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // A hand-made client: log in over REST, then send take_break with 20 minutes.
  const login = await page.request.post('/api/v1/auth/login', {
    data: { email, password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const socket = io(baseURL!, { auth: { token: accessToken }, transports: ['websocket'] });
  const state = await new Promise<{ session: { id: string } | null }>((resolve) =>
    socket.once('session_state', resolve),
  );
  const res = (await socket.timeout(5_000).emitWithAck('take_break', {
    commandId: crypto.randomUUID(),
    sessionId: state.session!.id,
    durationMinutes: 20,
  })) as { ok: boolean; error?: { code: string } };
  socket.disconnect();
  expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
  await expect(phase(page)).toHaveAttribute('data-phase', 'STUDYING');
  await page.getByTestId('end-study').click();
  await context.close();
});

test('E2E-6: two tabs click Start Study at once → one session, both tabs show it', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const tab1 = await context.newPage();
  await registerViaUi(tab1, 'Twotabs');
  const tab2 = await context.newPage();
  await tab2.goto('/');
  await expect(tab2.getByTestId('connection')).toHaveAttribute('data-connection', 'connected');

  await Promise.all([
    tab1.getByTestId('start-study').click(),
    tab2.getByTestId('start-study').click(),
  ]);
  for (const tab of [tab1, tab2]) {
    await expect(phase(tab)).toHaveAttribute('data-phase', 'STUDYING');
  }
  const history = await tab1.request.get('/api/v1/sessions', {
    headers: {
      Authorization: `Bearer ${await tab1.evaluate(async () => {
        const r = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'X-StudySync-CSRF': '1' },
        });
        return ((await r.json()) as { accessToken: string }).accessToken;
      })}`,
    },
  });
  expect(((await history.json()) as { items: unknown[] }).items).toHaveLength(1);
  await tab1.getByTestId('end-study').click();
  await expect(phase(tab2)).toHaveAttribute('data-phase', 'NO_SESSION');
  await context.close();
});

test('E2E-11: Asia/Kolkata 23:30–00:30 → history shows 30 + 30 minutes on two days', async ({
  browser,
}) => {
  const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();
  await registerViaUi(page, 'Night Owl');

  // Fast-forward the server to the next 23:30 IST (18:00 UTC).
  const now = await advanceServerClock(page, 0);
  const target = new Date(now);
  target.setUTCHours(18, 0, 0, 0);
  if (target.getTime() <= now) target.setUTCDate(target.getUTCDate() + 1);
  await advanceServerClock(page, target.getTime() - now);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-connection', 'connected');
  await expect(page.getByTestId('today')).toBeVisible();

  await page.getByTestId('start-study').click();
  await expect(phase(page)).toHaveAttribute('data-phase', 'STUDYING');
  await advanceServerClock(page, 60 * MIN);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-connection', 'connected');
  await page.getByTestId('end-study').click();
  await expect(page.getByTestId('session-summary')).toBeVisible();

  await page.getByRole('link', { name: 'History' }).click();
  const day1 = target.toISOString().slice(0, 10); // 23:30 IST is still the same UTC date
  const day2 = new Date(target.getTime() + 86_400_000).toISOString().slice(0, 10);
  const total = async (date: string) =>
    Number(
      await page
        .locator(`[data-testid="day-row"][data-date="${date}"]`)
        .getAttribute('data-total-ms'),
    );
  await expect(page.locator(`[data-testid="day-row"][data-date="${day2}"]`)).toBeVisible();
  const [m1, m2] = [(await total(day1)) / MIN, (await total(day2)) / MIN];
  expect(m1).toBeGreaterThanOrEqual(29.9);
  expect(m1).toBeLessThanOrEqual(30);
  expect(m2).toBeGreaterThanOrEqual(30);
  expect(m2).toBeLessThanOrEqual(30.2);
  await shot(page, '04-history-midnight-split.png');
  await context.close();
});
