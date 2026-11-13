// Held-out set 4: a dropped connection as Node's HTTP client reports one (a code and its words), and how a plan sees it.

export function networkError(code, message) {
  return Object.assign(new Error(message), { code });
}

const DROPPED = /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b|socket hang up/;

// Calls go(req) and tries again after a dropped connection, at most twice more, as an agent with an HTTP tool does when
// the tool says the connection dropped. A thrown error (the plain clients) and an error answer (the safe-fetch agent's
// step, which turns a thrown error with a code into one) both count. Any other answer is returned as it is.
export function retrying(go) {
  return async (req) => {
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await go(req);
      } catch (err) {
        if (!DROPPED.test(`${err?.code ?? ""} ${err?.message ?? ""}`)) throw err;
        r = { status: null, text: err.message, json: { error: err.code } };
      }
      if (!(r.status === null && DROPPED.test(`${r.json?.refused ?? r.json?.error ?? ""} ${r.text ?? ""}`))) return r;
    }
    return r;
  };
}
