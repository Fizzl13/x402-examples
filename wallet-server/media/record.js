// Records the wallet video's picture: a real browser on the wallet's live demo
// (example data, nothing moves money) plus a few drawn scenes that show how it
// stays safe, timed to the narration (out/durations.json). No burned-in
// captions: they were too small on phones (CAPTIONS=1 adds them back); build.py
// writes an .srt instead. Writes out/screen.webm and out/timeline.json (when
// each segment starts, so build.py can place the voice exactly there).
//
//   node record.js                                          # the live demo (GitHub Actions)
//   DEMO_URL=http://127.0.0.1:3000/demo node record.js      # a local server
//   SCRIPT=short.json node record.js                        # the 30-second version

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(HERE, "out");
const DEMO = process.env.DEMO_URL || "https://wallet.fizzl.eu/demo";
const W = 1920;
const H = 1080;
const ZOOM = 2.2;
// The price rule's slider positions (index -> dollars), as on the dashboard: index 8 is $1, 14 is $5.
const PER_TX_START = 8, PER_TX_FIVE = 14;

const script = JSON.parse(fs.readFileSync(path.join(HERE, process.env.SCRIPT || "script.json"), "utf8"));
const durations = JSON.parse(fs.readFileSync(path.join(OUT, "durations.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THEME = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Grotesk:wght@500;700&display=swap');
  :root { --bg:#020708; --panel:#061816; --line:rgba(97,245,195,.22); --text:#f4f8f7; --soft:#a8b5b2; --mint:#61f5c3; --rose:#ff7a90; --amber:#f5c361; }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background: radial-gradient(1200px 700px at 50% 30%, #062520 0%, var(--bg) 70%); color:var(--text); font-family:'DM Sans',system-ui,sans-serif; }
  body { display:flex; align-items:center; justify-content:center; overflow:hidden; }
  h1, h2 { font-family:'Space Grotesk','DM Sans',sans-serif; letter-spacing:-0.02em; margin:0; }
  .fade { opacity:0; transform: translateY(18px); transition: opacity .55s ease, transform .55s ease; }
  .fade.on { opacity:1; transform:none; }
`;

async function setPage(page, html) {
  await page.setContent(html);
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
}
// Reveal [data-step] elements one by one over the given time.
async function reveal(page, ms) {
  const n = await page.evaluate(() => document.querySelectorAll("[data-step]").length);
  for (let i = 0; i < n; i++) {
    await page.evaluate((i) => document.querySelector(`[data-step="${i}"]`)?.classList.add("on"), i);
    await sleep(Math.max(250, (ms * 0.8) / n));
  }
}

const cardHtml = ({ title, sub, note }) => `<!doctype html><html><head><style>${THEME}
  .c { text-align:center; padding: 0 140px; animation: in .7s ease-out both; }
  h1 { font-size: 112px; margin-bottom: 26px; }
  p { font-size: 50px; color: var(--soft); margin: 0; }
  .note { font-size: 32px; margin-top: 44px; color: var(--mint); }
  @keyframes in { from { opacity:0; transform: translateY(26px);} to { opacity:1; transform:none; } }
</style></head><body><div class="c"><h1>${title}</h1><p>${sub || ""}</p>${note ? `<p class="note">${note}</p>` : ""}</div></body></html>`;

// A phone with the Telegram approval message, as the bot really words it.
const phoneHtml = () => `<!doctype html><html><head><style>${THEME}
  .wrap { display:flex; gap: 90px; align-items:center; }
  .phone { width: 520px; height: 900px; border-radius: 64px; border: 3px solid #23443d; background: #0b1416; padding: 26px; box-shadow: 0 40px 120px rgba(0,0,0,.6); position: relative; }
  .phone .bar { height: 70px; display:flex; align-items:center; gap:16px; padding: 0 12px; border-bottom: 1px solid #1d2f2c; }
  .phone .av { width:48px; height:48px; border-radius:50%; background: var(--mint); color:#021; font: 700 26px 'Space Grotesk'; display:grid; place-items:center; }
  .phone .nm { font: 700 26px 'DM Sans'; } .phone .nm small { display:block; font: 400 18px 'DM Sans'; color: var(--soft); }
  .msg { margin: 30px 8px 0; background: #13262a; border-radius: 26px 26px 26px 8px; padding: 24px 26px; font-size: 29px; line-height: 1.45; }
  .msg b { color: #fff; } .msg .amt { color: var(--amber); font-weight: 700; }
  .btns { display:flex; gap: 12px; margin: 14px 8px 0; }
  .btns div { flex:1; text-align:center; padding: 20px; border-radius: 18px; background: #1a3236; font: 700 26px 'DM Sans'; transition: all .3s; }
  .btns .yes.tap { background: var(--mint); color: #021; transform: scale(.96); }
  .done { margin: 22px 8px 0; color: var(--mint); font: 700 26px 'DM Sans'; }
  .side { width: 620px; }
  .side h2 { font-size: 74px; line-height: 1.05; margin-bottom: 28px; }
  .side p { font-size: 36px; color: var(--soft); margin: 0 0 18px; }
</style></head><body><div class="wrap">
  <div class="phone"><div class="bar"><div class="av">F</div><div class="nm">Fizzl Agent Wallet<small>bot</small></div></div>
    <div class="msg fade" data-step="0">🔔 <b>research-agent</b> wants to pay <span class="amt">8 USDC</span> to <b>api.marketdepth.io</b><br><br>for: Full order-book snapshot for the weekly report<br><br>Over your limit of 5 USDC per purchase. presign-guard: ✅ green</div>
    <div class="btns fade" data-step="1"><div class="yes" id="yes">✅ Approve</div><div>❌ Deny</div></div>
    <div class="done fade" id="done">Approved. The agent goes ahead.</div>
  </div>
  <div class="side"><h2 class="fade" data-step="2">One tap.<br>Or it doesn't pay.</h2><p class="fade" data-step="3">No answer in 10 minutes means no payment.</p></div>
</div></body></html>`;

// How a payment flows: the key stays with the agent; the wallet only answers yes or no.
const flowHtml = () => `<!doctype html><html><head><style>${THEME}
  .f { display:flex; align-items:center; gap: 18px; }
  .box { width: 350px; min-height: 340px; border: 2px solid var(--line); border-radius: 28px; background: var(--panel); padding: 34px 30px; text-align:center; }
  .box .ic { font-size: 74px; margin-bottom: 14px; }
  .box h2 { font-size: 46px; margin-bottom: 14px; }
  .box p { font-size: 32px; color: var(--soft); margin: 0; line-height: 1.4; }
  .box.key { border-color: var(--mint); }
  .arrow { font-size: 64px; color: var(--mint); }
  .under { position:absolute; bottom: 150px; left: 0; right: 0; text-align:center; font-size: 38px; color: var(--mint); }
</style></head><body><div class="f">
  <div class="box key fade" data-step="0"><div class="ic">🤖🔑</div><h2>Your agent</h2><p>keeps its own key, on your machine</p></div>
  <div class="arrow fade" data-step="1">→</div>
  <div class="box fade" data-step="2"><div class="ic">📋</div><h2>Fizzl Wallet</h2><p>checks your rules and answers <b style="color:#fff">yes</b> or <b style="color:#fff">no</b></p></div>
  <div class="arrow fade" data-step="3">→</div>
  <div class="box fade" data-step="4"><div class="ic">🛡️</div><h2>presign-guard</h2><p>checks what will be signed</p></div>
  <div class="arrow fade" data-step="5">→</div>
  <div class="box fade" data-step="6"><div class="ic">✅</div><h2>Paid</h2><p>the agent signs and pays the service</p></div>
</div><div class="under fade" data-step="7">The wallet never holds your keys or your money.</div></body></html>`;

// What presign-guard does with different requests.
const checkHtml = () => `<!doctype html><html><head><style>${THEME}
  .k { width: 1500px; }
  h1 { font-size: 76px; margin-bottom: 44px; text-align:center; }
  .row { display:grid; grid-template-columns: 1fr 360px; align-items:center; gap: 30px; padding: 26px 36px; margin-bottom: 18px; border-radius: 24px; border: 2px solid var(--line); background: var(--panel); font-size: 40px; }
  .v { text-align:center; font: 700 34px 'Space Grotesk'; padding: 14px 0; border-radius: 999px; border: 2px solid currentColor; }
  .red { color: var(--rose); } .amber { color: var(--amber); } .green { color: var(--mint); }
</style></head><body><div class="k">
  <h1 class="fade" data-step="0">Checked before every signature</h1>
  <div class="row fade" data-step="1"><span>💀 A known drainer address</span><span class="v red">RED · never signed</span></div>
  <div class="row fade" data-step="2"><span>🚫 A sanctioned address</span><span class="v red">RED · never signed</span></div>
  <div class="row fade" data-step="3"><span>♾️ An unlimited token approval</span><span class="v amber">ASKS YOU first</span></div>
  <div class="row fade" data-step="4"><span>🧾 A normal payment within your rules</span><span class="v green">GREEN · paid</span></div>
</div></body></html>`;

const stopHtml = () => `<!doctype html><html><head><style>${THEME}
  .s { text-align:center; }
  .ic { font-size: 150px; margin-bottom: 30px; }
  h1 { font-size: 104px; margin-bottom: 28px; }
  p { font-size: 46px; color: var(--soft); margin: 0 0 14px; }
  b { color: var(--mint); }
</style></head><body><div class="s">
  <div class="ic fade" data-step="0">🔌⛔</div>
  <h1 class="fade" data-step="1">When in doubt, it stops.</h1>
  <p class="fade" data-step="2">Check unreachable? Wallet offline? Telegram silent?</p>
  <p class="fade" data-step="3"><b>Nothing is signed.</b></p>
</div></body></html>`;

// Captions: a bar at the bottom of every page, re-created after navigation.
async function caption(page, text) {
  await page.evaluate((text) => {
    let el = document.getElementById("__cap");
    if (!el) {
      el = document.createElement("div");
      el.id = "__cap";
      el.style.cssText = "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);max-width:1500px;z-index:2147483647;" +
        "background:rgba(2,7,8,.9);border:1px solid rgba(97,245,195,.4);color:#f4f8f7;font:600 38px/1.35 'DM Sans',system-ui,sans-serif;" +
        "padding:14px 28px;border-radius:14px;text-align:center;pointer-events:none;";
      document.body.appendChild(el);
    }
    el.style.zoom = String(1 / (parseFloat(document.documentElement.style.zoom) || 1));
    el.style.display = text ? "" : "none";
    el.textContent = text;
  }, text);
}

// The demo dashboard, zoomed so it reads on a phone, with the top bar hidden (it would sit over what we show).
async function openDemo(page) {
  await page.goto(DEMO, { waitUntil: "load", timeout: 120000 });
  await page.waitForSelector("#buys .buy", { timeout: 60000 });
  await page.evaluate((z) => {
    document.documentElement.style.zoom = String(z);
    document.documentElement.style.scrollBehavior = "smooth";
    const s = document.createElement("style");
    s.textContent = ".topbar, .demo-banner { display: none !important; } .glow { outline: 3px solid #61f5c3 !important; outline-offset: 6px; border-radius: 18px; box-shadow: 0 0 40px rgba(97,245,195,.35) !important; transition: all .4s; }";
    document.head.appendChild(s);
  }, ZOOM);
}
async function scrollTo(page, selector, block = "start") {
  await page.evaluate(({ selector, block }) => document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block }), { selector, block });
  await sleep(900);
}
const glow = (page, selector, on = true) => page.evaluate(({ selector, on }) => document.querySelectorAll(selector).forEach((el) => el.classList.toggle("glow", on)), { selector, on });
// Move a range input smoothly to a value, firing input events like a hand would.
async function slide(page, selector, to, ms) {
  const from = await page.evaluate((s) => Number(document.querySelector(s).value), selector);
  const steps = Math.max(1, Math.abs(to - from));
  for (let i = 1; i <= steps; i++) {
    const v = from + Math.sign(to - from) * i;
    await page.evaluate(({ s, v }) => { const el = document.querySelector(s); el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }, { s: selector, v });
    await sleep(ms / steps);
  }
}

async function main() {
  // Wake the service (Render's free plan sleeps).
  for (let i = 0; i < 6; i++) { try { if ((await fetch(new URL("/health", DEMO))).ok) break; } catch {} await sleep(10000); }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } }, colorScheme: "dark" });
  const page = await context.newPage();
  const t0 = Date.now();
  const timeline = [];

  const scenes = {
    async card(seg) { await setPage(page, cardHtml(seg.card)); },

    async "prepare:rule"() { await openDemo(page); await page.evaluate((start) => { document.querySelector("#perTx").value = String(start); document.querySelector("#perTx").dispatchEvent(new Event("input", { bubbles: true })); }, PER_TX_START); await scrollTo(page, "#rule .rule", "center"); },
    async rule(seg, ms) {
      await glow(page, "#rule .rule .card:first-child");
      await slide(page, "#perTx", PER_TX_FIVE, ms * 0.35);
      await sleep(ms * 0.1);
      await slide(page, "#perDay", 50, ms * 0.25);
      await glow(page, "#rule .rule .card:first-child", false);
    },

    async "prepare:approvals"() { await scrollTo(page, "#needs"); },
    async approvals() { await sleep(400); await glow(page, "#approvals > *:first-child"); },

    async "prepare:phone"() { await setPage(page, phoneHtml()); },
    async phone(seg, ms) {
      await reveal(page, ms * 0.6);
      await page.evaluate(() => document.getElementById("yes").classList.add("tap"));
      await sleep(500);
      await page.evaluate(() => document.getElementById("done").classList.add("on"));
    },

    async "prepare:approve"() { await openDemo(page); await scrollTo(page, "#needs"); await glow(page, "#approvals > *:first-child"); },
    async approve() {
      await sleep(600);
      const btn = page.locator('#approvals button[data-decision="approve"]').first();
      if (await btn.count()) { await btn.hover(); await sleep(400); await btn.click(); }
      await sleep(800);
    },

    async "prepare:flow"() { await setPage(page, flowHtml()); },
    async flow(seg, ms) { await reveal(page, ms); },
    async "prepare:check"() { await setPage(page, checkHtml()); },
    async check(seg, ms) { await reveal(page, ms); },
    async "prepare:stop"() { await setPage(page, stopHtml()); },
    async stop(seg, ms) { await reveal(page, ms * 0.7); },

    async "prepare:purchases"() { await openDemo(page); await scrollTo(page, "#buysSec"); },
    async purchases() { await sleep(500); await glow(page, "#buys"); await sleep(1800); await glow(page, "#buys", false); },

    async receipt(seg, ms) {
      await page.locator("#buys .buy").first().click();
      await page.waitForSelector("#rcBody .steps", { timeout: 15000 });
      await sleep(ms * 0.3);
      // Scroll the receipt to "What your agent got".
      await page.evaluate(() => { const d = document.getElementById("receipt"); const got = d.querySelector(".rc-sec:nth-of-type(2)") || d.querySelector(".headline"); d.scrollTo({ top: got ? got.offsetTop - 40 : d.scrollHeight / 2, behavior: "smooth" }); });
    },

    // The short video opens a receipt straight from the Purchases list.
    async "prepare:receipt-open"() { await openDemo(page); await scrollTo(page, "#buysSec"); },
    async "receipt-open"(seg, ms) { await sleep(600); await scenes.receipt(seg, ms - 600); },

    // The search bar: type a request, see the results, copy one for the agent.
    async "prepare:find"() {
      if (!page.url().includes("/demo")) await openDemo(page); // the short video comes here straight from a title card
      await page.evaluate(() => document.getElementById("receipt")?.close()); await scrollTo(page, "#finder"); await page.fill("#searchQ", "");
    },
    async find(seg, ms) {
      await glow(page, "#searchForm");
      await page.type("#searchQ", "bitcoin signal", { delay: 90 });
      await sleep(300);
      await page.press("#searchQ", "Enter");
      await page.waitForSelector("#searchOut .hit", { timeout: 15000 });
      await glow(page, "#searchForm", false);
      await sleep(ms * 0.25);
      await glow(page, "#searchOut .hit:first-of-type");
      const copy = page.locator("#searchOut .hit button[data-copy]").first();
      await copy.hover(); await sleep(500); await copy.click().catch(() => {});
    },
    // Categories and new providers.
    async "prepare:browse"() { await glow(page, "#searchOut .hit", false); await page.fill("#searchQ", ""); await scrollTo(page, "#searchCats", "center"); },
    async browse(seg, ms) {
      await sleep(ms * 0.15);
      await page.click('#searchCats button[data-cat="security"]').catch(() => {});
      await sleep(ms * 0.3);
      await page.click("#newBtn").catch(() => {});
      await sleep(400);
      await scrollTo(page, "#searchOut", "start");
    },

    async "prepare:agents"() { await page.evaluate(() => document.getElementById("receipt")?.close()); await scrollTo(page, "#agentsSec"); },
    async agents(seg, ms) {
      await glow(page, "#agents .agent");
      await sleep(ms * 0.45);
      await glow(page, "#agents .agent", false);
      await scrollTo(page, "#fizzlAgents", "center");
    },
  };

  for (const seg of script.segments) {
    const ms = Math.round((durations[seg.id] || 3) * 1000);
    const scene = scenes[seg.scene];
    if (!scene) throw new Error(`unknown scene ${seg.scene}`);
    // Page loads happen before the voice starts, so each line is heard over a finished page.
    if (scenes[`prepare:${seg.scene}`]) await scenes[`prepare:${seg.scene}`](seg, ms);
    let action = null;
    if (seg.scene === "card") await scene(seg, ms);
    else action = scene(seg, ms);
    if (process.env.CAPTIONS === "1") await caption(page, seg.text);
    const start = (Date.now() - t0) / 1000;
    timeline.push({ id: seg.id, start, duration: ms / 1000 });
    const minEnd = Date.now() + ms + 450;
    if (action) await action;
    const rest = minEnd - Date.now();
    if (rest > 0) await sleep(rest);
    console.log(`${seg.id}: ${start.toFixed(2)} s`);
  }
  await sleep(1200);
  const total = (Date.now() - t0) / 1000;

  const videoPath = await page.video().path();
  await context.close();
  await browser.close();
  fs.renameSync(videoPath, path.join(OUT, "screen.webm"));
  fs.writeFileSync(path.join(OUT, "timeline.json"), JSON.stringify({ total, segments: timeline }, null, 2));
  console.log(`recorded ${total.toFixed(1)} s`);
}

main().catch((err) => { console.error(err); process.exit(1); });
