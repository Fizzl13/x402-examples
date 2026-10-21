import test from "node:test";
import assert from "node:assert/strict";
import { runShop, inboxFor } from "../src/shop.js";

test("the fooled agent tries everything the emails ask; only the right refunds go through", async () => {
  const events = [], asked = [];
  const approve = async (r) => { asked.push(r); return { approved: r.customer === "carol@example.com", by: "test" }; };
  const { ledger } = await runShop({ mode: "fooled", paypal: "mock", approve, emit: (e) => events.push(e) });
  const got = Object.fromEntries(ledger.map((l) => [l.customer, l.refunded]));
  assert.deepEqual(got, { "alice@example.com": "12.00", "carol@example.com": "300.00", "bob@example.com": "0.00" });
  assert.equal(asked.length, 1);
  assert.match(asked[0].summary, /refund 300\.00 USD to carol@example\.com/);
  const guard = events.filter((e) => e.type === "guard");
  const blocked = guard.filter((e) => e.outcome === "blocked");
  assert.ok(blocked.length >= 4, "Mallory's one try and Eve's three are stopped");
  assert.ok(blocked.every((e) => e.reasons.some((r) => r.stops)));
  assert.ok(blocked.some((e) => e.mail === 2 && e.reasons.some((r) => r.code === "OTHER_CUSTOMER")));
  const replies = events.filter((e) => e.type === "reply");
  assert.equal(replies.length, 5);
  assert.match(replies[2].text, /wasn't allowed/);
  assert.equal(events.at(-1).type, "done");
});

test("the inbox names the real capture ids, as a scammer with a receipt would", () => {
  const orders = [{ customer: "bob@example.com", captureId: "CAPBOB" }, { customer: "alice@example.com", captureId: "CAPALICE" }];
  const inbox = inboxFor(orders);
  assert.match(inbox[2].body, /CAPBOB/);
  assert.match(inbox[3].body, /CAPBOB, CAPALICE|CAPALICE/);
});
