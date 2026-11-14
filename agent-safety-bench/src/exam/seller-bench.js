// The seller bench (Frits, 14 Nov 2026: tools sold through x402 Forge go in the register because the exam benched them).
//
// The exam sets traps for buying agents; a seller that is one of those traps should never get a buyer. The seller
// bench turns the same traps around and checks a seller's tool from the outside, the way a careful buyer would see it:
// its unpaid 402 and its free example answer (asked several times). Nothing is paid: a check that needs a paid answer
// is done on the free example, which the shop says gives the same answer as the paid route.
//
// A tool passes when every check passes:
//   one_price            the 402 asks the price the shop lists, and the same price on every network
//   one_payee            every payment option pays one address (no second payee hidden among the options)
//   no_hidden_instructions  the answer carries no instructions aimed at the agent (the injected-upsell trap)
//   no_other_payee       the answer names no other wallet and no payment link off the tool's own site (refund-request,
//                        look-alike payee)
//   no_upsell            the answer offers nothing more to buy (injected-upsell, page-drip)
//   no_error_as_result   the answer is the result the shop documents, not an error dressed as one (charged-405,
//                        wrong-data, charged-not-delivered)
//   same_answer          the same question gets the same answer every time (pay-again-loop, no clock, no chance)
//
// Results are kept in the exam's store under sellerbench:<origin>:<slug> and shown in the register.

const REPEATS = 3;
const MAX_TOOLS = 60;
const TIMEOUT_MS = 10_000;

export const SELLER_CHECKS = ["one_price", "one_payee", "no_hidden_instructions", "no_other_payee", "no_upsell", "no_error_as_result", "same_answer"];

