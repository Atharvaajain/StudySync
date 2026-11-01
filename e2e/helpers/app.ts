/** Shared E2E steps: real registration through the UI, the room screen, the test clock. */
import { randomUUID } from 'node:crypto';
import { expect, type BrowserContext, type Page } from '@playwright/test';

export const MIN = 60_000;
export const PASSWORD = 'correct horse battery staple';

export const uniqueEmail = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}@example.com`;

/** Register through the UI; ends on the dashboard, connected. */
export async function registerViaUi(
  page: Page,
  name: string,
  email: string = uniqueEmail(name),
): Promise<string> {
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('signed-in-as')).toHaveText(name);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-connection', 'connected');
  return email;
}

/** Register `name` and create a room from the dashboard; ends on the room screen. */
export async function createRoomViaUi(
  context: BrowserContext,
  name: string,
  roomName: string,
): Promise<{ page: Page; code: string }> {
  const page = await context.newPage();
  await registerViaUi(page, name);
  await page.getByTestId('room-name-input').fill(roomName);
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('room-name')).toHaveText(roomName);
  await expect(page.getByTestId('room-code')).toHaveText(/^[A-HJ-NP-Z2-9]{6}$/);
  return { page, code: await page.getByTestId('room-code').innerText() };
}

/** Join a room by code from the dashboard (registering `name` first unless a page is given). */
export async function joinRoomViaUi(
  target: BrowserContext | Page,
  name: string,
  code: string,
): Promise<Page> {
  let page: Page;
  if ('newPage' in target) {
    page = await target.newPage();
    await registerViaUi(page, name);
  } else {
    page = target;
    await page.getByRole('link', { name: 'Dashboard' }).click();
  }
  await page.getByTestId('room-code-input').fill(code.toLowerCase());
  await page.getByTestId('join-room').click();
  await expect(page.getByTestId('room-code')).toHaveText(code);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-connection', 'connected');
  return page;
}

/** Fast-forward the server clock (test mode only) and fire due deadlines. Returns server now. */
export async function advanceServerClock(page: Page, ms: number): Promise<number> {
  const res = await page.request.post('/__test__/clock', { data: { advanceMs: ms } });
  expect(res.ok()).toBe(true);
  return Date.parse(((await res.json()) as { now: string }).now);
}

/** "MM:SS" or "H:MM:SS" → seconds */
export function seconds(text: string): number {
  const parts = text.trim().split(':').map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export const elapsed = async (page: Page) => seconds(await page.getByTestId('elapsed').innerText());
