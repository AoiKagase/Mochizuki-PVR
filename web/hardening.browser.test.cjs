"use strict";

// MOCHIZUKI_AUDIT_PLAYWRIGHT may point to an installed Playwright package.
const { chromium } = require(process.env.MOCHIZUKI_AUDIT_PLAYWRIGHT || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");
let browser, server, baseURL;
const captures = process.env.MOCHIZUKI_AUDIT_OUTPUT;
const results = [];
const now = Date.now();
const channel = { id: "audit-gr", name: "監査チャンネル", type: "GR", channel: "27", sid: 101 };
const program = { id: "audit-program", title: "監査用番組", detail: "架空の番組です", start: now - 900000, end: now + 900000, seconds: 1800, category: "news", channel };

before(async () => {
  server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://localhost").pathname;
    if (name.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      const key = name.slice(5);
      let data = [];
      if (key === "status") data = { operator: { alive: true }, scheduler: { alive: true } };
      if (key === "schedule") data = [{ channel, programs: [program] }];
      if (key === "schedule/broadcasting") data = [program];
      if (key === "search") data = { items: [program], total: 1, categories: ["news"], channels: [channel] };
      if (key === "recorded" || key === "recorded/recent") data = [program];
      if (key === "config") data = JSON.parse(fs.readFileSync(path.join(__dirname, "../config.sample.json")));
      if (key === "auth/session") data = { authenticated: false, authenticationEnabled: false };
      res.end(JSON.stringify(data));
      return;
    }
    const relative = name === "/" ? "index.html" : name === "/login" ? "login.html" : name.slice(1);
    const file = path.resolve(__dirname, relative);
    if (!file.startsWith(__dirname + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseURL = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true, args: ["--log-file=" + path.join(os.tmpdir(), "mochizuki-hardening-chromium.log")] });
});

after(async () => {
  if (captures) {
    fs.mkdirSync(captures, { recursive: true });
    fs.writeFileSync(path.join(captures, "measurements.json"), JSON.stringify(results, null, 2));
  }
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function pageFor(options = {}) {
  const context = await browser.newContext(options);
  context.setDefaultTimeout(2500);
  const page = await context.newPage();
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.load = function () {};
  });
  return { page, context };
}

async function loaded(page, route = "dashboard") {
  await page.goto(baseURL + "/#" + route);
  await page.locator("#refreshButton").waitFor({ state: "attached" });
  await page.waitForFunction(() => !document.querySelector("#refreshButton").disabled);
  await page.waitForTimeout(100);
}

async function capture(page, name) {
  if (captures) {
    await page.waitForTimeout(250);
    fs.mkdirSync(captures, { recursive: true });
    // Capture through Playwright's public CDP API: the bundled screenshot
    // helper overrides pointer media, which would invalidate touch measurements.
    const session = await page.context().newCDPSession(page);
    const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    const shot = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
    fs.writeFileSync(path.join(captures, name + ".png"), Buffer.from(shot.data, "base64"));
    await session.detach();
  }
}

test("Mochizuki branding and legacy browser preferences", async () => {
  const { page, context } = await pageFor();
  try {
    const preferences = {
      scheduleHiddenChannels: '["hidden-channel"]',
      listFilters: '{"recorded":{"keyword":"existing"}}',
      recordedPageSize: '100',
      recordedViewMode: 'list',
      scheduleZoomLevel: 'detail'
    };
    await page.addInitScript(values => {
      for (const [name, value] of Object.entries(values)) localStorage.setItem('strata-pvr.' + name, value);
      localStorage.setItem('mochizuki.recordedPageSize', '200');
    }, preferences);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await loaded(page, 'settings');
    assert.equal(await page.title(), 'Mochizuki PVR WUI');
    assert.equal(await page.locator('h1').textContent(), 'Mochizuki PVR');
    await page.locator('#mochizukiConfigPanel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#mochizukiMirakurunURL').inputValue(), 'http://127.0.0.1:40772');
    const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    for (const [name, value] of Object.entries(preferences)) {
      assert.equal(stored['mochizuki.' + name], name === 'recordedPageSize' ? '200' : value);
      assert.equal(stored['strata-pvr.' + name], value);
    }
    await capture(page, 'mochizuki-settings');
    await page.goto(baseURL + '/login');
    assert.match(await page.title(), /Mochizuki PVR/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("Mochizuki starts when browser storage is unavailable", async () => {
  const { page, context } = await pageFor();
  try {
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('disabled', 'SecurityError'); } }));
    await loaded(page);
    assert.equal(await page.locator('h1').textContent(), 'Mochizuki PVR');
  } finally { await context.close(); }
});

