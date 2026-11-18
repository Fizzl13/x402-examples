import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

export const PRESIGN_URL = 'https://presign-guard.fizzl.eu';
export const DOCTOR_URL = 'https://x402-doctor.fizzl.eu';

const EVM_CHAINS = [
	{ name: 'Base (8453)', value: 8453 },
	{ name: 'Ethereum (1)', value: 1 },
	{ name: 'Arbitrum (42161)', value: 42161 },
	{ name: 'Optimism (10)', value: 10 },
	{ name: 'Polygon (137)', value: 137 },
	{ name: 'BNB Chain (56)', value: 56 },
	{ name: 'Avalanche (43114)', value: 43114 },
	{ name: 'Robinhood Chain (4663)', value: 4663 },
];

const TOKEN_CHAINS = ['solana', 'base', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'bsc', 'robinhood', 'avalanche', 'xrpl', 'algorand'];

/** Output 0 (Go): go / green / SAFE. Output 1 (Ask): caution / orange / ask. Output 2 (Stop): everything else. */
export function route(verdict: unknown): 0 | 1 | 2 {
	const v = String(verdict ?? '').toLowerCase();
	if (v === 'go' || v === 'green' || v === 'safe') return 0;
	if (v === 'caution' || v === 'orange' || v === 'ask' || v === 'warn') return 1;
	return 2;
}

type Call = { method: 'GET' | 'POST'; url: string; body?: IDataObject; service: 'presign' | 'doctor' };
type Free = () => Promise<IDataObject | undefined>;

const FREE_NOTE = (price: string) =>
	`Free quick check: the verdict only, a few per hour. The full check (reasons and details) costs ${price} with a prepaid credit key.`;

function compact(o: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
	return out;
}

