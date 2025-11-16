// Playwright E2E smoke test (requires Playwright to be installed)
// This test loads the auth page, signs up a test user, then loads the main page
// and asserts that the Generate button exists and clicking it triggers network activity.

const { test, expect } = require('@playwright/test');

test.describe('Promptly smoke', () => {
  test('auth -> generate', async ({ page }) => {
    await page.goto('http://localhost:8000/auth.html');

    // Sign up flow
    await page.fill('#email', 'e2e+test@example.com');
    await page.fill('#password', 'password123');
    await page.click('#auth-btn');

    // Wait for redirect to /
    await page.waitForURL('http://localhost:8000/');

    // Ensure generate button is present
    const gen = await page.locator('#generate-calendar');
    await expect(gen).toBeVisible();

    // Type a niche and click generate (this will call the backend)
    await page.fill('#niche-style-input', 'vegan fitness coaches');
    await Promise.all([
      page.waitForResponse(resp => resp.url().endsWith('/api/generate-calendar') && resp.status() === 200, { timeout: 60000 }),
      gen.click(),
    ]);

    // After response, expect generated cards to appear
    await expect(page.locator('.calendar-card')).toHaveCount(30);
  });
});
