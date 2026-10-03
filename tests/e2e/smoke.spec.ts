import { expect, test } from '@playwright/test';

/**
 * The first end-to-end test in the project.  (P6-T11)
 *
 * It exists to prove the RUNNER works, not the application: before `playwright.config.ts` there was no
 * e2e test at all and `pnpm test:e2e` failed for an unrelated reason. A harness that has never executed
 * cannot tell you the app is broken.
 */

test('serves the app shell', async ({ page }) => {
  const response = await page.goto('/');
  expect(response).not.toBeNull();
  // A 500 here is a build or runtime fault; a 404 would be a routing decision, so only the first is fatal.
  expect(response?.status()).toBeLessThan(500);
});

test('renders the document with a language and a title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/.+/);
  // `lang` is the single most commonly forgotten attribute and the one that breaks every screen reader
  // pronunciation rule, so it is asserted here rather than left to a component test.
  await expect(page.locator('html')).toHaveAttribute('lang', /.+/);
});

test('reports no uncaught page errors on load', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
});
