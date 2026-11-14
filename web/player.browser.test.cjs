"use strict";

const { chromium } = require(process.env.MOCHIZUKI_AUDIT_PLAYWRIGHT || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { test, before, after } = require("node:test");
let browser, server, base;
let nativeStream = null;
let mediaParts = null;
const now = Date.now();
const channel = { id: "abc", name: "テスト放送", type: "GR", channel: "27", sid: 101 };
const program = { id: "audit", title: "プレイヤー検証番組", start: now - 15000, end: now + 15000, seconds: 30, channel, recorded: "/audit.m2ts", pid: 123 };
const requests = [];
const mseStub = `window.__players=[];window.mpegts={isSupported:()=>true,getFeatureList:()=>({mseLivePlayback:true}),Events:{ERROR:'error'},createPlayer:o=>{const p={url:o.url,on(e,fn){this.error=fn},attachMediaElement(v){v.src='blob:test-player'},load(){},play(){return document.querySelector('video').play()},pause(){},unload(){},detachMediaElement(){},destroy(){}};window.__players.push(p);return p}};`;

before(async () => {
  const mediaPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mochizuki-player-test-")), "sample.mp4");
  const generated = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-y", mediaPath], { windowsHide: true });
  if (generated.status === 0) {
    const data = fs.readFileSync(mediaPath), boundaries = [];
    for (let pos = 0; pos + 8 <= data.length;) { const size = data.readUInt32BE(pos); if (!size) break; if (data.toString("ascii", pos + 4, pos + 8) === "moof") boundaries.push(pos); pos += size; }
    mediaParts = { init: data.subarray(0, boundaries[0]), chunks: boundaries.map((p, i) => data.subarray(p, boundaries[i + 1] || data.length)) };
  }
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: u.pathname, session: u.searchParams.get("session") });
    if (req.method === "DELETE") return res.writeHead(204).end();
    if (nativeStream && u.pathname === "/api/channel/abc/watch.mp4") {
      nativeStream.gets++;
      nativeStream.responses.push(res);
      res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
      res.write(mediaParts.init); res.write(mediaParts.chunks[0]); res.write(mediaParts.chunks[1]);
      return;
    }
    if (u.pathname.endsWith("subtitles.vtt")) return res.writeHead(200, { "Content-Type": "text/vtt" }).end("WEBVTT\n\n");
    if (u.pathname.startsWith("/api/")) {
      const key = u.pathname.slice(5); let data = [];
      if (key === "status") data = { operator: { alive: true }, scheduler: { alive: true } };
      if (key === "schedule") data = [{ channel, programs: [program] }];
      if (key === "schedule/broadcasting") data = [program];
      if (["recorded", "recorded/recent", "recording"].includes(key)) data = [program];
      if (key === "auth/session") data = { authenticated: false, authenticationEnabled: false };
      if (key === "config") data = JSON.parse(fs.readFileSync(path.join(__dirname, "../config.sample.json")));
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    }
    const file = path.join(__dirname, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
    if (!file.startsWith(__dirname + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
});
after(async () => { if (browser) await browser.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } });

async function pageFor(t, options = {}, realMedia = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(3500);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  // Control only the external media engine; application events, DOM and timers stay real.
  if (!realMedia) await page.addInitScript(() => {
    const states = new WeakMap();
    const state = v => { if (!states.has(v)) states.set(v, { paused: true, currentTime: 0, duration: 30, ended: false, readyState: 4, plays: 0, src: "" }); return states.get(v); };
    for (const key of ["paused", "currentTime", "duration", "ended", "readyState"]) Object.defineProperty(HTMLMediaElement.prototype, key, { configurable: true, get() { return state(this)[key]; }, set(value) { state(this)[key] = value; } });
    Object.defineProperty(HTMLMediaElement.prototype, "src", { configurable: true, get() { return state(this).src; }, set(value) { state(this).src = value ? new URL(value, location.href).href : ""; } });
    const getAttribute = HTMLMediaElement.prototype.getAttribute;
    const removeAttribute = HTMLMediaElement.prototype.removeAttribute;
    HTMLMediaElement.prototype.getAttribute = function (name) { return name === "src" ? state(this).src || null : getAttribute.call(this, name); };
    HTMLMediaElement.prototype.removeAttribute = function (name) { if (name === "src") state(this).src = ""; else removeAttribute.call(this, name); };
    HTMLMediaElement.prototype.play = function () { state(this).paused = false; state(this).plays++; this.dispatchEvent(new Event("play")); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { const s = state(this); if (!s.paused) { s.paused = true; this.dispatchEvent(new Event("pause")); } };
    HTMLMediaElement.prototype.load = function () { Object.assign(state(this), { currentTime: 0, ended: false }); };
    window.__media = (id, values = {}, event) => { const v = document.getElementById(id); Object.assign(state(v), values); if (event) v.dispatchEvent(new Event(event)); return { ...state(v) }; };
  });
  await page.route("**/mpegts.js", r => r.fulfill({ contentType: "text/javascript", body: mseStub }));
  return page;
}

async function inline(page, route = "recorded") {
  await page.goto(base + "/#" + route);
  await page.waitForFunction(() => !document.querySelector("#refreshButton").disabled);
  const selector = route === "dashboard" ? "#onAirList button" : `[data-view='${route}'] button`;
  await page.locator(selector, { hasText: "視聴" }).first().click();
  await page.waitForFunction(() => document.querySelector("#playerVideo").src);
}
async function external(page, src = "/api/channel/abc/watch.m2ts?mode=mse") {
  await page.goto(base + "/player.html?" + new URLSearchParams({ src, title: "プレイヤー検証番組" }));
  await page.waitForFunction(() => document.querySelector("video").src);
}

test("normal playback hides the dedicated-player message on desktop and mobile", async t => {
  for (const width of [1440, 375]) await t.test(String(width), async t => {
    const page = await pageFor(t, { viewport: { width, height: 900 } });
    await external(page, "/api/recorded/audit/watch.mp4");
    assert.equal(await page.locator("#message").isVisible(), false);
    assert.equal(await page.locator("video").isVisible(), true);
  });
});

test("subtitle off leaves the video source unchanged and only deletes captions", async t => {
  const page = await pageFor(t); await inline(page);
  const source = await page.locator("video").evaluate(v => v.src);
  await page.locator("#playerSettings summary").click();
  await page.locator("#playerSubtitle").selectOption("ja");
  const mark = requests.length;
  await page.locator("#playerSubtitle").selectOption("");
  await page.waitForTimeout(100);
  assert.equal(await page.locator("video").evaluate(v => v.src), source);
  const stops = requests.slice(mark).filter(r => r.method === "DELETE");
  assert.equal(stops.length, 1); assert.ok(stops[0].path.endsWith("subtitles.vtt"));
});

test("a silent DELETE cannot block a new source beyond its deadline", async t => {
  for (const mode of ["inline", "external"]) await t.test(mode, async t => {
    const page = await pageFor(t);
    if (mode === "inline") await inline(page); else await external(page);
    await page.clock.install();
    await page.route("**/api/**", async r => { if (r.request().method() === "DELETE") return new Promise(() => {}); return r.continue(); });
    if (mode === "inline") {
      await page.locator("#playerSettings summary").click(); await page.locator("#playerQuality").selectOption("360p");
      await page.locator("#playerDialogClose").click();
      await page.locator("[data-view='recorded'] button", { hasText: "視聴" }).first().click();
    } else { await page.evaluate(() => window.__players[0].error()); }
    await page.clock.runFor(14000);
    await page.waitForFunction(() => document.querySelector("video").src);
    if (mode === "external") assert.equal(await page.evaluate(() => window.__players.length), 2);
  });
});

test("MSE reconnect survives a trailing timeupdate in both players", async t => {
  for (const mode of ["inline", "external"]) await t.test(mode, async t => {
    const page = await pageFor(t);
    if (mode === "inline") await inline(page, "dashboard"); else await external(page);
    await page.clock.install();
    await page.evaluate(() => { window.__players[0].error(); document.querySelector("video").dispatchEvent(new Event("timeupdate")); });
    await page.clock.runFor(1100);
    await page.waitForFunction(() => window.__players.length === 2);
    assert.equal(await page.locator("video").isVisible(), true);
  });
});

test("buffering can resume naturally; a persistent wait reconnects both players", async t => {
  for (const mode of ["inline", "external"]) await t.test(mode, async t => {
    const page = await pageFor(t);
    if (mode === "inline") await inline(page, "dashboard"); else await external(page);
    await page.clock.install();
    const id = mode === "inline" ? "playerVideo" : "externalPlayer";
    await page.evaluate(id => window.__media(id, { currentTime: 2 }, "waiting"), id);
    await page.clock.runFor(6000);
    await page.evaluate(id => window.__media(id, { currentTime: 3 }, "playing"), id);
    await page.clock.runFor(8000);
    assert.equal(await page.evaluate(() => window.__players.length), 1);
    await page.evaluate(id => window.__media(id, {}, "waiting"), id);
    await page.clock.runFor(14000);
    await page.waitForFunction(() => window.__players.length === 2);
  });
});

test("user pause and closing cancel buffering recovery", async t => {
  const page = await pageFor(t); await inline(page, "dashboard"); await page.clock.install();
  await page.evaluate(() => window.__media("playerVideo", {}, "waiting"));
  await page.locator("#playerPlayButton").click();
  await page.clock.runFor(16000);
  assert.equal(await page.evaluate(() => window.__players.length), 1);
  await page.locator("#playerPlayButton").click();
  await page.evaluate(() => window.__media("playerVideo", {}, "waiting"));
  await page.locator("#playerDialogClose").click(); await page.clock.runFor(16000);
  assert.equal(await page.evaluate(() => window.__players.length), 1);
});

test("an error received while the user has paused cannot restart playback", async t => {
  for (const mode of ["inline", "external"]) await t.test(mode, async t => {
    const page = await pageFor(t);
    if (mode === "inline") await inline(page, "dashboard"); else await external(page);
    await page.clock.install();
    await page.evaluate(() => { document.querySelector("video").pause(); window.__players[0].error(); });
    await page.clock.runFor(10000);
    assert.equal(await page.evaluate(() => window.__players.length), 1);
    assert.equal(await page.locator("video").evaluate(v => v.paused), true);
  });
});

test("caption errors remain visible while video playback progresses", async t => {
  const page = await pageFor(t); await inline(page);
  await page.locator("#playerSettings summary").click();
  await page.locator("#playerSubtitle").selectOption("ja");
  await page.evaluate(() => document.querySelector("#playerSubtitleTrack").dispatchEvent(new Event("error")));
  assert.equal(await page.locator("#playerStatus").isVisible(), true);
  await page.evaluate(() => window.__media("playerVideo", { currentTime: 2 }, "timeupdate"));
  assert.equal(await page.locator("#playerStatus").isVisible(), true);
  assert.match(await page.locator("#playerStatusMessage").textContent(), /字幕/);
});

test("native HLS and MP4 failures automatically reconnect", async t => {
  for (const format of ["hls/index.m3u8?quality=540p", "watch.mp4"]) await t.test(format, async t => {
    const page = await pageFor(t); await external(page, "/api/channel/abc/" + format); await page.clock.install();
    const first = await page.locator("video").evaluate(v => v.src);
    await page.evaluate(() => document.querySelector("video").dispatchEvent(new Event("error")));
    await page.clock.runFor(1100);
    await page.waitForFunction(old => document.querySelector("video").src && document.querySelector("video").src !== old, first);
    assert.equal(await page.locator("video").isVisible(), true);
  });
});

test("a browser pause caused by invalid MP4 does not cancel automatic recovery", async t => {
  for (const mode of ["inline", "external"]) await t.test(mode, async t => {
    const page = await pageFor(t, {}, true);
    await page.route("**/mpegts.js", r => r.fulfill({ contentType: "text/javascript", body: "window.mpegts={isSupported:()=>false};" }));
    await page.route("**/api/channel/abc/watch.mp4?*", r => r.fulfill({ contentType: "video/mp4", body: "invalid media" }));
    await page.clock.install();
    if (mode === "inline") await inline(page, "dashboard"); else await external(page, "/api/channel/abc/watch.mp4");
    await page.waitForFunction(() => document.querySelector("video").error && document.querySelector("video").paused);
    const source = await page.locator("video").evaluate(v => v.src);
    await page.clock.runFor(1500);
    await page.waitForFunction(old => document.querySelector("video").src && document.querySelector("video").src !== old, source);
  });
});

test("a recording stream ending reconnects at the live tail rather than seeking from zero", async t => {
  const page = await pageFor(t); await external(page, "/api/recording/audit/watch.mp4"); await page.clock.install();
  const first = await page.locator("video").evaluate(v => v.src);
  await page.evaluate(() => window.__media("externalPlayer", { currentTime: 12, ended: true, paused: true }, "ended"));
  await page.clock.runFor(1100);
  await page.waitForFunction(old => document.querySelector("video").src && document.querySelector("video").src !== old, first);
  assert.equal(new URL(await page.locator("video").evaluate(v => v.src)).searchParams.has("ss"), false);
});

test("recorded buffering recovery retains its position and does not loop at the end", async t => {
  const page = await pageFor(t); await inline(page); await page.clock.install();
  await page.evaluate(() => window.__media("playerVideo", { currentTime: 12 }, "waiting"));
  await page.clock.runFor(14000);
  await page.waitForFunction(() => document.querySelector("video").src && new URL(document.querySelector("video").src).searchParams.get("ss") === "12");
  const source = await page.locator("video").evaluate(v => v.src);
  await page.evaluate(() => window.__media("playerVideo", { ended: true, paused: true }, "ended"));
  await page.clock.runFor(16000);
  assert.equal(await page.locator("video").evaluate(v => v.src), source);
});

test("reconnects are bounded and expose a manual retry after repeated failures", async t => {
  const page = await pageFor(t); await external(page); await page.clock.install();
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate(() => window.__players.at(-1).error());
    await page.clock.runFor(8500);
    await page.waitForFunction(count => window.__players.length === count, attempt + 2);
  }
  await page.evaluate(() => window.__players.at(-1).error());
  await page.clock.runFor(16000);
  assert.equal(await page.evaluate(() => window.__players.length), 6);
  assert.equal(await page.locator("#retryButton").isVisible(), true);
});

test("real fragmented MP4 resumes when bytes arrive after catching the buffer tail", async t => {
  if (!mediaParts) return t.skip("ffmpeg with libx264 is required for the real media check");
  for (const mode of ["inline", "external"]) await t.test(mode, async t => {
    const page = await pageFor(t, {}, true);
    nativeStream = { gets: 0, responses: [] };
    t.after(() => { for (const res of nativeStream.responses) res.end(); nativeStream = null; });
    await page.addInitScript(() => {
      window.__waiting = 0; window.__playing = 0;
      document.addEventListener("waiting", () => window.__waiting++, true);
      document.addEventListener("playing", () => window.__playing++, true);
    });
    await page.route("**/mpegts.js", r => r.fulfill({ contentType: "text/javascript", body: "window.mpegts={isSupported:()=>false};" }));
    if (mode === "inline") await inline(page, "dashboard"); else await external(page, "/api/channel/abc/watch.mp4");
    try {
      await page.waitForFunction(() => { const v = document.querySelector("video"); return v.currentTime > 0.3 && !v.paused && v.readyState < 3 && window.__waiting > 0; }, null, { timeout: 8000 });
    } catch (error) {
      console.log("Native media diagnostics", mode, await page.evaluate(() => { const v = document.querySelector("video"); return { time:v.currentTime,paused:v.paused,duration:v.duration,ready:v.readyState,network:v.networkState,error:v.error && {code:v.error.code,message:v.error.message},waiting:window.__waiting,playing:window.__playing,src:v.src,buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)]),message:document.body.innerText.slice(-300) }; }), "GETs",nativeStream.gets,"fragment lengths",mediaParts.chunks.map(b=>b.length));
      throw error;
    }
    const before = await page.evaluate(() => ({ time: document.querySelector("video").currentTime, playing: window.__playing }));
    for (const res of nativeStream.responses) res.end(Buffer.concat(mediaParts.chunks.slice(2)));
    await page.waitForFunction(s => document.querySelector("video").currentTime > s.time + 0.25 && window.__playing > s.playing, before);
    assert.equal(nativeStream.gets, 1, "brief buffering must resume on the same request");
    const state = mode === "inline" ? "#playerStatus" : "#message";
    assert.equal(await page.locator(state).isVisible(), false);
    if (process.env.MOCHIZUKI_AUDIT_OUTPUT) {
      fs.mkdirSync(process.env.MOCHIZUKI_AUDIT_OUTPUT, { recursive: true });
      if (mode === "inline") await page.locator("#playerSettings summary").click();
      await page.screenshot({ path: path.join(process.env.MOCHIZUKI_AUDIT_OUTPUT, mode + "-desktop.png") });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({ path: path.join(process.env.MOCHIZUKI_AUDIT_OUTPUT, mode + "-mobile.png") });
    }
  });
});

test("player controls keep readable touch targets and a live timeline at all widths", async t => {
  for (const width of [320, 375, 768, 1440]) await t.test(String(width), async t => {
    const page = await pageFor(t, { viewport: { width, height: 900 } });
    await inline(page, "dashboard");
    assert.equal(await page.locator("#playerTime").textContent(), "LIVE");
    assert.equal(await page.locator("#playerSeek").isDisabled(), true);
    const geometry = await page.locator("#playerControls").evaluate(e => {
      const box = e.getBoundingClientRect();
      return { overflow: e.scrollWidth > e.clientWidth, tooSmall: [...e.querySelectorAll("button,a,summary")].filter(n => !n.hidden && n.getBoundingClientRect().width > 0).map(n => ({ id:n.id || n.parentElement.id, width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height })).filter(n => n.width < 44 || n.height < 44), bottom:box.bottom };
    });
    assert.equal(geometry.overflow, false); assert.deepEqual(geometry.tooSmall, []);
    assert.ok(geometry.bottom <= 900);
    await page.locator("#playerSettings summary").click();
    const settings = await page.locator(".player-settings-menu").boundingBox();
    assert.ok(settings.x >= 0 && settings.x + settings.width <= width);
  });
});
