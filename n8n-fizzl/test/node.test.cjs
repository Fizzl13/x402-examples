// Offline tests: the node's execute() with a fake n8n context and a fake httpRequest (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Fizzl, route } = require('../dist/nodes/Fizzl/Fizzl.node.js');
const { FizzlApi } = require('../dist/credentials/FizzlApi.credentials.js');

function ctx({ params, items = [{ json: {} }], creds = null, http, continueOnFail = false, type = 'n8n-nodes-fizzl.fizzl' }) {
	const calls = [];
	const node = { name: 'Fizzl', type, typeVersion: 1, parameters: {} };
	return {
		calls,
		getInputData: () => items,
		getNodeParameter: (name, i, fallback) => {
			const p = typeof params === 'function' ? params(i) : params;
			return name in p ? p[name] : fallback;
		},
		getCredentials: async () => {
			if (!creds) throw new Error('Node does not have any credentials set');
			return creds;
		},
		getNode: () => node,
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequest: async (opts) => {
				calls.push(opts);
				return http(opts);
			},
		},
	};
}

const ok = (body) => ({ statusCode: 200, body });
const paid = () => ({ statusCode: 402, body: { error: 'payment required' } });
const run = (c) => new Fizzl().execute.call(c);

test('route maps every verdict vocabulary to Go, Ask or Stop', () => {
	for (const v of ['go', 'green', 'SAFE']) assert.equal(route(v), 0);
	for (const v of ['caution', 'orange', 'ask', 'warn']) assert.equal(route(v), 1);
	for (const v of ['no_go', 'red', 'stop', 'DANGER', '', undefined, null]) assert.equal(route(v), 2);
});

test('description: three outputs, three operations, optional credentials', () => {
	const d = new Fizzl().description;
	assert.deepEqual(d.outputNames, ['Go', 'Ask', 'Stop']);
	assert.equal(d.outputs.length, 3);
	assert.deepEqual(d.properties[0].options.map((o) => o.value), ['checkEndpoint', 'checkSigning', 'checkToken']);
	assert.equal(d.credentials[0].name, 'fizzlApi');
	assert.equal(d.credentials[0].required, false);
	assert.equal(d.usableAsTool, true);
	const cred = new FizzlApi();
	assert.equal(cred.test.request.method, 'GET');
	assert.match(cred.test.request.url, /presign-guard\.fizzl\.eu\/v1\/credits/);
	assert.match(cred.test.request.headers['x-credit-key'], /presignCreditKey \|\| \$credentials\.doctorCreditKey/);
	assert.deepEqual(new FizzlApi().properties.map((p) => p.name), ['presignCreditKey', 'doctorCreditKey']);
	assert.ok(new FizzlApi().properties.every((p) => p.typeOptions.password));
});

test('endpoint, no credentials: free Doctor diagnose, fail maps to Stop', async () => {
	const c = ctx({
		params: { operation: 'checkEndpoint', url: 'https://api.example.com/data', endpointOptions: { maxUsd: 0.05 } },
		http: (o) => {
			assert.equal(o.method, 'POST');
			assert.equal(o.url, 'https://x402-doctor.fizzl.eu/api/diagnose');
			assert.deepEqual(o.body, { url: 'https://api.example.com/data' });
			assert.equal(o.headers['x-credit-key'], undefined);
			return ok({ overall: 'fail', share_url: 'https://x402-doctor.fizzl.eu/?url=x', checks: [
				{ id: 'returns-402', status: 'fail', message: 'No 402' },
				{ id: 'openapi-present', status: 'pass', message: 'ok' },
			] });
		},
	});
	const [go, ask, stop] = await run(c);
	assert.equal(go.length + ask.length, 0);
	assert.equal(stop.length, 1);
	assert.equal(stop[0].json.verdict, 'no_go');
	assert.equal(stop[0].json.free, true);
	assert.deepEqual(stop[0].json.problems, [{ status: 'fail', id: 'returns-402', message: 'No 402' }]);
	assert.match(stop[0].json.note, /\$0\.001/);
	assert.deepEqual(stop[0].pairedItem, { item: 0 });
});

test('endpoint with a Doctor credit key: paid preflight with query and header, receipt dropped, go maps to Go', async () => {
	const c = ctx({
		params: { operation: 'checkEndpoint', url: 'https://api.example.com/data', endpointOptions: { maxUsd: 0.05, network: 'eip155:8453', method: 'POST' } },
		creds: { doctorCreditKey: 'dk_test', presignCreditKey: '' },
		http: (o) => {
			assert.equal(o.method, 'GET');
			const u = new URL(o.url);
			assert.equal(u.origin + u.pathname, 'https://x402-doctor.fizzl.eu/api/v1/preflight');
			assert.equal(u.searchParams.get('url'), 'https://api.example.com/data');
			assert.equal(u.searchParams.get('max_usd'), '0.05');
			assert.equal(u.searchParams.get('network'), 'eip155:8453');
			assert.equal(u.searchParams.get('method'), 'POST');
			assert.equal(o.headers['x-credit-key'], 'dk_test');
			return ok({ verdict: 'go', summary: 'OK to pay: $0.02 on Base.', receipt: { sig: '0x' } });
		},
	});
	const [go] = await run(c);
	assert.equal(go.length, 1);
	assert.equal(go[0].json.summary, 'OK to pay: $0.02 on Base.');
	assert.equal(go[0].json.receipt, undefined);
	assert.equal(go[0].json.free, undefined);
	assert.equal(c.calls.length, 1);
});

