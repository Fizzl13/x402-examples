// The crowding check: reading funding, positioning and the cloud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFunding, readPositioning, readCloud, combine, rate8h } from "./crowding-check.mjs";

const funding = (...rates) => readFunding({ assets: [{ asset: "BTC", venues: rates.map((r, i) => (r === null ? { venue: `v${i}`, status: "unavailable" } : { venue: `v${i}`, status: "available", fundingRatePercent: r })) }] }, "BTC");
const clouds = (cloud) => ["4h", "1d"].map((interval) => readCloud({ interval, indicators: { ichimoku: { cloud_position: cloud } } }));

test("funding: withheld venues are listed, not averaged; the lean needs every venue to agree", () => {
  const f = funding(0.012, 0.015, null);
  assert.equal(f.lean, "longs_paying");
  assert.deepEqual(f.withheld, ["v2"]);
  assert.equal(funding(0.012, -0.001).lean, "balanced");
  assert.equal(funding(0.005, 0.004).lean, "balanced", "positive but at baseline");
  assert.equal(funding(null).available, false);
  const wrapped = readFunding({ serviceId: "perp-funding-rates", generatedAt: "2026-09-25T12:00:00Z", data: { assets: [{ asset: "ETH", venues: [{ venue: "okx", status: "available", fundingRatePercent: -0.02 }] }] } }, "ETH");
  assert.equal(wrapped.available, true, "rows inside the report envelope are found");
  assert.equal(wrapped.lean, "too_few_venues", "one live venue cannot set the crowd");
  assert.equal(wrapped.liveVenues, 1);
  assert.equal(wrapped.generatedAt, "2026-09-25T12:00:00Z");
});

test("positioning: long/short found by shape, change fields ignored", () => {
  const p = readPositioning({ asOfDate: "2026-09-22", leveragedFunds: { long: 30000, short: 12000, longChange: 99999 } });
  assert.equal(p.lean, "crowded_long");
  assert.equal(p.reportDate, "2026-09-22");
  assert.equal(readPositioning({ data: { leveraged_funds: { longPositions: 5000, shortPositions: 15000 } } }).lean, "crowded_short");
  assert.equal(readPositioning({ note: "sparse" }).available, false);
});

test("the read: crowd against the trend is flagged; positioning alone never sets the crowd", () => {
  const crowdedLong = readPositioning({ leveragedFunds: { long: 3, short: 1 } });
  const crowdedShort = readPositioning({ leveragedFunds: { long: 1, short: 3 } });
  assert.equal(combine({ funding: funding(0.02, 0.02), positioning: crowdedLong, clouds: clouds("below_cloud") }).verdict, "caution");
  assert.equal(combine({ funding: funding(-0.02, -0.02), positioning: crowdedShort, clouds: clouds("above_cloud") }).verdict, "squeeze_risk");
  assert.equal(combine({ funding: funding(0.0, 0.001), positioning: crowdedShort, clouds: clouds("above_cloud") }).verdict, "no_crowding_signal");
  assert.equal(combine({ funding: funding(0.02, 0.02), positioning: crowdedShort, clouds: clouds("below_cloud") }).verdict, "no_crowding_signal", "funding and positioning disagree");
  assert.equal(combine({ funding: funding(0.02, 0.02), positioning: crowdedLong, clouds: [...clouds("below_cloud").slice(0, 1), ...clouds("above_cloud").slice(1)] }).verdict, "no_crowding_signal", "mixed trend");
  const oneVenue = combine({ funding: funding(0.03, null, null), positioning: crowdedLong, clouds: clouds("below_cloud") });
  assert.equal(oneVenue.verdict, "no_crowding_signal", "OKX alone is not a crowd, even with positioning agreeing");
  assert.match(oneVenue.read, /only 1 of 3 venues/);
  assert.match(combine({ funding: funding(0.02, 0.02, null), positioning: crowdedLong, clouds: clouds("below_cloud") }).read, /\(2 of 3 venues\)/);
});

test("funding is compared per 8 hours: Edge's 8h field, then the given interval, then the venue's usual one", () => {
  assert.deepEqual(rate8h({ venue: "hyperliquid", fundingRatePercent: 0.00125, fundingRate8hPercent: 0.01, fundingIntervalHours: 1 }), { rate: 0.01, intervalHours: 1, estimated: false });
  assert.deepEqual(rate8h({ venue: "hyperliquid", fundingRatePercent: 0.00125, fundingIntervalHours: 1 }), { rate: 0.01, intervalHours: 1, estimated: false });
  assert.deepEqual(rate8h({ venue: "hyperliquid", fundingRatePercent: 0.00125 }), { rate: 0.01, intervalHours: 1, estimated: true });
  assert.deepEqual(rate8h({ venue: "okx", fundingRatePercent: 0.003 }), { rate: 0.003, intervalHours: 8, estimated: true });
  assert.equal(rate8h({ venue: "okx" }), null);
  // Today's live mix: hourly venues were understated 8x before normalising.
  const f = readFunding({ assets: [{ asset: "BTC", venues: [
    { venue: "okx", status: "available", fundingRatePercent: 0.003395 },
    { venue: "hyperliquid", status: "available", fundingRatePercent: 0.00125 },
    { venue: "dydx", status: "available", fundingRatePercent: 0 },
    { venue: "deribit", status: "available", fundingRatePercent: -0.000007 },
  ] }] }, "BTC");
  assert.equal(f.per, "8h");
  assert.ok(Math.abs(f.averagePercent - (0.003395 + 0.01 + 0 - 0.000007) / 4) < 1e-12);
  assert.equal(f.venues.find((v) => v.venue === "hyperliquid").estimatedInterval, true);
});
