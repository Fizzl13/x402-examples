// The check behind the watcher: one payment request in, one verdict out (go, caution or no_go), from Fizzl's free
// checks. Paying an x402 API: x402 Doctor's live web check (POST /api/diagnose) plus the endpoint's 30-day record in
// the x402 Trust Index (GET /api/trust). Signing a transaction, approval or signature: presign-guard's verdict-only
// check (POST /v1/check/quick, 10 free calls an hour). Nothing here pays or signs.
export const DOCTOR_URL = 'https://x402-doctor.fizzl.eu';
export const PRESIGN_URL = 'https://presign-guard.fizzl.eu';

const FROM_OVERALL = { pass: 'go', warn: 'caution', fail: 'no_go' };
const FROM_COLOUR = { green: 'go', orange: 'caution', red: 'no_go' };
const RANK = { go: 0, caution: 1, no_go: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);

async function json(fetchImpl, url, init) {
  const res = await fetchImpl(url, { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'fizzl-board-check/0.1' } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** checkPayment({ url, method } | { sign }) -> { verdict, service, reasons[], details } */
export async function checkPayment(request, { fetchImpl = fetch, doctorUrl = DOCTOR_URL, presignUrl = PRESIGN_URL } = {}) {
  if (request?.sign && typeof request.sign === 'object') {
    const { status, body } = await json(fetchImpl, `${presignUrl}/v1/check/quick`, { method: 'POST', body: JSON.stringify(request.sign) });
    const verdict = FROM_COLOUR[body?.verdict];
    if (!verdict) return { verdict: 'caution', service: 'presign-guard', reasons: [`no verdict (HTTP ${status}${body?.error ? `: ${body.error}` : ''})`], details: body };
    return { verdict, service: 'presign-guard', reasons: verdict === 'go' ? [] : ['presign-guard says ' + body.verdict + '; the paid check (POST /v1/check) gives the reasons and the fix'], details: body };
  }
  if (typeof request?.url !== 'string' || !/^https?:\/\//.test(request.url)) {
    return { verdict: 'caution', service: 'none', reasons: ['the request has neither a url nor a sign object'], details: null };
  }
  const method = request.method === 'POST' ? 'POST' : 'GET';
  const [live, record] = await Promise.all([
    json(fetchImpl, `${doctorUrl}/api/diagnose`, { method: 'POST', body: JSON.stringify({ url: request.url, method }) }),
    json(fetchImpl, `${doctorUrl}/api/trust?url=${encodeURIComponent(request.url)}`, { method: 'GET' }),
  ]);
  const reasons = [];
  let verdict = FROM_OVERALL[live.body?.overall];
  if (!verdict) {
    verdict = 'caution';
    reasons.push(`x402 Doctor could not check it now (HTTP ${live.status})`);
  }
  for (const c of live.body?.checks || []) {
    if (c.status === 'fail' || c.status === 'warn') reasons.push(`${c.status}: ${c.id}${c.message ? ` (${c.message})` : ''}`);
  }
  const last = record.body?.last_scan?.verdict;
  if (last && RANK[last] !== undefined) {
    verdict = worst(verdict, last);
    if (last !== 'go') reasons.push(`Trust Index scan today: ${last}${record.body.last_scan.codes?.length ? ` (${record.body.last_scan.codes.join(', ')})` : ''}`);
  }
  if (typeof record.body?.payable_ratio === 'number' && record.body.payable_ratio < 0.8) {
    verdict = worst(verdict, 'caution');
    reasons.push(`payable on ${Math.round(record.body.payable_ratio * 100)}% of the last ${record.body.days_checked} days`);
  }
  return { verdict, service: 'x402-doctor', reasons: reasons.slice(0, 6), details: { overall: live.body?.overall, record: record.body?.history ? { history: record.body.history, payable_ratio: record.body.payable_ratio } : null } };
}

const ICON = { go: '🟢 go', caution: '🟠 caution', no_go: '🔴 don\'t pay' };

/** The reply text for the board thread (Markdown, well under the 10,000-character limit). */
export function replyText(request, result) {
  const kind = request.sign?.type || 'transaction';
  const what = request.sign ? `signing ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}` : `paying ${request.url}`;
  const lines = [`**${ICON[result.verdict]}** for ${what} (${result.service})`];
  for (const r of result.reasons) lines.push(`- ${r}`);
  if (result.verdict === 'no_go') lines.push('', 'Do not pay or sign this. A person on the board can override with a reply.');
  else if (result.verdict === 'caution') lines.push('', 'Ask a person on the board before paying.');
  if (request.url) lines.push('', `Full check: ${DOCTOR_URL}/?url=${encodeURIComponent(request.url)}`);
  return lines.join('\n');
}
