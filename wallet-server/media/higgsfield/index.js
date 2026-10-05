// One Seedance 2.5 text-to-video clip from Higgsfield, with the official SDK's subscribe (it submits and
// polls until the request ends). Prints the video URL only when the request completed with a video;
// moderated, failed or canceled requests, and errors, exit non-zero without claiming success.
//
// Credentials stay server-side: HF_CREDENTIALS ("KEY_ID:KEY_SECRET") from the environment, or from
// .env.local next to this file (git-ignored). The value is never printed or logged.
//
//   node index.js                     # this makes a billable generation request
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, higgsfield } from "@higgsfield/client/v2";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(HERE, ".env.local");
if (!process.env.HF_CREDENTIALS && fs.existsSync(envFile)) process.loadEnvFile(envFile); // Node's own loader
if (!process.env.HF_CREDENTIALS) {
  console.error("HF_CREDENTIALS is not set (environment or .env.local, format KEY_ID:KEY_SECRET).");
  process.exit(1);
}
config({ credentials: process.env.HF_CREDENTIALS });

const MODEL = "bytedance/seedance-2.5/text-to-video";
const input = { prompt: "A cinematic scene at sunset", duration: 5, resolution: "720p", aspect_ratio: "16:9" };

try {
  const result = await higgsfield.subscribe(MODEL, { input, withPolling: true });
  const status = result?.status;
  const url = result?.video?.url;
  if (status === "completed" && url) {
    console.log(`completed (request ${result.request_id})`);
    console.log(url);
  } else if (status === "nsfw") {
    console.error(`moderated: the request was rejected by content moderation (request ${result.request_id}); credits are refunded.`);
    process.exitCode = 2;
  } else if (status === "failed" || status === "canceled" || status === "cancelled") {
    console.error(`${status}: no video (request ${result.request_id}).`);
    process.exitCode = 1;
  } else {
    console.error(`no video: the request ended with status "${status ?? "unknown"}"${status === "completed" ? " but without a video URL" : ""}.`);
    process.exitCode = 1;
  }
} catch (err) {
  // SDK errors (AuthenticationError, NotEnoughCreditsError, ValidationError, TimeoutError, …) carry no credentials.
  console.error(`request failed: ${err?.name ?? "Error"}: ${err?.message ?? err}`);
  process.exitCode = 1;
}
