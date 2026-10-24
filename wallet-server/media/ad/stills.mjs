// The ad's stills, drawn by a real browser at 1920×1080: a transparent title card per scene (headline, sub line,
// a soft dark gradient behind them so they read over any footage) and the wallet's approve page with example data
// for the "pay from your own wallet" scene. compose.py lays them over the Higgsfield footage.
//
//   node stills.mjs            # writes out/titles/<scene id>.png and out/approve.png
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(HERE, "out");
const ad = JSON.parse(fs.readFileSync(path.join(HERE, "ad.json"), "utf8"));
const APPROVE = path.join(HERE, "..", "..", "public", "approve.html");
fs.mkdirSync(path.join(OUT, "titles"), { recursive: true });

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700;800&family=Inter:wght@400;500;600&display=block" rel="stylesheet">`;
const BASE = `html,body{margin:0;width:1920px;height:1080px;background:transparent;overflow:hidden;color:#f4f8f7;font-family:Inter,Arial,sans-serif}`;

// A headline over footage: lower left, with a gradient behind it. The end card and the big number are centred; next
// to the phone (an image scene) the headline sits in the left column.
function titleHtml(s) {
  const centred = s.end || /^[\d,.+]+$/.test(s.title);
  const shade = centred
    ? "radial-gradient(ellipse 60% 55% at 50% 50%, rgba(2,7,8,.72), rgba(2,7,8,0) 75%)"
    : s.image ? "linear-gradient(to right, rgba(2,7,8,.85) 0%, rgba(2,7,8,.5) 45%, rgba(2,7,8,0) 60%)"
    : "linear-gradient(to top, rgba(2,7,8,.88) 0%, rgba(2,7,8,.55) 28%, rgba(2,7,8,0) 55%)";
  const big = s.end ? 168 : centred ? 220 : s.image ? 76 : s.title.length > 28 ? 84 : 96;
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE}
    .shade{position:absolute;inset:0;background:${shade}}
    .box{position:absolute;${centred ? "inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center" : s.image ? "left:120px;width:880px;top:50%;transform:translateY(-50%)" : "left:120px;right:120px;bottom:120px"}}
    h1{font-family:Unbounded,Arial,sans-serif;font-weight:${centred ? 800 : 700};font-size:${big}px;line-height:1.04;letter-spacing:${centred ? -6 : -3}px;margin:0;max-width:1400px;text-wrap:balance;text-shadow:0 4px 40px rgba(0,0,0,.5)}
    h1 .m{color:#61f5c3}
    .sub{margin-top:${centred ? 26 : 22}px;font-size:${centred ? 44 : 38}px;font-weight:500;color:#cfe9e1;letter-spacing:-.3px}
    .note{margin-top:34px;display:inline-block;font-size:30px;font-weight:600;color:#020708;background:#61f5c3;border-radius:999px;padding:14px 34px}
    .bar{width:96px;height:8px;border-radius:4px;background:#61f5c3;margin:${centred ? "0 auto 34px" : "0 0 30px"}}
  </style></head><body><div class="shade"></div><div class="box">
    ${s.end ? "" : '<div class="bar"></div>'}
    <h1>${s.end ? 'FIZZL<span class="m">.EU</span>' : centred ? `<span class="m">${esc(s.title)}</span>` : esc(s.title).replace(/\n/g, "<br>")}</h1>
    ${s.sub ? `<div class="sub">${esc(s.sub)}</div>` : ""}
    ${s.note ? `<div class="note">${esc(s.note)}</div>` : ""}
  </div></body></html>`;
}

// The approve page with example data: a Claude connector paying a weather API, payable with any of the three wallets.
const EXAMPLE = {
  status: "waiting", agent: "Claude connector", seller: "weather.example", url: "https://weather.example/forecast?city=Amsterdam", method: "GET",
  reason: "Amsterdam forecast", price: "0.002", token: "USDC", network: "Base", payTo: "0x7a3f9c2e41b05d8e6a1f3c9b2d4e8f0a1b2cc91e", from: null, pick: true,
  screened: true, record: { known: true, days: 30, payableDays: 30, verdict: "go" },
  options: { base: { price: "0.002", payTo: "0x7a3f9c2e41b05d8e6a1f3c9b2d4e8f0a1b2cc91e" }, solana: { price: 0.002, payTo: "7xKpQw3mN9vB2cR5tY8uZ1aD4fG6hJ0kL3pS5wE9qT2" }, xrpl: { price: 0.002, payTo: "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY", seconds: 300 } },
  xaman: null, paidWith: null, note: null, expiresAt: Date.now() + 15 * 60_000, error: null, result: null,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
for (const s of ad.scenes) {
  await page.setContent(titleHtml(s), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, "titles", `${s.id}.png`), omitBackground: true });
}

// A phone bezel around the window compose.py scrolls the approve page in (PHONE in compose.py: x, y, width, height).
const [PX, PY, PW, PH] = [1130, 90, 560, 900];
await page.setContent(`<!doctype html><html><head><style>${BASE}
  .ph{position:absolute;left:${PX - 18}px;top:${PY - 18}px;width:${PW}px;height:${PH}px;border:18px solid #0b1416;border-radius:62px;
      box-shadow:0 0 0 2px rgba(97,245,195,.55),0 30px 90px rgba(0,0,0,.65),0 0 120px rgba(97,245,195,.18)}
</style></head><body><div class="ph"></div></body></html>`);
await page.screenshot({ path: path.join(OUT, "phone-frame.png"), omitBackground: true });

// The approve page on a phone-sized viewport at 3× for a sharp picture.
const phone = await browser.newPage({ viewport: { width: 420, height: 1240 }, deviceScaleFactor: 2.5 });
await phone.route("https://wallet.fizzl.eu/approve/example", (r) => r.fulfill({ contentType: "text/html", body: fs.readFileSync(APPROVE, "utf8") }));
await phone.route("https://wallet.fizzl.eu/connector/payments/example", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(EXAMPLE) }));
await phone.goto("https://wallet.fizzl.eu/approve/example", { waitUntil: "networkidle" });
await phone.waitForSelector(".card");
await phone.evaluate(() => document.fonts.ready);
await phone.screenshot({ path: path.join(OUT, "approve.png"), fullPage: false });
await browser.close();
console.log("stills written to", OUT);
