import { test } from "node:test";
import assert from "node:assert/strict";
import { readAttention, readCloud, combine } from "./attention-check.mjs";

const attention = (trend, voices = {}) => ({
  success: true,
  data: {
    at: "2026-11-14T20:00:00Z",
    windows: [
      { window: "1h", mentions: 40, previous: 20, change_pct: 100, per_hour: 40, trend: "accelerating" },
      { window: "24h", mentions: 600, previous: 400, change_pct: 50, per_hour: 25, trend },
    ],
    last_hour_voices: { sampled_posts: 50, distinct_accounts: 30, duplicate_share: 0.1, top_account_share: 0.05, shill_suspected: false, shill_reasons: [], ...voices },
  },
});
const cloud = (interval, position) => readCloud({ interval, timestamp: "2026-11-14T20:00:00Z", price: 1, cloud_position: position, signal: "neutral" });
const below = [cloud("4h", "below_cloud"), cloud("1d", "below_cloud")];
const above = [cloud("4h", "above_cloud"), cloud("1d", "above_cloud")];
const mixed = [cloud("4h", "above_cloud"), cloud("1d", "below_cloud")];

test("reads the 24h window as the lean, with the last hour and the voices", () => {
  const a = readAttention(attention("building"));
  assert.equal(a.lean, "rising");
  assert.deepEqual(a.lead, { window: "24h", mentions: 600, changePct: 50, trend: "building" });
  assert.deepEqual(a.hour, { mentions: 40, trend: "accelerating" });
  assert.equal(a.voices.accounts, 30);
  assert.equal(readAttention(attention("cooling")).lean, "fading");
  assert.equal(readAttention(attention("steady")).lean, "flat");
  assert.equal(readAttention({ success: true, data: {} }).available, false);
});

test("the read: attention against or with the trend", () => {
  assert.equal(combine({ attention: readAttention(attention("accelerating")), clouds: below }).verdict, "hype_against_trend");
  assert.equal(combine({ attention: readAttention(attention("building")), clouds: above }).verdict, "talk_confirms_trend");
  assert.equal(combine({ attention: readAttention(attention("quiet")), clouds: above }).verdict, "quiet_uptrend");
  assert.equal(combine({ attention: readAttention(attention("cooling")), clouds: below }).verdict, "fading_both");
  assert.equal(combine({ attention: readAttention(attention("building")), clouds: mixed }).verdict, "no_clear_read");
});

test("coordinated talk comes first, whatever the trend", () => {
  const r = combine({ attention: readAttention(attention("accelerating", { shill_suspected: true, shill_reasons: ["one account 60% of posts"] })), clouds: above });
  assert.equal(r.verdict, "suspect_talk");
  assert.match(r.read, /one account 60% of posts/);
});

test("no attention data: says so and still gives the cloud", () => {
  const r = combine({ attention: readAttention({}), clouds: below });
  assert.equal(r.verdict, "no_read");
  assert.match(r.read, /below cloud on 4h/);
});