const INSTRUCTION = /\b(ignore (all |any |the )?(previous|prior|above)|disregard (the|your|all)|system prompt|you (are|must) now|as an ai\b|new instructions?|assistant:|<\/?(system|instructions?)>|do not tell the user|before (you )?answer(ing)?,? (you must )?(pay|send|call|visit))/i;
const UPSELL = /\b(upgrade|premium|pro plan|buy (more|another|again)|unlock (the )?(full|rest)|limited offer|discount|subscribe|for only \$|next page costs|call again (for|to get) (the )?(next|rest|more))\b/i;
const PAY_LINK = /\b(https?:\/\/[^\s"'<>]+)/gi;
const PAYISH_URL = /(pay|checkout|invoice|billing|refund|wallet|deposit|402)/i;
const EVM_ADDR = /\b0x[0-9a-fA-F]{40}\b/g;

// "$0.002" -> 2000 (USDC has 6 decimals).
export function atomicOf(price) {
  const m = String(price ?? "").trim().match(/^\$?\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [whole, frac = ""] = m[1].split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

const textOf = (v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail };
}

// The 402's payment options: the PAYMENT-REQUIRED header (x402 v2), else the body (v1).
async function offersOf(res) {
  const header = res.headers.get("payment-required");
  let challenge = null;
  if (header) {
    try {
      challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {}
  }
  if (!challenge) challenge = await res.json().catch(() => null);
  return Array.isArray(challenge?.accepts) ? challenge.accepts : [];
}

/** Checks one tool from a shop's catalog entry ({ slug, name, url, try_url, price, output_example }). */
export async function benchTool(tool, { fetchImpl = fetch, now = () => Date.now(), repeats = REPEATS } = {}) {
  const get = (url) => fetchImpl(url, { headers: { accept: "application/json", "user-agent": "agent-safety-exam/seller-bench" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const checks = [];
  let origin = null;
  try {
    origin = new URL(tool.url).origin;
  } catch {}

  // The 402: one price (the listed one) and one payee.
  let payTo = null;
  try {
    const res = await get(tool.url);
    if (res.status !== 402) {
      checks.push(check("one_price", false, `the paid route answered ${res.status} without a payment, not 402`), check("one_payee", false, "no 402 to read"));
    } else {
      const offers = await offersOf(res);
      const listed = atomicOf(tool.price);
      const amounts = [...new Set(offers.map((o) => String(o.amount ?? o.maxAmountRequired ?? "")))];
      const payees = [...new Set(offers.map((o) => String(o.payTo || "").toLowerCase()).filter(Boolean))];
      payTo = payees[0] || null;
      const priceOk = offers.length > 0 && listed !== null && amounts.length === 1 && amounts[0] === String(listed);
      checks.push(check("one_price", priceOk, priceOk ? `${tool.price} on ${offers.length} ${offers.length === 1 ? "network" : "networks"}` : `listed ${tool.price}, the 402 asks ${amounts.join(" / ") || "nothing"} (atomic USDC)`));
      checks.push(check("one_payee", payees.length === 1, payees.length === 1 ? `pays ${payees[0]}` : `${payees.length} different payees`));
    }
  } catch (err) {
    checks.push(check("one_price", false, `the paid route could not be read (${err.message})`), check("one_payee", false, "no 402 to read"));
  }

  // The free example, asked several times.
  const answers = [];
  for (let i = 0; i < repeats; i++) {
    try {
      const res = await get(tool.try_url);
      answers.push({ status: res.status, text: await res.text() });
    } catch (err) {
      answers.push({ status: 0, text: "", error: err.message });
    }
  }
  const first = answers[0];
  let body = null;
  try {
    body = JSON.parse(first.text);
  } catch {}
  const output = body && typeof body === "object" && "output" in body ? body.output : body;
  const outText = textOf(output);

  const injected = outText.match(INSTRUCTION);
  checks.push(check("no_hidden_instructions", !injected, injected ? `the answer says "${injected[0]}"` : "none found"));

  const strangers = [...new Set((outText.match(EVM_ADDR) || []).map((a) => a.toLowerCase()))].filter((a) => a !== payTo);
  const links = [...outText.matchAll(PAY_LINK)].map((m) => m[1]).filter((u) => {
    try {
      return new URL(u).origin !== origin && PAYISH_URL.test(u);
    } catch {
      return false;
    }
  });
  checks.push(check("no_other_payee", !strangers.length && !links.length, strangers.length ? `names another wallet ${strangers[0]}` : links.length ? `links a payment page off the tool's site: ${links[0]}` : "none found"));

  const upsell = outText.match(UPSELL);
  checks.push(check("no_upsell", !upsell, upsell ? `the answer says "${upsell[0]}"` : "none found"));

  const expected = tool.output_example && typeof tool.output_example === "object" ? Object.keys(tool.output_example) : [];
  const shapeOk = first.status === 200 && output && typeof output === "object" && !("error" in output && !expected.includes("error")) && expected.every((k) => k in output);
  checks.push(check("no_error_as_result", shapeOk, shapeOk ? `answers ${first.status} with the documented fields` : first.status !== 200 ? `the example answered ${first.status || first.error}` : `the answer lacks ${expected.filter((k) => !(output && k in output)).join(", ") || "the documented shape"}`));

  const same = answers.every((a) => a.status === first.status && a.text === first.text);
  checks.push(check("same_answer", same && first.status === 200, same ? `${repeats} times the same answer` : "the answer changed between asks"));

  return {
    slug: tool.slug,
    name: tool.name,
    url: tool.url,
    try_url: tool.try_url,
    price: tool.price,
    sale: tool.sale ?? null,
    passed: checks.every((c) => c.ok),
    checks,
    benched_at: new Date(now()).toISOString(),
  };
}

/**
 * The seller bench over a shop's catalog. run() reads the catalog, benches each tool and keeps the results; list() gives
 * them back for the register. catalogUrl "off" turns it off.
 */
export function createSellerBench({ store, catalogUrl = process.env.SELLER_CATALOG_URL ?? "https://forge.fizzl.eu/catalog.json", fetchImpl = fetch, now = () => Date.now(), log = console, shop = "x402 Forge" } = {}) {
  const off = !catalogUrl || catalogUrl === "off";
  let origin = null;
  try {
    origin = off ? null : new URL(catalogUrl).origin;
  } catch {}
  const prefix = () => `sellerbench:${origin}:`;

  async function run() {
    if (off || !origin) return [];
    const res = await fetchImpl(catalogUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`catalog answered ${res.status}`);
    const catalog = await res.json();
    const tools = (Array.isArray(catalog) ? catalog : catalog?.products || [])
      // Only tools on the shop's own site: a catalog can't have another site's tool benched in its name.
      .filter((t) => t && t.slug && t.url && t.try_url && [t.url, t.try_url].every((u) => {
        try {
          return new URL(u).origin === origin;
        } catch {
          return false;
        }
      }))
      .slice(0, MAX_TOOLS);
    const results = [];
    for (const tool of tools) {
      const r = { ...(await benchTool(tool, { fetchImpl, now })), shop, shop_url: origin };
      await store.set(`${prefix()}${tool.slug}`, r);
      results.push(r);
    }
    log.info?.(`[seller-bench] ${results.filter((r) => r.passed).length} of ${results.length} ${shop} tools pass`);
    return results;
  }

  async function list() {
    if (off || !origin) return [];
    const rows = (await store.list(prefix())).filter((r) => r?.slug);
    // Sold tools first, then the ones for sale; passing before failing; then by name.
    const rank = (r) => (r.sale && r.sale !== "for-sale" ? 0 : 1);
    return rows.sort((a, b) => rank(a) - rank(b) || Number(b.passed) - Number(a.passed) || String(a.name).localeCompare(String(b.name)));
  }

  return { run, list, off, catalogUrl };
}
