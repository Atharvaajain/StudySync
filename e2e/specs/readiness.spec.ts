/**
 * Production-readiness regressions: an invite link opened while logged out still leads into the
 * room after signing up, and the room screen explains a session that lives in another room.
 */
import { expect, test } from '@playwright/test';
import { createRoomViaUi, registerViaUi } from '../helpers/app';

test('invite link while logged out → sign up → lands in the room (F-13)', async ({ browser }) => {
  const owner = await createRoomViaUi(await browser.newContext(), 'Owner', 'Invite Room');
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/join/${owner.code}`);
  await expect(guest).toHaveURL(/\/login\?next=%2Fjoin%2F/);
  await guest.getByRole('link', { name: 'Create an account' }).click();
  await expect(guest).toHaveURL(/\/register\?next=/);
  await registerViaUi(guest, 'Guest', undefined, { navigate: false });
  await expect(guest.getByTestId('room-name')).toHaveText('Invite Room');
  await expect(guest.getByTestId('room-code')).toHaveText(owner.code);
  // ?next can't send anyone off-site.
  const other = await (await browser.newContext()).newPage();
  await other.goto('/login?next=//evil.example');
  await registerViaUi(other, 'Other', undefined, {
    navigate: false,
    path: '/register?next=//evil.example',
  });
  await expect(other).toHaveURL(/127\.0\.0\.1:\d+\/$/);
});

test('room screen explains a session that lives in another room', async ({ browser }) => {
  const a = await createRoomViaUi(await browser.newContext(), 'Ana', 'Room A');
  await a.page.getByTestId('start-study').click();
  await expect(a.page.getByTestId('timer-phase')).toHaveAttribute('data-phase', 'STUDYING');
  const b = await createRoomViaUi(await browser.newContext(), 'Ben', 'Room B');
  const roomB = b.page.url();
  await a.page.getByRole('link', { name: 'Dashboard' }).click();
  await a.page.getByTestId('room-code-input').fill(b.code);
  await a.page.getByTestId('join-room').click();
  await expect(a.page.getByTestId('error')).toContainText(
    'End your study session in the other room first.',
  );
  // Opening room B's screen directly shows the real reason, not a generic "not found".
  await a.page.goto(roomB);
  await expect(a.page.getByTestId('room-unavailable')).toContainText(
    'End your study session in the other room first.',
  );
  // A room that doesn't exist (or isn't yours) after ending the session: not-found message.
  await a.page.getByRole('link', { name: 'Back to the dashboard' }).click();
  await a.page.getByTestId('end-study').click();
  await a.page.goto(roomB);
  await expect(a.page.getByTestId('room-unavailable')).toContainText('not a member');
});
