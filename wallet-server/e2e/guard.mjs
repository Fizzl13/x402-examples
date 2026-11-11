// End-to-end run: no request leaves this machine. fetch() only reaches 127.0.0.1/localhost; E2E_REDIRECT (JSON,
// origin -> local origin) sends a public service to its local stand-in. Anything else is refused and logged, so the
// run also shows what the code would have called out to.
const map = JSON.parse(process.env.E2E_REDIRECT || "{}");
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  for (const [from, to] of Object.entries(map)) if (url.startsWith(from)) { url = to + url.slice(from.length); break; }
  const u = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) {
    console.error(`[e2e-blocked] ${u.origin}${u.pathname}`);
    throw new TypeError(`fetch failed (the e2e guard keeps ${u.host} out)`);
  }
  if (typeof input === "string" || input instanceof URL) return real(url, init);
  return real(new Request(url, input), init);
};
