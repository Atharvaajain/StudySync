/**
 * Phase 3 (finalization) E2E: weekly / monthly charts and heatmap match the recorded study,
 * the break-end browser notification (never an automatic resume), mobile layouts without
 * horizontal scrolling (360 px), stored XSS rendered inert (SEC-8), and clear error states.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { MIN, advanceServerClock, createRoomViaUi, registerViaUi } from '../helpers/app';

const SHOTS = fileURLToPath(new URL('../../docs/phase-3/screenshots/', import.meta.url));
const CAPTURE = process.env.CAPTURE_SCREENSHOTS === '1';
if (CAPTURE) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, file: string) => {
  if (CAPTURE) await page.screenshot({ path: `${SHOTS}${file}`, fullPage: true });
};
const phase = (page: Page) => page.getByTestId('timer-phase');

test.describe.configure({ mode: 'serial' });

test('charts and heatmap show exactly the recorded study (breaks excluded)', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await registerViaUi(page, 'Charts');
  await page.getByTestId('start-study').click();
  await expect(phase(page)).toHaveAttribute('data-phase', 'STUDYING');
  await advanceServerClock(page, 40 * MIN);
  await page.getByTestId('take-break').click();
  await page.getByTestId('break-15').click();
  await advanceServerClock(page, 15 * MIN);
  await page.getByTestId('end-study').click();
  await expect(page.getByTestId('session-summary')).toBeVisible();

  await page.getByRole('link', { name: 'History' }).click();
  const sum = (selector: string, attr: string) =>
    page
      .locator(selector)
      .evaluateAll(
        (els, a) => els.reduce((s, e) => s + Number(e.getAttribute(a as string)), 0),
        attr,
      ) as Promise<number>;
  await expect.poll(() => sum('[data-testid="day-row"]', 'data-total-ms')).toBeGreaterThan(0);
  const dayTotal = await sum('[data-testid="day-row"]', 'data-total-ms');
  expect(dayTotal).toBeGreaterThanOrEqual(40 * MIN);
  expect(dayTotal).toBeLessThan(41 * MIN); // the 15-minute break never counts
  await expect.poll(() => sum('[data-testid="period-bar"]', 'data-total-ms')).toBe(dayTotal);
  await page.getByTestId('granularity-month').click();
  await expect(page.getByTestId('chart-month')).toBeVisible();
  await expect.poll(() => sum('[data-testid="heatmap-cell"]', 'data-study-ms')).toBe(dayTotal);
  await page.getByTestId('granularity-week').click();
  await shot(page, '01-history-charts.png');
  await context.close();
});

test('break-end notification: shown once when the tab is hidden; the timer never resumes by itself', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const w = window as unknown as {
      __notes: { title: string; body?: string }[];
      __hidden: boolean;
      Notification: unknown;
    };
    w.__notes = [];
    w.__hidden = false;
    class FakeNotification {
      static permission = 'default';
      static requestPermission() {
        FakeNotification.permission = 'granted';
        return Promise.resolve('granted');
      }
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        w.__notes.push({ title, ...(options?.body ? { body: options.body } : {}) });
      }
      close() {}
    }
    w.Notification = FakeNotification;
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get: () => (w.__hidden ? 'hidden' : 'visible'),
    });
  });
  const page = await context.newPage();
  await registerViaUi(page, 'Notified');
  await page.getByTestId('start-study').click();
  await page.getByTestId('take-break').click();
  await page.getByTestId('break-5').click(); // the user gesture asks for permission
  await expect(phase(page)).toHaveAttribute('data-phase', 'ON_BREAK');
  expect(
    await page.evaluate(
      () => (window as unknown as { Notification: { permission: string } }).Notification.permission,
    ),
  ).toBe('granted');
  await page.evaluate(() => {
    (window as unknown as { __hidden: boolean }).__hidden = true;
  });
  await advanceServerClock(page, 5 * MIN);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __notes: unknown[] }).__notes))
    .toEqual([
      {
        title: 'Break over — StudySync',
        body: 'Your timer is paused. Open StudySync and press Resume when you are ready.',
      },
    ]);
  await page.waitForTimeout(2_500);
  expect(
    await page.evaluate(() => (window as unknown as { __notes: unknown[] }).__notes),
  ).toHaveLength(1);
  await expect(phase(page)).toHaveAttribute('data-phase', 'BREAK_OVER'); // R5
  await page.getByTestId('end-study').click();
  await context.close();
});

test('mobile (360 px): no horizontal scrolling on any main screen', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await registerViaUi(page, 'Mobile');
  const noOverflow = async (name: string) => {
    const [scroll, client] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect([name, scroll]).toEqual([name, client]);
  };
  await page.getByTestId('start-study').click();
  await page.getByTestId('task-title-input').fill('Read chapter 4');
  await page.getByTestId('task-add').click();
  await noOverflow('dashboard');
  await shot(page, '02-mobile-dashboard.png');
  await page.getByTestId('end-study').click();
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByTestId('room-name-input').fill('Mobile Room');
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('room-code')).toBeVisible();
  await noOverflow('room');
  await shot(page, '03-mobile-room.png');
  for (const [link, name] of [
    ['History', 'history'],
    ['Settings', 'settings'],
  ] as const) {
    await page.getByRole('link', { name: link }).click();
    await expect(page.getByRole('heading', { name: link })).toBeVisible();
    await page.waitForTimeout(300);
    await noOverflow(name);
  }
  await shot(page, '04-mobile-settings.png');
  await context.close();
});

test('SEC-8: names are rendered as text (stored XSS is inert); unknown rooms show a clear message', async ({
  browser,
}) => {
  const context = await browser.newContext();
  let dialogs = 0;
  const { page } = await createRoomViaUi(context, 'Mallory', '<img src=x onerror=alert(1)>');
  page.on('dialog', (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await expect(page.getByTestId('room-name')).toHaveText('<img src=x onerror=alert(1)>');
  await page.getByTestId('task-title-input').fill('<script>alert(2)</script>');
  await page.getByTestId('task-add').click();
  await expect(page.locator('[data-testid="task-row"]')).toContainText('<script>alert(2)</script>');
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  await page.goto('/rooms/00000000-0000-4000-8000-000000000000');
  await expect(page.getByTestId('room-unavailable')).toContainText('not a member');
  expect(dialogs).toBe(0);
  await context.close();
});
