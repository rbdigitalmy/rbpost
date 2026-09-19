import { test, expect } from '@playwright/test';
import { fromZonedTime } from 'date-fns-tz';

test('demo: create, preview, upload, save, reload, schedule, filter and delete', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('/demo/dashboard');
  await expect(page.getByRole('heading', { name: 'Welcome back, Alex 👋' })).toBeVisible();

  await page.getByRole('link', { name: 'Create new post', exact: true }).click();
  await page.getByLabel('Topic or idea').fill('Content for a local coffee shop');
  await page.getByRole('button', { name: /Generate post with AI/ }).click();
  await expect(page.locator('.thread-caption')).toContainText('coffee shop');

  await page.getByLabel('Internal title').fill('Morning coffee — test');
  await page.getByLabel('Caption', { exact: true }).fill('A fresh cup of coffee, a brand new story. What is your go-to brew today?');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3l8AAAAASUVORK5CYII=', 'base64');
  await page.getByLabel('Choose image').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByAltText('Preview visual Threads')).toBeVisible();

  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');

  await page.getByRole('link', { name: 'All Posts', exact: true }).click();
  await page.getByLabel('Search posts').fill('Morning coffee');
  await expect(page.getByRole('table')).toContainText('Morning coffee');

  await page.reload();
  await page.getByLabel('Search posts').fill('Morning coffee');
  await page.getByRole('link', { name: /Morning coffee — test A fresh/ }).click();
  await expect(page.getByLabel('Caption', { exact: true })).toHaveValue('A fresh cup of coffee, a brand new story. What is your go-to brew today?');

  await page.getByRole('button', { name: 'Schedule post', exact: true }).click();
  const date = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10) + 'T09:30';
  await page.getByLabel('Date & time').fill(date);
  await page.getByLabel('Timezone', { exact: true }).selectOption('Asia/Kuala_Lumpur');
  await page.getByRole('button', { name: 'Confirm schedule' }).click();
  await expect(page).toHaveURL(/calendar/);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('threads-ai:demo:v1')!));
  const post = stored.posts.find((p: { title: string }) => p.title === 'Morning coffee — test');
  expect(post.status).toBe('scheduled');
  expect(post.scheduled_at).toBe(fromZonedTime(date, 'Asia/Kuala_Lumpur').toISOString());

  await page.getByRole('link', { name: /All Posts \d/ }).click();
  await page.getByLabel('Search posts').fill('Morning coffee');
  await page.getByRole('button', { name: /Scheduled/ }).click();
  await expect(page.getByRole('table')).toContainText('Morning coffee');

  await page.getByRole('button', { name: 'Delete Morning coffee — test' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Delete post', exact: true }).click();
  await expect(page.getByText('No search results')).toBeVisible();
  expect(errors).toEqual([]);
});

test('threads oauth authorization page loads correctly', async ({ page }) => {
  const envText = require('fs').readFileSync('.env.local', 'utf8');
  const metaId = envText.match(/META_APP_ID=([^\r\n]+)/)?.[1]?.trim() || '';
  const redirectUri = envText.match(/THREADS_REDIRECT_URI=([^\r\n]+)/)?.[1]?.trim() || '';
  const authUrl = `https://threads.net/oauth/authorize?client_id=${metaId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=threads_basic,threads_content_publish&response_type=code&state=test_state`;

  const response = await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  expect(response?.status()).toBe(200);
  expect(page.url()).toContain('threads.com');
});

test('validation, demo publishing guard, modal focus and missing production configuration', async ({ page, request }) => {
  await page.goto('/demo/create');
  await page.getByRole('button', { name: /Generate post with AI/ }).click();
  await expect(page.locator('.form-error')).toContainText('Please enter a topic');

  await page.getByLabel('Caption', { exact: true }).fill('a'.repeat(501));
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();

  await page.getByLabel('Caption', { exact: true }).fill('Test caption.');
  await page.getByRole('button', { name: 'Publish now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Yes, publish now' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await page.getByRole('button', { name: 'Schedule post', exact: true }).click();
  await page.getByLabel('Date & time').fill('2020-01-01T09:00');
  await page.getByRole('button', { name: 'Confirm schedule' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('at least one minute');

  const csrf = await request.post('/api/posts', { data: { title: 'attack', caption: 'bad' } });
  expect(csrf.status()).toBe(403);

  const live = await request.get('/api/workspace');
  expect([401, 503]).toContain(live.status());
  expect(await live.text()).not.toContain('SUPABASE_SERVICE_ROLE_KEY');

  const cron = await request.get('/api/cron/publish');
  expect([401, 503]).toContain(cron.status());

  const webhook = await request.post('/api/webhooks/payment', { data: { type: 'checkout.session.completed' } });
  expect(webhook.status()).toBe(400);
});

test('mobile navigation, settings, calendar and landing do not overflow the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['/', '/demo/dashboard', '/demo/calendar', '/demo/create', '/demo/billing', '/signup']) {
    await page.goto(route);
    await expect(page.locator('h1:visible')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), route).toBe(true);
  }

  await page.goto('/demo/settings');
  await page.getByLabel('Name', { exact: true }).fill('Najib');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Welcome back, Najib/ })).toBeVisible();

  await page.screenshot({ path: '.local/mobile-dashboard.png', fullPage: true });
});

test('landing, login and billing routes expose real navigation and clear unconfigured states', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your ideas/ })).toBeVisible();

  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('test@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.form-error')).toContainText(/Registration is not open|Invalid login credentials/);

  await page.goto('/demo/billing');
  await expect(page.getByText('RM19')).toBeVisible();
  await page.getByRole('button', { name: 'Manage subscription', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Billing is disabled');

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/demo/dashboard');
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  await page.screenshot({ path: '.local/desktop-dashboard.png', fullPage: true });
});

test('production readiness pages, health check and security headers are available', async ({ page, request }) => {
  for (const route of ['/privacy', '/terms', '/data-deletion']) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Legal documents' })).toBeVisible();
  }

  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'ok', database: 'ok' });

  const home = await request.get('/');
  expect(home.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(home.headers()['permissions-policy']).toContain('camera=()');
});
