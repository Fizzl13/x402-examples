// The Higgsfield clips for the Fizzl ad (clips.json), one Seedance 2.5 request each with the official SDK's
// subscribe, saved as out/<id>.mp4. A clip already in out/ is skipped, so a rerun only pays for what's missing.
// Stops with a non-zero exit on the first request that doesn't complete with a video (moderated, failed,
// canceled or an error), without claiming success. Credentials: HF_CREDENTIALS, as in index.js.
//
//   node clips.js        # billable: about $2.30 per 5-second 720p clip
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, higgsfield } from "@higgsfield/client/v2";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(HERE, ".env.local");
if (!process.env.HF_CREDENTIALS && fs.existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.HF_CREDENTIALS) { console.error("HF_CREDENTIALS is not set (environment or .env.local, format KEY_ID:KEY_SECRET)."); process.exit(1); }
config({ credentials: process.env.HF_CREDENTIALS });

const MODEL = "bytedance/seedance-2.5/text-to-video";
const { settings, clips } = JSON.parse(fs.readFileSync(path.join(HERE, "clips.json"), "utf8"));
const OUT = path.join(HERE, "out");
fs.mkdirSync(OUT, { recursive: true });

for (const clip of clips) {
  const file = path.join(OUT, `${clip.id}.mp4`);
  if (fs.existsSync(file)) { console.log(`${clip.id}: already there, skipped`); continue; }
  let result;
  try {
    result = await higgsfield.subscribe(MODEL, { input: { ...settings, prompt: clip.prompt }, withPolling: true });
  } catch (err) {
    console.error(`${clip.id}: request failed: ${err?.name ?? "Error"}: ${err?.message ?? err}`);
    process.exit(1);
  }
  const url = result?.video?.url;
  if (result?.status !== "completed" || !url) {
    const why = result?.status === "nsfw" ? "moderated (credits refunded)" : `${result?.status ?? "unknown"}${result?.error ? `: ${result.error}` : ""}`;
    console.error(`${clip.id}: no video, ${why} (request ${result?.request_id ?? "?"})`);
    process.exit(1);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) { console.error(`${clip.id}: completed, but downloading the video failed (HTTP ${res.status}): ${url}`); process.exit(1); }
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`${clip.id}: completed (request ${result.request_id}), ${fs.statSync(file).size} bytes\n${url}`);
}