export class Fizzl implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Fizzl',
		name: 'fizzl',
		icon: 'file:fizzl.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Check an x402 paid API before paying it, a transaction or signature before signing it, or a token before buying it. Routes each item to Go, Ask or Stop.',
		defaults: { name: 'Fizzl' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main, NodeConnectionTypes.Main],
		outputNames: ['Go', 'Ask', 'Stop'],
		usableAsTool: true,
		credentials: [{ name: 'fizzlApi', required: false }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'checkEndpoint',
				options: [
					{
						name: 'Check Endpoint Before Paying',
						value: 'checkEndpoint',
						action: 'Check an x402 endpoint before paying it',
						description: 'x402 Doctor preflight: go, caution or no_go, the cheapest option that settles, track record and bait signs',
					},
					{
						name: 'Check Before Signing',
						value: 'checkSigning',
						action: 'Check a transaction approval or signature before signing it',
						description: 'presign-guard: green, orange or red with reason codes, for EVM transactions, token approvals and typed-data signatures',
					},
					{
						name: 'Check Token',
						value: 'checkToken',
						action: 'Check a token before buying or accepting it',
						description: 'presign-guard: honeypot, rug-pull signs and look-alikes of known tokens',
					},
				],
			},

			// Check endpoint before paying
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://api.example.com/data',
				description: 'The x402 (or MPP) paid API you are about to pay',
				displayOptions: { show: { operation: ['checkEndpoint'] } },
			},
			{
				displayName: 'Options',
				name: 'endpointOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['checkEndpoint'] } },
				options: [
					{
						displayName: 'Max USD',
						name: 'maxUsd',
						type: 'number',
						typeOptions: { minValue: 0, numberPrecision: 4 },
						default: 0.05,
						description: 'Your budget for this call. An endpoint that asks more gets no_go.',
					},
					{
						displayName: 'Network',
						name: 'network',
						type: 'string',
						default: '',
						placeholder: 'eip155:8453',
						description: 'Only consider payment options on this network',
					},
					{
						displayName: 'Method',
						name: 'method',
						type: 'options',
						default: 'GET',
						options: [
							{ name: 'GET', value: 'GET' },
							{ name: 'POST', value: 'POST' },
						],
						description: 'The HTTP method you will call the endpoint with',
					},
				],
			},

			// Check before signing
			{
				displayName: 'Type',
				name: 'type',
				type: 'options',
				default: 'transaction',
				options: [
					{ name: 'Transaction', value: 'transaction' },
					{ name: 'Token Approval', value: 'approval' },
					{ name: 'Signature (Typed Data)', value: 'signature' },
				],
				displayOptions: { show: { operation: ['checkSigning'] } },
			},
			{
				displayName: 'Chain',
				name: 'chainId',
				type: 'options',
				default: 8453,
				options: EVM_CHAINS,
				displayOptions: { show: { operation: ['checkSigning'] } },
			},
			{
				displayName: 'To',
				name: 'to',
				type: 'string',
				default: '',
				placeholder: '0x…',
				description: 'The contract or address the transaction goes to',
				displayOptions: { show: { operation: ['checkSigning'], type: ['transaction'] } },
			},
			{
				displayName: 'Data',
				name: 'data',
				type: 'string',
				default: '',
				placeholder: '0x…',
				description: 'The transaction calldata',
				displayOptions: { show: { operation: ['checkSigning'], type: ['transaction'] } },
			},
			{
				displayName: 'Value (Wei)',
				name: 'value',
				type: 'string',
				default: '',
				displayOptions: { show: { operation: ['checkSigning'], type: ['transaction'] } },
			},
			{
				displayName: 'Token',
				name: 'token',
				type: 'string',
				default: '',
				placeholder: '0x…',
				description: 'The token the approval is for',
				displayOptions: { show: { operation: ['checkSigning'], type: ['approval'] } },
			},
			{
				displayName: 'Spender',
				name: 'spender',
				type: 'string',
				default: '',
				placeholder: '0x…',
				displayOptions: { show: { operation: ['checkSigning'], type: ['approval'] } },
			},
			{
				displayName: 'Amount',
				name: 'amount',
				type: 'string',
				default: '',
				description: 'The approved amount in the token\'s smallest unit',
				displayOptions: { show: { operation: ['checkSigning'], type: ['approval'] } },
			},
			{
				displayName: 'Typed Data (JSON)',
				name: 'typedData',
				type: 'json',
				default: '{}',
				description: 'The EIP-712 typed data the site asks you to sign (domain, types, primaryType, message)',
				displayOptions: { show: { operation: ['checkSigning'], type: ['signature'] } },
			},
			{
				displayName: 'Options',
				name: 'signingOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['checkSigning'] } },
				options: [
					{
						displayName: 'From (Your Wallet)',
						name: 'from',
						type: 'string',
						default: '',
						placeholder: '0x…',
						description: 'Your wallet address, so a transaction can be simulated',
					},
					{
						displayName: 'Intent',
						name: 'intent',
						type: 'string',
						default: '',
						placeholder: 'Pay $0.02 for one weather report',
						description: 'One sentence on what you mean to sign, to catch signing something else',
					},
					{
						displayName: 'Origin',
						name: 'origin',
						type: 'string',
						default: '',
						placeholder: 'https://app.example.com',
						description: 'The site or API that asks for the signature',
					},
				],
			},

			// Check token
			{
				displayName: 'Chain',
				name: 'tokenChain',
				type: 'options',
				default: 'base',
				options: TOKEN_CHAINS.map((c) => ({ name: c, value: c })),
				displayOptions: { show: { operation: ['checkToken'] } },
			},
			{
				displayName: 'Token Address',
				name: 'tokenAddress',
				type: 'string',
				default: '',
				required: true,
				description: 'The token\'s address (Solana mint, EVM contract, CURRENCY.rIssuer on the XRP Ledger, asset ID on Algorand)',
				displayOptions: { show: { operation: ['checkToken'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[][] = [[], [], []];
		// As an AI agent tool n8n reads only the first output: there every result goes to it, verdict included.
		const asTool = String(this.getNode().type ?? '').endsWith('Tool');
		let creds: IDataObject = {};
		try {
			creds = ((await this.getCredentials('fizzlApi')) as IDataObject) ?? {};
		} catch {
			creds = {}; // no credentials: the free quick checks
		}
		const keys = { presign: String(creds.presignCreditKey ?? ''), doctor: String(creds.doctorCreditKey ?? '') };

		const request = async (opts: IHttpRequestOptions) =>
			(await this.helpers.httpRequest({
				...opts,
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				timeout: 30000,
				headers: { accept: 'application/json', 'user-agent': 'n8n-nodes-fizzl/0.1.0', ...(opts.headers ?? {}) },
			})) as { statusCode: number; body: unknown };

		const run = async (call: Call, price: string, free: Free): Promise<IDataObject> => {
			const key = keys[call.service];
			if (key) {
				const res = await request({
					method: call.method,
					url: call.url,
					body: call.body,
					headers: { 'x-credit-key': key },
				});
				const body = (res.body ?? {}) as IDataObject;
				if (res.statusCode === 200 && typeof body === 'object') {
					delete body.receipt;
					return body;
				}
				if (res.statusCode !== 402) {
					const msg = (body && (body.error || body.message)) || `HTTP ${res.statusCode}`;
					return { error: `http_${res.statusCode}`, message: String(msg).slice(0, 300) };
				}
				// 402: the credit key is used up or wrong; fall back to the free check below
			}
			const quick = await free();
			if (quick && quick.verdict) {
				return { ...quick, free: true, note: FREE_NOTE(price) };
			}
			return {
				error: 'payment_required',
				message: key
					? 'The prepaid credit key was refused (used up or wrong) and the free quick check gave no verdict (a few per hour).'
					: 'The free quick check gave no verdict (a few per hour). Add a prepaid credit key in the Fizzl credentials for the full check.',
			};
		};

		const freeJson = async (opts: IHttpRequestOptions): Promise<IDataObject | undefined> => {
			try {
				const res = await request(opts);
				return res.statusCode === 200 && res.body && typeof res.body === 'object' ? (res.body as IDataObject) : undefined;
			} catch {
				return undefined;
			}
		};

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				let result: IDataObject;

				if (operation === 'checkEndpoint') {
					const url = String(this.getNodeParameter('url', i)).trim();
					if (!/^https?:\/\//.test(url)) throw new NodeOperationError(this.getNode(), 'URL must start with https://', { itemIndex: i });
					const o = this.getNodeParameter('endpointOptions', i, {}) as IDataObject;
					const qs = new URLSearchParams(compact({ url, max_usd: o.maxUsd, network: o.network, method: o.method }) as Record<string, string>);
					result = await run(
						{ service: 'doctor', method: 'GET', url: `${DOCTOR_URL}/api/v1/preflight?${qs}` },
						'$0.001',
						async () => {
							const d = await freeJson({ method: 'POST', url: `${DOCTOR_URL}/api/diagnose`, body: compact({ url, method: o.method }) });
							const verdict = ({ pass: 'go', warn: 'caution', fail: 'no_go' } as Record<string, string>)[String(d?.overall)];
							if (!d || !verdict) return undefined;
							const checks = Array.isArray(d.checks) ? (d.checks as IDataObject[]) : [];
							const problems = checks
								.filter((c) => c && (c.status === 'fail' || c.status === 'warn'))
								.slice(0, 6)
								.map((c) => ({ status: c.status, id: c.id, message: c.message }));
							return { verdict, problems, report: d.share_url };
						},
					);
				} else if (operation === 'checkSigning') {
					const type = this.getNodeParameter('type', i) as string;
					const o = this.getNodeParameter('signingOptions', i, {}) as IDataObject;
					const body: IDataObject = { type, chainId: this.getNodeParameter('chainId', i) as number };
					if (type === 'transaction') {
						Object.assign(body, compact({ to: this.getNodeParameter('to', i, ''), data: this.getNodeParameter('data', i, ''), value: this.getNodeParameter('value', i, '') }));
					} else if (type === 'approval') {
						Object.assign(body, compact({ token: this.getNodeParameter('token', i, ''), spender: this.getNodeParameter('spender', i, ''), amount: this.getNodeParameter('amount', i, '') }));
					} else {
						let typedData = this.getNodeParameter('typedData', i, '{}') as unknown;
						if (typeof typedData === 'string') {
							try {
								typedData = JSON.parse(typedData);
							} catch {
								throw new NodeOperationError(this.getNode(), 'Typed Data must be valid JSON', { itemIndex: i });
							}
						}
						body.typedData = typedData as IDataObject;
					}
					if (o.from && !/^0x[0-9a-fA-F]{40}$/.test(String(o.from))) {
						throw new NodeOperationError(this.getNode(), 'From must be a 0x wallet address', { itemIndex: i });
					}
					if (o.intent && String(o.intent).length > 500) {
						throw new NodeOperationError(this.getNode(), 'Intent must be one sentence (up to 500 characters)', { itemIndex: i });
					}
					Object.assign(body, compact({ from: o.from, intent: o.intent, origin: o.origin }));
					result = await run({ service: 'presign', method: 'POST', url: `${PRESIGN_URL}/v1/check`, body }, '$0.01', () =>
						freeJson({ method: 'POST', url: `${PRESIGN_URL}/v1/check/quick`, body }),
					);
				} else if (operation === 'checkToken') {
					const chain = this.getNodeParameter('tokenChain', i) as string;
					const address = String(this.getNodeParameter('tokenAddress', i)).trim();
					if (!address) throw new NodeOperationError(this.getNode(), 'Token Address is required', { itemIndex: i });
					const qs = new URLSearchParams({ chain, address });
					result = await run({ service: 'presign', method: 'GET', url: `${PRESIGN_URL}/v1/token?${qs}` }, '$0.01', () =>
						freeJson({ method: 'GET', url: `${PRESIGN_URL}/v1/token/quick?${qs}` }),
					);
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation ${operation}`, { itemIndex: i });
				}

				if (result.error && !this.continueOnFail()) {
					throw new NodeOperationError(this.getNode(), `${result.error}: ${result.message}`, { itemIndex: i });
				}
				// Fail closed: an error or an unknown verdict goes to Stop.
				out[asTool ? 0 : result.error ? 2 : route(result.verdict)].push({ json: result, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out[asTool ? 0 : 2].push({ json: { error: 'check_failed', message: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// NodeOperationError hands back an error that already is one, so this keeps our own messages
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return out;
	}
}