test('used-up credit key (402) falls back to the free check', async () => {
	const c = ctx({
		params: { operation: 'checkToken', tokenChain: 'base', tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
		creds: { presignCreditKey: 'pk_empty' },
		http: (o) => (o.url.includes('/v1/token/quick?') ? ok({ verdict: 'green', grade: 'SAFE' }) : paid()),
	});
	const [go] = await run(c);
	assert.equal(c.calls.length, 2);
	assert.match(c.calls[0].url, /\/v1\/token\?chain=base&address=0x8335/);
	assert.equal(c.calls[1].headers['x-credit-key'], undefined);
	assert.equal(go.length, 1);
	assert.equal(go[0].json.free, true);
});

test('approval: free quick check gets the same body, orange maps to Ask', async () => {
	const max = (2n ** 256n - 1n).toString();
	const c = ctx({
		params: { operation: 'checkSigning', type: 'approval', chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: '0x000000000022D473030F116dDEE9F6B43aC78BA3', amount: max, signingOptions: { intent: 'Pay one API call' } },
		http: (o) => {
			assert.equal(o.url, 'https://presign-guard.fizzl.eu/v1/check/quick');
			assert.deepEqual(o.body, { type: 'approval', chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: '0x000000000022D473030F116dDEE9F6B43aC78BA3', amount: max, intent: 'Pay one API call' });
			return ok({ verdict: 'orange' });
		},
	});
	const [go, ask, stop] = await run(c);
	assert.equal(ask.length, 1);
	assert.equal(go.length + stop.length, 0);
});

test('signature: typed data JSON is parsed; transaction fields stay out', async () => {
	const typed = { domain: { name: 'Permit2' }, primaryType: 'PermitSingle', types: {}, message: {} };
	const c = ctx({
		params: { operation: 'checkSigning', type: 'signature', chainId: 1, typedData: JSON.stringify(typed), to: '0xdead', signingOptions: {} },
		http: (o) => {
			assert.deepEqual(o.body, { type: 'signature', chainId: 1, typedData: typed });
			return ok({ verdict: 'red' });
		},
	});
	const [, , stop] = await run(c);
	assert.equal(stop[0].json.verdict, 'red');
});

test('fails closed: no verdict and no key throws, or goes to Stop with continueOnFail', async () => {
	const params = { operation: 'checkToken', tokenChain: 'solana', tokenAddress: 'So11111111111111111111111111111111111111112' };
	const limited = () => ({ statusCode: 429, body: { error: 'rate_limited' } });
	await assert.rejects(run(ctx({ params, http: limited })), /payment_required/);
	const [go, ask, stop] = await run(ctx({ params, http: limited, continueOnFail: true }));
	assert.equal(go.length + ask.length, 0);
	assert.equal(stop[0].json.error, 'payment_required');
});

test('a network error goes to Stop with continueOnFail', async () => {
	const c = ctx({
		params: { operation: 'checkEndpoint', url: 'https://api.example.com', endpointOptions: {} },
		creds: { doctorCreditKey: 'dk' },
		http: () => { throw new Error('ECONNRESET'); },
		continueOnFail: true,
	});
	const [, , stop] = await run(c);
	assert.equal(stop[0].json.error, 'check_failed');
	assert.match(stop[0].json.message, /ECONNRESET/);
});

test('bad input is refused before any call', async () => {
	const bad = [
		{ operation: 'checkEndpoint', url: 'ftp://x', endpointOptions: {} },
		{ operation: 'checkSigning', type: 'transaction', chainId: 8453, to: '0x1', signingOptions: { from: 'me' } },
		{ operation: 'checkSigning', type: 'signature', chainId: 8453, typedData: '{not json', signingOptions: {} },
	];
	for (const params of bad) {
		const c = ctx({ params, http: () => assert.fail('no call expected') });
		await assert.rejects(run(c));
		assert.equal(c.calls.length, 0);
	}
});

test('several items keep their own routes and pairing', async () => {
	const verdicts = ['go', 'caution', 'no_go'];
	const c = ctx({
		items: [{ json: {} }, { json: {} }, { json: {} }],
		params: (i) => ({ operation: 'checkEndpoint', url: `https://api.example.com/${i}`, endpointOptions: {} }),
		creds: { doctorCreditKey: 'dk' },
		http: (o) => ok({ verdict: verdicts[Number(new URL(o.url).searchParams.get('url').slice(-1))] }),
	});
	const out = await run(c);
	assert.deepEqual(out.map((o) => o.map((x) => x.pairedItem.item)), [[0], [1], [2]]);
});

test('as an AI agent tool every result goes to the first output, verdict included', async () => {
	const c = ctx({
		type: 'n8n-nodes-fizzl.fizzlTool',
		params: { operation: 'checkToken', tokenChain: 'base', tokenAddress: '0xbad' },
		http: () => ok({ verdict: 'red', grade: 'DANGER' }),
	});
	const [first, ask, stop] = await run(c);
	assert.equal(first.length, 1);
	assert.equal(first[0].json.verdict, 'red');
	assert.equal(ask.length + stop.length, 0);
});
