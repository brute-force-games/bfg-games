import { expect, test } from '@playwright/test';

test('new game navigates to room play route', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'New Game' }).click();

  await expect(page).toHaveURL(/\/room\/room_[A-Za-z0-9_-]+\/play\?invite=[A-Z2-9]{6}$/);
  await expect(page.getByText('roomId')).toBeVisible();
});

test('tic tac toe: join, start, click move via godot stub', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Game' }).click();

  // Use the stub iframe instead of a real Godot export.
  await page.goto(page.url() + '&godot=stub');

  await page.getByRole('button', { name: 'Join game' }).click();

  // In Playwright, we only have one browser/player; still we can simulate "2 joined"
  // by opening a second tab in the same context.
  const page2 = await page.context().newPage();
  await page2.goto(page.url());
  await page2.getByRole('button', { name: 'Join game' }).click();

  // Host starts the game from the first page.
  await page.getByRole('button', { name: /Start/i }).click();

  // Iframe should be present and clickable; click top-left cell.
  const frame = page.frameLocator('iframe[title="TicTacToe (Godot)"]');
  await frame.locator('button.cell').first().click();

  // After host processes, the snapshot should update; the stub will render "X" in the first cell.
  await expect(frame.locator('button.cell').first()).toHaveText(/X|Lion|Red/);
});