test("theme toggle overrides the system palette and survives navigation and reload", async () => {
  const { page, context } = await pageFor({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await loaded(page, "schedule");
    const toggle = page.getByRole("button", { name: "ダークモードに切り替え", exact: true });
    await toggle.click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await page.locator("html").evaluate(e => getComputedStyle(e).colorScheme), "dark");
    assert.equal(await page.locator(".schedule-card").first().evaluate(e => getComputedStyle(e).backgroundColor), "rgb(25, 25, 27)");
    assert.equal(await page.locator("#themeToggleButton use").getAttribute("href"), "#icon-sun");
    await capture(page, "theme-desktop-dark");
    await page.getByRole("link", { name: "ダッシュボード", exact: true }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.reload();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.getByRole("button", { name: "ライトモードに切り替え", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    assert.equal(await page.locator("html").evaluate(e => getComputedStyle(e).colorScheme), "light");
    assert.equal(await page.evaluate(() => localStorage.getItem("mochizuki.theme")), "light");
    await loaded(page, "schedule");
    assert.notEqual(await page.locator(".schedule-card").first().evaluate(e => getComputedStyle(e).backgroundColor), "rgb(25, 25, 27)");
    await capture(page, "theme-desktop-light");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("theme follows system changes until chosen and works without browser storage", async () => {
  const { page, context } = await pageFor({ colorScheme: "dark" });
  try {
    await page.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new DOMException("disabled", "SecurityError"); } }));
    await loaded(page);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await page.getByRole("button", { name: "ダークモードに切り替え", exact: true }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.emulateMedia({ colorScheme: "light" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  } finally { await context.close(); }
});

test("theme toggle stays beside settings with a touch target on narrow screens", async () => {
  const { page, context } = await pageFor({ viewport: { width: 320, height: 900 }, isMobile: true, hasTouch: true });
  try {
    for (const route of ["dashboard", "schedule"]) {
      await loaded(page, route);
      const toggle = page.locator("#themeToggleButton");
      await toggle.waitFor({ state: "visible" });
      const buttonBox = await toggle.boundingBox();
      const settingsBox = await page.locator(".management-menu > summary").boundingBox();
      assert.ok(buttonBox.width >= 44 && buttonBox.height >= 44, JSON.stringify(buttonBox));
      assert.ok(Math.abs(buttonBox.y - settingsBox.y) <= 4 && buttonBox.x >= settingsBox.x + settingsBox.width, JSON.stringify({ buttonBox, settingsBox }));
      assert.ok(buttonBox.x + buttonBox.width <= 320);
      await toggle.click();
      await capture(page, "theme-mobile-" + route);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  } finally { await context.close(); }
});

test("favicon links and image load on dashboard and login", async () => {
  const { page, context } = await pageFor();
  try {
    for (const route of ['/#dashboard', '/login']) {
      await page.goto(baseURL + route);
      assert.equal(await page.locator('link[rel="icon"][href="/favicon.ico"]').count(), 1);
      assert.equal(await page.locator('link[rel="icon"][href="/favicon.png"]').count(), 1);
      const size = await page.evaluate(() => new Promise((resolve, reject) => {
        const icon = new Image();
        icon.onload = () => resolve([icon.naturalWidth, icon.naturalHeight]);
        icon.onerror = () => reject(new Error('favicon failed to decode'));
        icon.src = '/favicon.png';
      }));
      assert.deepEqual(size, [256, 256]);
    }
  } finally { await context.close(); }
});

test("layout and contrast: desktop and touch, light and dark", async t => {
  for (const width of [1440, 375, 320]) for (const colorScheme of ["light", "dark"]) {
    await t.test(width + " " + colorScheme, async () => {
      const { page, context } = await pageFor({ viewport: { width, height: 900 }, colorScheme, isMobile: width < 1000, hasTouch: width < 1000 });
      try {
        await loaded(page);
        const contrast = async () => page.locator("#refreshButton").evaluate(e => {
          const s = getComputedStyle(e), ctx = document.createElement("canvas").getContext("2d");
          const lum = c => { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const v = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return v[0] * .2126 + v[1] * .7152 + v[2] * .0722; };
          const fg = lum(s.color), bg = lum(s.backgroundColor);
          return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
        });
        await page.mouse.move(0, 0);
        const normal = await contrast();
        await page.locator("#refreshButton").hover();
        const hover = await contrast();
        await page.mouse.move(0, 0);
        await page.locator("#refreshButton").focus();
        const focus = await contrast();
        results.push({ width, colorScheme, normal, hover, focus });
        assert.ok(Math.min(normal, hover, focus) >= 4.5, JSON.stringify({ normal, hover, focus }));
        await loaded(page, "settings");
        await page.locator("#mochizukiMP4VideoEncoder").waitFor({ state: "visible" });
        const overflow = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        results.push({ width, colorScheme, route: "settings", ...overflow });
        assert.ok(overflow.scroll <= width, JSON.stringify(overflow));
        await page.locator("#mochizukiMP4VideoEncoder").evaluate(e => { e.innerHTML = ""; e.add(new Option("非常に長いエンコーダー名🖥️".repeat(15), "long")); });
        const longOptionScroll = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(longOptionScroll <= width, "long option overflow: " + longOptionScroll);
        await loaded(page, "search");
        if (width < 1000) {
          const targets = await page.locator(".pagination-buttons button").evaluateAll(es => es.filter(e => e.getBoundingClientRect().width).map(e => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
          assert.ok(targets.length >= 8);
          const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
          assert.ok(targets.every(e => e.w >= 44 && e.h >= 44), JSON.stringify({ coarse, targets }));
          results.push({ width, colorScheme, route: "search", targets });
        }
        await page.goto(baseURL + "/login");
        const login = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(login.scroll <= width, JSON.stringify(login));
        results.push({ width, colorScheme, route: "login", ...login });
        await capture(page, width + "-" + colorScheme + "-login");
        // Capture after all measurements: detaching a CDP session in this
        // Chromium build resets pointer emulation to the host's mouse class.
        if (captures) {
          await loaded(page, "settings");
          await capture(page, width + "-" + colorScheme + "-settings");
          await loaded(page);
          await capture(page, width + "-" + colorScheme + "-dashboard");
        }
      } finally { await context.close(); }
    });
  }
});

test("schedule header fits every breakpoint and restores ordinary navigation", async t => {
  for (const width of [320, 375, 768, 1023, 1024, 1440, 1920]) for (const colorScheme of ["light", "dark"]) await t.test(width + " " + colorScheme, async () => {
    const { page, context } = await pageFor({ viewport: { width, height: 900 }, colorScheme, hasTouch: width < 1024, isMobile: width < 1024 });
    try {
      const manyChannels = Array.from({ length: 20 }, (_, i) => {
        const entry = { ...channel, id: "wide-" + i, name: "長いチャンネル名を含む放送局 " + (i + 1) };
        return { channel: entry, programs: [{ ...program, id: "wide-program-" + i, channel: entry }] };
      });
      await page.route("**/api/schedule", route => route.fulfill({ json: manyChannels }));
      await loaded(page, "schedule");
      await page.waitForFunction(() => document.querySelectorAll(".schedule-card").length > 0);
      const geometry = await page.evaluate(() => {
        const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
        const nav = document.querySelector(".main-nav").getBoundingClientRect(), guide = document.querySelector(".schedule-guide-scroll").getBoundingClientRect();
        const filter = document.querySelector("#scheduleFilterButton").getBoundingClientRect(), refresh = document.querySelector("#scheduleRefreshButton").getBoundingClientRect();
        return { width: innerWidth, scroll: document.documentElement.scrollWidth, primary: rect("mainNavPrimary"), toolbar: rect("scheduleToolbar"), filterRight: filter.right, refreshLeft: refresh.left, drawerRight: document.querySelector("#mainNavDrawer").getBoundingClientRect().right, nav: nav.height, guideTop: guide.top, guideBottom: guide.bottom, dayVisible: document.querySelector("#scheduleDay").getBoundingClientRect().width > 0, conflictHidden: document.querySelector("#scheduleConflictSummary").hidden, logoutInMenu: Boolean(document.querySelector(".management-menu-list #logoutButton")), channelHeight: document.querySelector(".schedule-channel-head").getBoundingClientRect().height, columnWidth: document.querySelector(".schedule-channel-head").getBoundingClientRect().width };
      });
      assert.equal(geometry.scroll, width, JSON.stringify(geometry));
      assert.equal(geometry.primary.height, 48);
      assert.equal(geometry.toolbar.height, 48);
      assert.ok(geometry.filterRight <= geometry.refreshLeft, JSON.stringify(geometry));
      assert.ok(geometry.toolbar.top >= geometry.primary.bottom);
      const expectedGuideBottom = width <= 760 ? 820 : 900; // mobile controls have their own bottom row
      assert.ok(Math.abs(geometry.guideBottom - expectedGuideBottom) <= 1, JSON.stringify(geometry));
      assert.equal(geometry.channelHeight, 52);
      assert.ok(geometry.columnWidth >= 192);
      assert.ok(geometry.dayVisible && geometry.conflictHidden && geometry.logoutInMenu);
      assert.equal(await page.locator("#scheduleType").isVisible(), width >= 1024);
      if (width < 1024) {
        assert.ok(geometry.drawerRight <= 1, "closed navigation obscures the guide: " + JSON.stringify(geometry));
        const targets = await page.locator("#scheduleToolbar button, #scheduleToolbar select, .schedule-channel-head button").evaluateAll(es => es.filter(e => e.getBoundingClientRect().width).map(e => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
        assert.ok(targets.every(e => e.w >= 44 && e.h >= 44), JSON.stringify(targets));
        await page.locator("#scheduleMenuButton").click();
      }
      await page.locator('a[data-view-link="dashboard"]').click();
      await page.locator('[data-view="dashboard"]').waitFor({ state: "visible" });
      assert.equal(await page.locator("#scheduleToolbar").isVisible(), false);
      assert.equal(await page.locator(".main-nav-primary > #logoutButton").count(), 1);
      assert.equal(await page.locator("#mainNavDrawer").evaluate(e => e.inert), false);
    } finally { await context.close(); }
  });
});

test("guide defaults to 24 hours across midnight and retains explicit dates", async () => {
  const { page, context } = await pageFor({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Tokyo" });
  try {
    const fixedNow = Date.parse("2026-11-13T23:30:00+09:00");
    await page.clock.install({ time: fixedNow });
    const today = { ...program, id: "today", title: "今日の番組", start: fixedNow - 1800000, end: fixedNow + 900000 };
    const tomorrow = { ...program, id: "tomorrow", title: "明日の番組", start: fixedNow + 1800000, end: fixedNow + 3600000 };
    const nearEnd = { ...program, id: "near-end", title: "24時間以内", start: fixedNow + 82800000, end: fixedNow + 84600000 };
    const beyond = { ...program, id: "beyond", title: "24時間より後", start: fixedNow + 87300000, end: fixedNow + 88200000 };
    let programs = [today, tomorrow, nearEnd, beyond];
    await page.route("**/api/schedule", route => route.fulfill({ json: [{ channel, programs }] }));
    await loaded(page, "schedule");
    const day = page.locator("#scheduleDay");
    assert.equal(await day.inputValue(), "");
    assert.equal(await day.locator("option").first().textContent(), "24時間");
    assert.deepEqual(await day.locator("option").evaluateAll(options => options.map(option => option.value)), ["", "2026-11-13", "2026-11-14"]);
    assert.equal(await page.locator(".schedule-list-alternative summary").textContent(), "番組一覧（3件）");
    await day.selectOption("2026-11-13");
    assert.equal(await page.locator(".schedule-card").count(), 1);
    assert.match(await page.locator(".schedule-card").textContent(), /今日の番組/);
    await day.selectOption("2026-11-14");
    assert.equal(await page.locator(".schedule-list-alternative summary").textContent(), "番組一覧（3件）");
    await page.locator("#scheduleRefreshButton").click();
    assert.equal(await day.inputValue(), "2026-11-14");
    await page.locator("#scheduleFilterButton").click();
    await page.locator("#scheduleResetFilters").click();
    assert.equal(await day.inputValue(), "");
    assert.equal(await page.locator("#scheduleWindow").inputValue(), "day");
    assert.equal(await page.locator(".schedule-list-alternative summary").textContent(), "番組一覧（3件）");
    await page.keyboard.press("Escape");
    await day.focus();
    await capture(page, "guide-24hours-desktop");
    await page.locator("#scheduleFilterButton").click();
    await page.locator("#scheduleWindow").selectOption("three-days");
    assert.equal(await day.locator("option").first().textContent(), "72時間");
    assert.equal(await page.locator(".schedule-list-alternative summary").textContent(), "番組一覧（4件）");
    await page.locator("#scheduleWindow").selectOption("all");
    assert.equal(await day.locator("option").first().textContent(), "今後すべて");
    await page.locator("#scheduleResetFilters").click();
    await day.selectOption("2026-11-14");
    programs = [today];
    await page.locator("#scheduleRefreshButton").click();
    await page.waitForFunction(() => document.querySelector("#scheduleDay").value === "");
  } finally { await context.close(); }
});

test("guide keeps 24 hours selected when no programs exist in that window", async () => {
  const { page, context } = await pageFor({ viewport: { width: 375, height: 900 }, timezoneId: "Asia/Tokyo", isMobile: true, hasTouch: true });
  try {
    const fixedNow = Date.parse("2026-11-13T00:05:00+09:00");
    await page.clock.install({ time: fixedNow });
    let programs = [{ ...program, id: "tomorrow", start: fixedNow + 90000000, end: fixedNow + 91800000 }];
    await page.route("**/api/schedule", route => route.fulfill({ json: [{ channel, programs }] }));
    await loaded(page, "schedule");
    assert.equal(await page.locator("#scheduleDay").inputValue(), "");
    assert.equal(await page.locator("#scheduleDay option").first().textContent(), "24時間");
    assert.equal(await page.locator(".schedule-card").count(), 0);
    assert.match(await page.locator("#scheduleList").textContent(), /条件に一致する番組はありません/);
    await capture(page, "guide-24hours-mobile-empty");
    programs = [];
    await page.locator("#scheduleRefreshButton").click();
    await page.waitForFunction(() => document.querySelector("#scheduleDay").options.length === 1);
    assert.equal(await page.locator("#scheduleDay").inputValue(), "");
  } finally { await context.close(); }
});

test("schedule panels are exclusive, keyboard accessible and retain filter state across resize", async () => {
  const { page, context } = await pageFor({ viewport: { width: 1440, height: 900 } });
  try {
    await loaded(page, "schedule");
    await page.locator("#scheduleFilterButton").click();
    await page.locator("#scheduleGenre").selectOption("news");
    assert.match(await page.locator("#scheduleFilterButton").textContent(), /絞り込み（2）/); // genre + default24-hour range
    await page.locator("#scheduleHiddenChannel").selectOption(channel.id);
    await page.locator("#scheduleHideChannelButton").click();
    assert.match(await page.locator("#scheduleFilterButton").textContent(), /絞り込み（3）/);
    await page.locator(".management-menu > summary").click();
    assert.equal(await page.locator("#scheduleNavControls").isVisible(), false);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".management-menu").evaluate(e => e.open), false);
    assert.equal(await page.locator(".management-menu > summary").evaluate(e => e === document.activeElement), true);
    await page.setViewportSize({ width: 768, height: 900 });
    await page.locator("#scheduleFilterButton").click();
    await page.locator("#scheduleType").selectOption("GR");
    assert.equal(await page.locator("#scheduleGenre").inputValue(), "news");
    await page.locator("#scheduleMenuButton").click();
    assert.equal(await page.locator("#scheduleNavControls").isVisible(), false);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#mainNavDrawer").evaluate(e => e.inert), true);
    await page.locator("#scheduleFilterButton").click();
    await page.locator("#scheduleResetFilters").click();
    assert.equal(await page.locator("#scheduleGenre").inputValue(), "");
    assert.equal(await page.locator("#scheduleWindow").inputValue(), "day");
    assert.equal(await page.locator("#scheduleFilterButton").textContent(), "絞り込み（1）");
    await page.locator("#scheduleGenre").focus();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#scheduleFilterButton").evaluate(e => e === document.activeElement), true);
    await page.locator("#scheduleFilterButton").click();
    await page.locator("#scheduleType").focus();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => !document.querySelector("#scheduleFilterButton").matches('[aria-expanded="true"]'));
    assert.equal(await page.locator("#scheduleType").isVisible(), true);
    assert.equal(await page.locator("#scheduleType").count(), 1);
    await page.locator("#scheduleFilterButton").click();
    await page.locator(".schedule-card").first().click();
    assert.equal(await page.locator("#scheduleNavControls").isVisible(), false);
  } finally { await context.close(); }
});

test("schedule refresh reconciles vanished filters before counting and rendering", async () => {
  const { page, context } = await pageFor({ viewport: { width: 1440, height: 900 } });
  try {
    await loaded(page, "schedule");
    await page.locator("#scheduleChannel").selectOption(channel.id);
    await page.locator("#scheduleType").selectOption("GR");
    await page.locator("#scheduleFilterButton").click();
    await page.locator("#scheduleGenre").selectOption("news");
    assert.match(await page.locator("#scheduleFilterButton").textContent(), /（4）/);
    const replacement = { ...channel, id: "replacement", name: "更新後のチャンネル" };
    await page.route("**/api/schedule", route => route.fulfill({ json: [{ channel: replacement, programs: [{ ...program, id: "replacement-program", category: "movie", channel: replacement }] }] }));
    await page.locator("#scheduleRefreshButton").click();
    await page.waitForFunction(() => !document.querySelector("#scheduleRefreshButton").disabled);
    assert.equal(await page.locator("#scheduleChannel").inputValue(), "");
    assert.equal(await page.locator("#scheduleGenre").inputValue(), "");
    assert.match(await page.locator("#scheduleFilterButton").textContent(), /（2）/);
    await page.locator('.schedule-card[data-program-id="replacement-program"]').waitFor({ state: "visible" });
  } finally { await context.close(); }
});

test("guide watch stays inline and channel names still search", async () => {
  const { page, context } = await pageFor({ viewport: { width: 1440, height: 900 } });
  try {
    await loaded(page, "schedule");
    const head = page.locator(".schedule-channel-head").first();
    const watch = head.getByRole("button", { name: "視聴", exact: true });
    const aligned = await head.evaluate(e => {
      const n = e.querySelector(".channel-link").getBoundingClientRect(), b = e.querySelector(".channel-actions button").getBoundingClientRect();
      return n.right <= b.left && Math.abs((n.top + n.bottom) / 2 - (b.top + b.bottom) / 2) <= 1;
    });
    assert.ok(aligned);
    await watch.click();
    await page.locator("#playerDialog").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await head.locator(".channel-link").click();
    await page.waitForURL("**/#search");
    await page.waitForFunction(id => document.querySelector("#searchChannelID").value === id, channel.id);
    assert.equal(await page.locator("#searchChannelID").inputValue(), channel.id);
  } finally { await context.close(); }
});

test("guide logos load directly and after navigation without hidden or offscreen images blocking the queue", async t => {
  for (const width of [375, 1440]) await t.test(String(width), async () => {
    const { page, context } = await pageFor({ viewport: { width, height: 900 }, colorScheme: 'dark' });
    try {
      const channels = Array.from({ length: 18 }, (_, i) => ({ ...channel, id: 'logo-' + i, name: '局ロゴ確認' + i, hasLogoData: true }));
      const entries = channels.map(c => ({ channel: c, programs: [{ ...program, id: c.id + '-program', channel: c }] }));
      await page.route('**/api/schedule', route => route.fulfill({ json: entries }));
      await page.route('**/api/schedule/broadcasting', route => route.fulfill({ json: entries.map(e => e.programs[0]) }));
      const requests = [];
      const png = fs.readFileSync(path.join(__dirname, 'favicon.png'));
      await page.route('**/api/channel/*/logo', route => { requests.push(route.request().url()); return route.fulfill({ contentType: 'image/png', body: png }); });
      await loaded(page, 'schedule');
      await page.waitForFunction(() => {
        const image = document.querySelector('.schedule-channel-logo');
        return image && image.complete && image.naturalWidth > 0;
      });
      assert.ok(requests.length < channels.length, 'offscreen and hidden logos should not start requests');
      const image = page.locator('.schedule-channel-logo').first();
      const geometry = await image.evaluate(e => ({ width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height, heading: e.closest('.schedule-channel-head').getBoundingClientRect().height }));
      assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.heading === 52, JSON.stringify(geometry));
      if (width >= 1024) {
        await page.locator('.schedule-guide-scroll').evaluate(e => { e.scrollLeft = e.scrollWidth; });
        await page.waitForFunction(() => {
          const image = document.querySelector('.schedule-channel-logo[data-channel-id="logo-17"]');
          return image && image.complete && image.naturalWidth > 0;
        });
      } else await page.locator('#scheduleMenuButton').click();
      await page.locator('a[data-view-link="dashboard"]').click();
      await page.locator('.live-channel-logo').first().scrollIntoViewIfNeeded();
      await page.waitForFunction(() => [...document.querySelectorAll('.live-channel-logo')].some(e => e.complete && e.naturalWidth > 0));
      await page.locator('a[data-view-link="schedule"]').click();
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('.schedule-channel-logo')];
        return images.some(e => e.getBoundingClientRect().left < innerWidth && e.getBoundingClientRect().right > 0 && e.complete && e.naturalWidth > 0);
      });
    } finally { await context.close(); }
  });
});

test("a slow logo does not block other logos and parallel loads settle independently", async () => {
  const { page, context } = await pageFor({ viewport: { width: 1440, height: 900 } });
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let active = 0, peak = 0;
  try {
    const channels = Array.from({ length: 8 }, (_, i) => ({ ...channel, id: "parallel-" + i, name: "並列確認" + i, hasLogoData: true }));
    await page.route("**/api/schedule", route => route.fulfill({ json: channels.map(c => ({ channel: c, programs: [{ ...program, id: c.id, channel: c }] })) }));
    const png = fs.readFileSync(path.join(__dirname, "favicon.png"));
    await page.route("**/api/channel/*/logo", async route => {
      active++;
      peak = Math.max(peak, active);
      try {
        if (route.request().url().endsWith("/parallel-0/logo")) await firstGate;
        else await new Promise(resolve => setTimeout(resolve, 100));
        if (route.request().url().endsWith("/parallel-2/logo")) await route.abort("failed");
        else await route.fulfill({ contentType: "image/png", body: png });
      } finally { active--; }
    });
    await loaded(page, "schedule");
    await page.waitForFunction(() => {
      const image = document.querySelector('.schedule-channel-logo[data-channel-id="parallel-1"]');
      return image && image.complete && image.naturalWidth > 0 && !image.classList.contains("is-loading");
    }, null, { timeout: 1500 });
    assert.ok(peak > 1 && peak <= 4, "observed parallel loads: " + peak);
    releaseFirst();
    await page.waitForFunction(() => [...document.querySelectorAll(".schedule-channel-logo")].every(image => !image.classList.contains("is-loading")));
    const states = await page.locator(".schedule-channel-logo").evaluateAll(images => images.map(image => ({ id: image.dataset.channelId, loaded: image.complete && image.naturalWidth > 0, unavailable: image.classList.contains("is-unavailable") })));
    for (const image of states) {
      assert.equal(image.unavailable, image.id === "parallel-2", JSON.stringify(image));
      assert.equal(image.loaded, image.id !== "parallel-2", JSON.stringify(image));
    }
  } finally {
    releaseFirst();
    await context.close();
  }
});

test("graphite guide preserves genre strips, status names and readable text", async () => {
  const { page, context } = await pageFor({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  try {
    const next = { ...program, id: "movie", category: "movie", start: program.end, end: program.end + 1800000 };
    await page.route("**/api/schedule", route => route.fulfill({ json: [{ channel, programs: [program, next] }] }));
    await loaded(page, "schedule");
    await page.waitForFunction(() => document.querySelectorAll(".schedule-card").length === 2);
    const colors = await page.locator(".schedule-card").evaluateAll(es => es.map(e => ({ background: getComputedStyle(e).backgroundColor, stripe: getComputedStyle(e, "::before").backgroundColor, stripeWidth: getComputedStyle(e, "::before").width })));
    assert.equal(colors[0].background, "rgb(25, 25, 27)");
    assert.equal(colors[0].background, colors[1].background);
    assert.notEqual(colors[0].stripe, colors[1].stripe);
    assert.equal(colors[0].stripeWidth, "2px");
    const measureGuideContrast = () => page.evaluate(() => {
      const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
      const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
      const background = element => {
        const chain = []; for (let e = element; e; e = e.parentElement) chain.push(e);
        return chain.reverse().reduce((base, e) => { const c = rgba(getComputedStyle(e).backgroundColor), a = c[3] / 255; return base.map((v, i) => c[i] * a + v * (1 - a)); }, [0, 0, 0]);
      };
      const luminance = color => { const v = color.slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return v[0] * .2126 + v[1] * .7152 + v[2] * .0722; };
      const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const elements = [...document.querySelectorAll('.main-nav a, .schedule-field span, .schedule-field select, #scheduleFilterButton, #scheduleOperatorStatus, .schedule-card strong, .schedule-card-time, .schedule-card-meta')].filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().height);
      const text = elements.map(e => ({ name: e.id || e.className, ratio: ratio(luminance(rgba(getComputedStyle(e).color)), luminance(background(e))) }));
      const input = document.querySelector("#scheduleDay");
      const border = ratio(luminance(rgba(getComputedStyle(input).borderColor)), luminance(background(input)));
      const card = document.querySelector(".schedule-card");card.focus();
      const focus = ratio(luminance(rgba(getComputedStyle(card).outlineColor)), luminance(background(card)));
      return { text, border, focus };
    });
    const measured = await measureGuideContrast();
    assert.ok(measured.text.every(e => e.ratio >= 4.5), JSON.stringify(measured));
    assert.ok(measured.border >= 3 && measured.focus >= 3, JSON.stringify(measured));
    results.push({ guideContrast: measured });
    await page.locator("#scheduleFilterButton").hover();
    const hover = await measureGuideContrast();
    assert.ok(hover.text.every(e => e.ratio >= 4.5), JSON.stringify(hover));
    await page.route("**/api/status", route => route.fulfill({ json: { operator: { alive: false }, scheduler: { alive: true } } }));
    await page.locator("#scheduleRefreshButton").click();
    await page.waitForFunction(() => document.querySelector("#scheduleOperatorStatus").textContent.includes("停止中"));
    assert.equal(await page.locator("#scheduleOperatorStatus").isVisible(), true);
    await page.route("**/api/reserves", route => route.fulfill({ json: [{ ...next, isConflict: true }] }));
    await page.locator("#scheduleRefreshButton").click();
    await page.locator("#scheduleConflictSummary").waitFor({ state: "visible" });
    assert.match(await page.locator("#scheduleConflictSummary").textContent(), /競合 1/);
    for (const state of ["recording", "reserved", "skip"]) {
      await page.route("**/api/recording", route => route.fulfill({ json: state === "recording" ? [next] : [] }));
      await page.route("**/api/reserves", route => route.fulfill({ json: state === "recording" ? [] : [{ ...next, isSkip: state === "skip" }] }));
      await page.locator("#scheduleRefreshButton").click();
      await page.waitForFunction(() => !document.querySelector("#scheduleRefreshButton").disabled);
      const card = page.locator('.schedule-card[data-program-id="movie"]');
      assert.match(await card.getAttribute("aria-label"), state === "recording" ? /録画中/ : state === "skip" ? /スキップ/ : /予約/);
      assert.equal(await card.evaluate(e => getComputedStyle(e, "::before").width), "2px");
    }
    await page.route("**/api/status", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"運用状態を取得できませんでした"}' }));
    await page.locator("#scheduleRefreshButton").click();
    await page.waitForFunction(() => document.querySelector("#scheduleOperatorStatus").textContent.includes("通信エラー"));
    await page.locator("#scheduleOperatorStatus").click();
    await page.locator("#scheduleOperationalDetail").waitFor({ state: "visible" });
    assert.ok((await page.locator("#scheduleOperationalDetail").textContent()).length > 0);
  } finally { await context.close(); }
});

test("mobile header keeps the brand and long operational notices readable", async () => {
  for (const width of [320, 375]) {
    const { page, context } = await pageFor({ viewport: { width, height: 812 }, isMobile: true, hasTouch: true });
    try {
      await loaded(page);
      for (const message of [
        "オペレータが停止中です。録画を開始するには mochizuki run operator を起動してください",
        "局ロゴキャッシュをクリアしました（123件）"
      ]) {
        const layout = await page.evaluate(message => {
          const badge = document.querySelector("#statusBadge");
          badge.textContent = message;
          const a = document.querySelector(".title-brand").getBoundingClientRect();
          const b = badge.getBoundingClientRect();
          return { width: innerWidth, scroll: document.documentElement.scrollWidth, brandWidth: a.width, overlap: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top, clipped: badge.scrollWidth > badge.clientWidth + 1, text: badge.textContent };
        }, message);
        assert.equal(layout.scroll, width, JSON.stringify(layout));
        assert.ok(layout.brandWidth > 100 && !layout.overlap && !layout.clipped, JSON.stringify(layout));
        assert.equal(layout.text, message);
      }
    } finally { await context.close(); }
  }
});

test("guide prioritizes readable titles at every zoom without changing program times", async t => {
  for (const colorScheme of ["light", "dark"]) await t.test(colorScheme, async () => {
    const { page, context } = await pageFor({ viewport: { width: 1440, height: 900 }, colorScheme });
    try {
      let start = now + 60000;
      const programs = [1, 3, 5, 10, 15, 30, 60].map(minutes => {
        const item = { ...program, id: "guide-" + minutes, title: minutes + "分番組の見切れを確認", start, end: start + minutes * 60000, seconds: minutes * 60 };
        start = item.end;
        return item;
      });
      await page.route("**/api/schedule", route => route.fulfill({ json: [{ channel, programs }] }));
      await page.route("**/api/recording", route => route.fulfill({ json: [programs[5]] }));
      await page.route("**/api/reserves", route => route.fulfill({ json: [programs[4]] }));
      await page.addInitScript(() => localStorage.setItem("mochizuki.scheduleZoomLevel", "wide"));
      await loaded(page, "schedule");
      for (const zoom of ["wide", "standard", "detail", "precise"]) {
        await page.locator('.schedule-guide-grid[data-schedule-zoom="' + zoom + '"]').waitFor();
        // Lanes are virtualized and populated after the guide shell renders.
        await page.waitForFunction(() => document.querySelectorAll(".schedule-card").length === 7);
        const geometry = await page.locator(".schedule-card").evaluateAll(cards => cards.map(card => {
          const box = card.getBoundingClientRect();
          const parts = [...card.querySelectorAll(".schedule-card-time, .schedule-card-state, strong, .schedule-card-meta")]
            .filter(e => getComputedStyle(e).display !== "none")
            .map(e => { const b = e.getBoundingClientRect(); return { text: e.textContent, top: b.top - box.top, bottom: b.bottom - box.top, height: b.height, scroll: e.scrollHeight }; });
          return { id: card.dataset.programId, top: box.top, bottom: box.bottom, height: box.height, start: card.dataset.start, label: card.getAttribute("aria-label"), parts };
        }));
        assert.equal(geometry.length, 7);
        for (const card of geometry) {
          const source = programs.find(p => p.id === card.id);
          assert.equal(Number(card.start), source.start);
          assert.ok(card.label.includes(source.title), card.label);
          if (card.id === "guide-30") assert.match(card.label, /録画中/);
          if (card.id === "guide-15") assert.match(card.label, /自動予約/);
          // Even a one-minute program must have a readable, unclipped title.
          for (let i = 0; i < card.parts.length; i++) {
            const part = card.parts[i];
            assert.ok(part.top >= 0 && part.bottom <= card.height + 0.5, JSON.stringify({ zoom, card }));
            assert.ok(part.scroll <= part.height + 1, JSON.stringify({ zoom, part }));
            if (i) assert.ok(card.parts[i - 1].bottom <= part.top + 0.5, JSON.stringify({ zoom, card }));
          }
          assert.ok(card.parts.some(p => p.text.includes(source.title)), JSON.stringify({ zoom, card }));
        }
        for (let i = 1; i < geometry.length; i++) assert.ok(geometry[i - 1].bottom <= geometry[i].top + 0.5, JSON.stringify({ zoom, geometry }));
        if (zoom !== "precise") await page.locator("#scheduleZoomInButton").click();
      }
      const first = page.locator('.schedule-card[data-program-id="guide-5"]');
      await first.focus();
      await page.keyboard.press("Enter");
      await page.locator("#programDialog").waitFor({ state: "visible" });
      assert.match(await page.locator("#programDialogTitle").textContent(), /5分番組/);
      await page.keyboard.press("Escape");
      await page.locator("#programDialog").waitFor({ state: "hidden" });
      assert.equal(await first.evaluate(e => document.activeElement === e), true);
    } finally { await context.close(); }
  });
});

test("guide wraps program titles and fills remaining space with safe description text", async t => {
  for (const width of [390, 1440]) for (const colorScheme of ["light", "dark"]) await t.test(width + " " + colorScheme, async () => {
    const { page, context } = await pageFor({ viewport: { width, height: 900 }, colorScheme, hasTouch: width < 1024 });
    try {
      const start = now + 60000;
      const title = "日本の山と海をめぐる旅　四季の風景と地域の暮らしを訪ねて　山里から港町へ、受け継がれてきた営みを記録";
      const detail = ("土地の歴史や暮らしを紹介します。旅先で出会った人々の物語をお届けします。\n").repeat(20) + '<img src=x onerror="alert(1)">';
      const programs = [
        { ...program, id: "wrap-long", title, detail, start, end: start + 7200000, seconds: 7200 },
        { ...program, id: "wrap-short", title: "気象情報", detail, start: start + 7200000, end: start + 7260000, seconds: 60 },
        { ...program, id: "wrap-fallback", detail: "", description: "descriptionフィールドの説明文", start: start + 7260000, end: start + 10860000 },
        { ...program, id: "wrap-empty", detail: "", start: start + 10860000, end: start + 14460000 }
      ];
      const schedule = Array.from({ length: 8 }, (_, i) => {
        const station = i ? { ...channel, id: "wrap-channel-" + i, name: "監査チャンネル" + i, sid: 101 + i } : channel;
        return { channel: station, programs: programs.map(p => ({ ...p, id: i ? p.id + "-" + i : p.id, channel: station })) };
      });
      await page.route("**/api/schedule", route => route.fulfill({ json: schedule }));
      await loaded(page, "schedule");
      const card = page.locator('.schedule-card[data-program-id="wrap-long"]');
      await card.waitFor();
      const description = card.locator(".schedule-card-description");
      assert.equal(await description.count(), 1);
      assert.equal(await description.textContent(), detail);
      assert.equal(await card.locator("img").count(), 0);
      const measureText = card => {
        const title = card.querySelector("strong"), description = card.querySelector(".schedule-card-description");
        const box = card.getBoundingClientRect(), a = title.getBoundingClientRect(), b = description.getBoundingClientRect();
        return { titleHeight: a.height, lineHeight: parseFloat(getComputedStyle(title).lineHeight), titleRight: a.right, cardRight: box.right, titleBottom: a.bottom, descriptionTop: b.top, descriptionBottom: b.bottom, cardBottom: box.bottom, descriptionHeight: b.height, descriptionScroll: description.scrollHeight, overflow: getComputedStyle(description).overflowY };
      };
      const geometry = await card.evaluate(measureText);
      assert.ok(geometry.titleHeight > geometry.lineHeight, JSON.stringify(geometry));
      assert.ok(geometry.titleRight <= geometry.cardRight && geometry.titleBottom <= geometry.descriptionTop, JSON.stringify(geometry));
      assert.ok(geometry.descriptionHeight >= geometry.lineHeight && geometry.descriptionBottom <= geometry.cardBottom, JSON.stringify(geometry));
      assert.ok(geometry.descriptionScroll > geometry.descriptionHeight, JSON.stringify(geometry));
      assert.equal(geometry.overflow, "hidden");
      assert.ok(Math.abs(geometry.descriptionHeight / geometry.lineHeight - Math.round(geometry.descriptionHeight / geometry.lineHeight)) < 0.01, JSON.stringify(geometry));
      await page.setViewportSize({ width: width === 390 ? 553 : 1700, height: 900 });
      await page.waitForTimeout(100);
      const resized = await card.evaluate(measureText);
      assert.ok(Math.abs(resized.descriptionHeight / resized.lineHeight - Math.round(resized.descriptionHeight / resized.lineHeight)) < 0.01, JSON.stringify(resized));
      assert.equal(await page.locator('.schedule-card[data-program-id="wrap-fallback"] .schedule-card-description').textContent(), "descriptionフィールドの説明文");
      assert.equal(await page.locator('.schedule-card[data-program-id="wrap-empty"] .schedule-card-description').count(), 0);
      const short = await page.locator('.schedule-card[data-program-id="wrap-short"]').evaluate(card => {
        const a = card.getBoundingClientRect(), title = card.querySelector("strong").getBoundingClientRect();
        return { height: a.height, titleHeight: title.height, titleFits: title.top >= a.top && title.bottom <= a.bottom, overflow: getComputedStyle(card).overflowY };
      });
      assert.ok(short.height >= 24 && short.titleHeight >= 16 && short.titleFits, JSON.stringify(short));
      assert.equal(short.overflow, "hidden");
      await card.click();
      await page.locator("#programDialog").waitFor({ state: "visible" });
      assert.equal(await page.locator("#programDialogDescription").textContent(), detail);
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width === 390 ? 553 : 1700);
    } finally { await context.close(); }
  });
});

test("guide uses an unavailable label instead of IDs and keeps the ID in program details", async () => {
  const { page, context } = await pageFor({ viewport: { width: 1440, height: 900 } });
  try {
    const programs = [
      { ...program, id: "missing-name-id", title: "", fullTitle: "" },
      { ...program, id: "whitespace-name-id", title: "  ", fullTitle: "\t" },
      { ...program, id: "flags-only-id", title: "", fullTitle: "[字]" },
      { ...program, id: "pua-flags-only-id", title: "", fullTitle: "\uE0FE" },
      { ...program, id: "unicode-flags-only-id", title: "", fullTitle: "🈑" },
      { ...program, id: "normal-name-id", title: "", fullTitle: "🈑残す番組名🈓" }
    ].map((p, i) => ({ ...p, start: now + i * 1800000, end: now + (i + 1) * 1800000 }));
    await page.route("**/api/schedule", route => route.fulfill({ json: [{ channel, programs }] }));
    await loaded(page, "schedule");
    for (const p of programs.slice(0, -1)) {
      const card = page.locator('.schedule-card[data-program-id="' + p.id + '"]');
      await card.waitFor();
      assert.equal(await card.locator(".program-title-label").textContent(), "番組情報未取得");
      assert.ok(!(await card.getAttribute("aria-label")).includes(p.id));
      await card.click();
      assert.equal(await page.locator("#programDialogTitle .program-title-label").textContent(), "番組情報未取得");
      assert.ok((await page.locator("#programDialogMeta").textContent()).includes(p.id));
      await page.keyboard.press("Escape");
    }
    assert.equal(await page.locator('.schedule-card[data-program-id="normal-name-id"] .program-title-label').textContent(), "残す番組名");
  } finally { await context.close(); }
});

test("mobile guide list launcher leaves program titles unobstructed", async t => {
  for (const width of [320, 375, 553, 760]) await t.test(String(width), async () => {
    const { page, context } = await pageFor({ viewport: { width, height: 871 }, hasTouch: true, colorScheme: "dark" });
    try {
      await loaded(page, "schedule");
      const summary = page.locator(".schedule-list-alternative summary");
      const layout = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        return { guide: rect(".schedule-guide-scroll"), list: rect(".schedule-list-alternative"), zoom: rect(".schedule-zoom-controls"), width: document.documentElement.scrollWidth };
      });
      assert.ok(layout.list.width <= 144 && layout.list.height >= 44, JSON.stringify(layout));
      assert.ok(layout.guide.bottom <= layout.list.top && layout.guide.bottom <= layout.zoom.top, JSON.stringify(layout));
      assert.ok(layout.zoom.right <= layout.list.left, JSON.stringify(layout));
      assert.equal(layout.width, width);
      await summary.click();
      await page.locator('.schedule-list-search input').fill('監査用番組');
      await page.locator('.schedule-touch-programs .program-row').waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.schedule-list-alternative').getAttribute('open'), null);
      assert.equal(await summary.evaluate(e => document.activeElement === e), true);
    } finally { await context.close(); }
  });
});

test("short-program expansion keeps stations, hour ticks and current-time line aligned", async () => {
  const { page, context } = await pageFor({ viewport: { width: 1024, height: 720 }, timezoneId: "Asia/Tokyo" });
  try {
    // Keep this twelve-hour layout fixture within the selected calendar day.
    const fixedNow = Date.parse("2026-11-13T08:30:00+09:00");
    await page.clock.install({ time: fixedNow });
    const start = Math.floor(fixedNow / 3600000) * 3600000;
    const other = { ...channel, id: 'second-station', name: '第2放送局' };
    let cursor = start + 3600000;
    const short = [1, 3, 5, 10, 15, 26, 60, 60].map((minutes, i) => {
      const item = { ...program, id: 'short-' + i, title: minutes + '分番組', start: cursor, end: cursor + minutes * 60000 };
      cursor = item.end;
      return item;
    });
    const long = Array.from({ length: 12 }, (_, hour) => ({ ...program, id: 'long-' + hour, channel: other, start: start + hour * 3600000, end: start + (hour + 1) * 3600000 }));
    await page.route('**/api/schedule', route => route.fulfill({ json: [{ channel, programs: short }, { channel: other, programs: long }] }));
    await loaded(page, 'schedule');
    await page.locator('.schedule-card[data-program-id="long-2"]').waitFor();
    const geometry = await page.evaluate(start => {
      const top = id => document.querySelector('[data-program-id="' + id + '"]').offsetTop;
      const tick = document.querySelectorAll('.schedule-time-rail span')[2].offsetTop;
      const lines = [...document.querySelectorAll('.schedule-now-line')].map(e => e.offsetTop);
      const hours = [...document.querySelectorAll('.schedule-hour-line')].map(e => e.offsetTop);
      return { short: top('short-6'), long: top('long-2'), tick, lines, hours };
    }, start);
    assert.equal(geometry.short, geometry.long);
    assert.equal(geometry.long, geometry.tick);
    assert.ok(geometry.hours.includes(geometry.tick));
    assert.equal(geometry.lines.length, 2);
    assert.ok(Math.abs(geometry.lines[0] - geometry.lines[1]) <= 1);
    // Keep a real broadcast boundary at the top while changing zoom.
    await page.locator('.schedule-guide-scroll').evaluate((e, top) => { e.scrollTop = top; }, geometry.tick);
    await page.locator('#scheduleZoomInButton').click();
    await page.waitForFunction(() => {
      const scroll = document.querySelector('.schedule-guide-scroll');
      const tick = document.querySelectorAll('.schedule-time-rail span')[2];
      return Math.abs(scroll.scrollTop - tick.offsetTop) <= 1;
    });
    await page.locator('.schedule-guide-scroll').evaluate(e => { e.scrollTop = e.scrollHeight; });
    await page.locator('.schedule-card[data-program-id="long-11"]').waitFor();
    assert.equal(await page.locator('.schedule-card[data-program-id="long-11"] strong').isVisible(), true);
  } finally { await context.close(); }
});

test("genre labels are Japanese while filter values remain compatible", async () => {
  const { page, context } = await pageFor();
  try {
    const second = { ...program, id: "documentary", category: "documentary", start: program.end, end: program.end + 3600000 };
    const unknown = { ...second, id: "unknown-genre", category: "独自ジャンル" };
    await page.route("**/api/schedule", route => route.fulfill({ json: [{ channel, programs: [program, second, unknown] }] }));
    await loaded(page, "schedule");
    await page.locator('#scheduleFilterButton').click();
    assert.equal(await page.locator('#scheduleGenre option[value="news"]').textContent(), 'ニュース・報道');
    assert.equal(await page.locator('#scheduleGenre option[value="documentary"]').textContent(), 'ドキュメンタリー・教養');
    assert.equal(await page.locator('#scheduleGenre option[value="独自ジャンル"]').textContent(), '独自ジャンル');
    await page.locator('#scheduleGenre').selectOption('documentary');
    await page.keyboard.press('Escape');
    await page.locator('.schedule-card[data-program-id="documentary"]').waitFor();
    assert.equal(await page.locator('.schedule-card').count(), 1);
    assert.match(await page.locator('.schedule-card').getAttribute('aria-label'), /ドキュメンタリー・教養/);
    await page.locator('.schedule-card').click();
    assert.equal(await page.locator('#programDialog .program-category-chip').textContent(), 'ドキュメンタリー・教養');
  } finally { await context.close(); }
});

test("login errors preserve input and allow retry without duplicate requests", async t => {
  for (const [status, expected] of [[401, "ユーザー名またはパスワード"], [403, "許可"], [429, "待"], [500, "サーバー"]]) {
    await t.test(String(status), async () => {
      const { page, context } = await pageFor();
      try {
        let count = 0;
        await page.route("**/api/auth/login", async route => { count++; await new Promise(r => setTimeout(r, 80)); await route.fulfill({ status }); });
        await page.goto(baseURL + "/login");
        await page.locator("#username").fill("監査利用者🙂");
        await page.locator("#password").fill("audit-password");
        await page.evaluate(() => { for (let i = 0; i < 10; i++) document.querySelector("#loginForm").dispatchEvent(new Event("submit", { cancelable: true })); });
        await page.waitForFunction(() => !document.querySelector("#submit").disabled);
        assert.equal(count, 1);
        assert.ok((await page.locator("#error").textContent()).includes(expected));
        assert.equal(await page.locator("#username").inputValue(), "監査利用者🙂");
        assert.equal(await page.locator("#password").inputValue(), "audit-password");
        await page.locator("#submit").click();
        await page.waitForFunction(() => !document.querySelector("#submit").disabled);
        assert.equal(count, 2);
      } finally { await context.close(); }
    });
  }
});

test("rule creation retains channel metadata after navigation and rule rerenders", async t => {
  for (const source of ["search", "schedule"]) await t.test(source, async () => {
    const { page, context } = await pageFor();
    try {
      await loaded(page, source);
      if (source === "search") {
        await page.locator("#searchList button", { hasText: "ルール作成" }).first().click();
      } else {
        await page.locator(".schedule-card").first().click();
        await page.locator("#programDialogActions button", { hasText: "ルール作成" }).click();
      }
      await page.waitForURL(baseURL + "/#rules");
      await page.waitForFunction(() => document.querySelector("#ruleList").textContent.includes("ルールはありません"));
      const selected = () => page.locator("#ruleChannels").evaluate(e => [...e.selectedOptions].map(o => ({ id: o.value, label: o.textContent })));
      assert.deepEqual(await selected(), [{ id: channel.id, label: channel.name }]);
      await page.locator("#ruleListSort").selectOption({ index: 1 });
      assert.deepEqual(await selected(), [{ id: channel.id, label: channel.name }]);
      assert.equal(await page.locator("#ruleTitle").inputValue(), program.title);
    } finally { await context.close(); }
  });
});

test("login network failure, timeout and success", async t => {
  for (const mode of ["network", "timeout", "timeout-no-abort", "success"]) await t.test(mode, async () => {
    const { page, context } = await pageFor();
    try {
      if (mode === "timeout-no-abort") await page.addInitScript(() => { window.AbortController = undefined; });
      await page.route("**/api/auth/login", route => mode === "network" ? route.abort() : mode === "success" ? route.fulfill({ status: 204 }) : new Promise(() => {}));
      await page.goto(baseURL + "/login");
      if (mode.startsWith("timeout")) await page.clock.install();
      await page.locator("#username").fill("user");
      await page.locator("#password").fill("password");
      await page.locator("#submit").click();
      if (mode === "success") { await page.waitForURL(baseURL + "/"); return; }
      if (mode.startsWith("timeout")) await page.clock.fastForward(15001);
      await page.waitForFunction(() => !document.querySelector("#submit").disabled, null, { timeout: 1000 });
      const message = await page.locator("#error").textContent();
      assert.ok(message.includes(mode === "network" ? "接続" : "応答"), message);
      assert.ok(message.includes("再試行"), message);
    } finally { await context.close(); }
  });
});

const mseStub = `window.__mseURLs = []; window.mpegts = {isSupported:()=>true,getFeatureList:()=>({mseLivePlayback:true}),Events:{ERROR:'error'},createPlayer:o=>{window.__mseURLs.push(o.url);return {on(){},attachMediaElement(){},load(){},play(){return Promise.resolve()},pause(){},unload(){},detachMediaElement(){},destroy(){}}}};`;

test("dialog fallback opens a valid dedicated live player", async () => {
  const { page, context } = await pageFor();
  try {
    await page.addInitScript(() => { HTMLDialogElement.prototype.showModal = undefined; });
    await page.route("**/mpegts.js", route => route.fulfill({ contentType: "text/javascript", body: mseStub }));
    await loaded(page);
    await page.locator("#onAirList button", { hasText: "視聴" }).first().click();
    await page.waitForURL(url => url.pathname === "/player.html");
    const url = new URL(page.url());
    assert.match(url.searchParams.get("src"), /\/api\/channel\/audit-gr\/watch\.m2ts\?mode=mse/);
    assert.match(url.searchParams.get("subtitles"), /mode=mse/);
  } finally { await context.close(); }
});

test("mpegts is lazy, shared and used before live URL selection", async () => {
  const { page, context } = await pageFor();
  try {
    let requests = 0;
    await page.route("**/mpegts.js", route => { requests++; return route.fulfill({ contentType: "text/javascript", body: mseStub }); });
    await loaded(page);
    assert.equal(requests, 0);
    await loaded(page, "recorded");
    await page.locator("[data-view='recorded'] button", { hasText: "視聴" }).first().click();
    assert.equal(requests, 0);
    await page.locator("#playerDialogClose").click();
    await loaded(page);
    await page.locator("#onAirList button", { hasText: "視聴" }).first().click();
    await page.waitForFunction(() => window.__mseURLs && window.__mseURLs.length === 1);
    assert.equal(requests, 1);
    assert.match(await page.evaluate(() => window.__mseURLs[0]), /watch\.m2ts\?mode=mse/);
    await page.locator("#playerDialogClose").click();
    await page.locator("#onAirList button", { hasText: "視聴" }).first().click();
    await page.waitForFunction(() => window.__mseURLs.length === 2);
    assert.equal(requests, 1);
  } finally { await context.close(); }
});

test("failed mpegts loading can retry; closing during loading never starts media", async t => {
  for (const mode of ["retry", "close", "switch", "timeout", "unsupported", "hls"]) await t.test(mode, async () => {
    const { page, context } = await pageFor();
    try {
      let requests = 0, release;
      if (mode === "hls") await page.addInitScript(() => { HTMLMediaElement.prototype.canPlayType = () => "probably"; Object.defineProperty(navigator, "userAgent", { get: () => "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1" }); });
      await page.route("**/mpegts.js", async route => {
        requests++;
        if (mode === "retry" && requests === 1) return route.abort();
        if (mode === "timeout") return new Promise(() => {});
        if (mode === "close" || mode === "switch") await new Promise(resolve => { release = resolve; });
        return route.fulfill({ contentType: "text/javascript", body: mode === "unsupported" ? "window.mpegts={isSupported:()=>false};" : mseStub });
      });
      await loaded(page);
      if (mode === "timeout") await page.clock.install();
      await page.locator("#onAirList button", { hasText: "視聴" }).first().click();
      if (mode === "hls") { assert.equal(requests, 0); await page.waitForFunction(() => document.querySelector("#playerVideo").src.includes("hls/index.m3u8")); return; }
      if (mode === "unsupported") { await page.waitForFunction(() => document.querySelector("#playerVideo").src.includes("watch.mp4")); return; }
      if (mode === "close" || mode === "switch") {
        await page.waitForFunction(() => document.querySelector("script[src='/mpegts.js']"));
        await page.waitForFunction(() => document.querySelector("#playerDialog").open);
        assert.equal(await page.locator("#playerOpenLink").isVisible(), false);
        if (mode === "close") {
          await page.locator("#playerDialogClose").click();
        } else {
          // A new live intent shares the pending script but invalidates the old generation.
          await page.evaluate(() => document.querySelector("#onAirList .live-channel-actions button").click());
        }
        release();
        await page.waitForFunction(() => window.mpegts);
        if (mode === "switch") await page.waitForFunction(() => window.__mseURLs.length === 1);
        assert.equal(await page.evaluate(() => window.__mseURLs.length), mode === "close" ? 0 : 1);
        assert.equal(requests, 1);
        return;
      }
      if (mode === "timeout") await page.clock.fastForward(15001);
      await page.locator("#playerRetryButton").waitFor({ state: "visible", timeout: 1500 });
      assert.ok((await page.locator("#playerStatusMessage").textContent()).includes("再試行"));
      assert.equal(await page.evaluate(() => document.querySelectorAll("script[src='/mpegts.js']").length), 0);
      if (mode === "retry") {
        await page.locator("#playerRetryButton").click();
        await page.waitForFunction(() => window.__mseURLs && window.__mseURLs.length === 1);
        assert.equal(requests, 2);
      }
    } finally { await context.close(); }
  });
});
