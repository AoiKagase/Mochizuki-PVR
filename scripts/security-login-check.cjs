// Run through TestLoginSecurityBrowser: this uses a temporary Go HTTP/database fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.STRATA_SECURITY_PLAYWRIGHT || 'playwright');

async function main() {
  const origin = process.argv[2];
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const output = process.env.STRATA_SECURITY_BROWSER_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'strata-security-'));
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/login');
    await page.locator('#username').fill('security-audit');
    await page.locator('#password').fill('audit-password');
    const login = page.waitForResponse(r => r.url() === origin + '/api/auth/login' && r.request().method() === 'POST');
    await page.locator('#submit').click();
    assert.equal((await login).status(), 204);
    await page.waitForURL(origin + '/');
    await page.locator('body').waitFor({ state: 'visible' });
    const session = (await context.cookies()).find(cookie => cookie.name === 'mochizuki_session');
    assert.ok(session && session.httpOnly && session.sameSite === 'Strict');
    const authorizedStatus = await page.evaluate(async () => (await fetch('/api/status')).status);
    assert.equal(authorizedStatus, 200);
    await page.screenshot({ path: path.join(output, 'authenticated.png'), fullPage: true });
    const failures = await page.evaluate(async () => {
      const statuses = [];
      for (let i = 0; i < 29; i++) {
        statuses.push((await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'unknown-' + i, password: 'wrong' })
        })).status);
      }
      await fetch('/api/auth/logout', { method: 'POST' });
      return statuses;
    });
    assert.deepEqual(failures, Array(29).fill(401));
    await page.goto(origin + '/login');
    await page.locator('#username').fill('security-audit');
    await page.locator('#password').fill('audit-password');
    const throttled = page.waitForResponse(r => r.url() === origin + '/api/auth/login' && r.request().method() === 'POST');
    await page.locator('#submit').click();
    const response = await throttled;
    assert.equal(response.status(), 429);
    assert.equal(response.headers()['retry-after'], '60');
    await page.locator('#error').filter({ hasText: 'ログインの試行が多すぎます' }).waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(output, 'rate-limited.png'), fullPage: true });
    assert.deepEqual(errors, []);
    const result = { loginStatus: 204, authenticatedStatus: authorizedStatus, changedUsernameFailures: failures.length, rateLimitStatus: 429, retryAfter: '60', browserErrors: errors };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, output }));
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
