// A small simulated internet for one run: hostnames map to in-process handlers. Nothing leaves the process; a host
// that isn't part of the scenario fails like one that does not resolve.
//
// A handler gets { method, url (URL), headers (Headers), body (string) } and returns a standard Response.

export class UnknownHostError extends Error {
  constructor(host) {
    super(`getaddrinfo ENOTFOUND ${host}`);
    this.code = "ENOTFOUND";
  }
}

export function createWorld() {
  const hosts = new Map();
  const log = [];

  function route(host, handler) {
    hosts.set(host.toLowerCase(), handler);
    return api;
  }

  // fetch(input, init) with the WHATWG signature, so the official x402 client can wrap it.
  async function fetch(input, init = {}) {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init.method || request?.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || request?.headers || {});
    let body = init.body ?? (request && method !== "GET" && method !== "HEAD" ? await request.text() : "");
    if (body && typeof body !== "string") body = typeof body.toString === "function" ? body.toString() : String(body);
    const handler = hosts.get(url.hostname.toLowerCase());
    if (!handler || url.protocol !== "https:") {
      log.push({ method, url: url.href, status: null });
      throw new UnknownHostError(url.hostname);
    }
    const res = await handler({ method, url, headers, body: body || "" });
    log.push({ method, url: url.href, status: res.status });
    return res;
  }

  // The fetch x402 Doctor's checks expect (lib/safe-fetch.js): { status, headers, url, text }.
  async function safeFetch(rawUrl, options = {}) {
    const res = await fetch(rawUrl, options);
    return { status: res.status, headers: res.headers, url: new URL(rawUrl).href, text: await res.text(), truncated: false, redirects: 0 };
  }

  const api = { route, fetch, safeFetch, log, hosts };
  return api;
}

export function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}
