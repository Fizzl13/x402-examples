import type { ICredentialTestRequest, ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

/**
 * Prepaid credit keys for the full checks. Both are optional: without a key the node uses the free quick
 * checks (the verdict only, a few per hour).
 */
export class FizzlApi implements ICredentialType {
	name = 'fizzlApi';

	displayName = 'Fizzl API';

	documentationUrl = 'https://github.com/Fizzl13/x402-examples/tree/main/n8n-fizzl#credentials';

	icon: Icon = 'file:fizzl.svg';

	properties: INodeProperties[] = [
		{
			displayName: 'Presign-Guard Credit Key',
			name: 'presignCreditKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'For Check Before Signing and Check Token. Buy a pack at https://presign-guard.fizzl.eu/v1/credits (100 checks for $0.80).',
		},
		{
			displayName: 'X402 Doctor Credit Key',
			name: 'doctorCreditKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'For Check Endpoint Before Paying. Buy a pack at https://x402-doctor.fizzl.eu/api/v1/credits (1000 preflights for $0.80).',
		},
	];

	// GET /v1/credits answers 400 invalid_key for a key that isn't one. Tests the presign-guard key when set, else the
	// x402 Doctor key; with no key at all it passes (the node then uses the free quick checks).
	test: ICredentialTestRequest = {
		request: {
			method: 'GET',
			url: '={{$credentials.presignCreditKey ? "https://presign-guard.fizzl.eu/v1/credits" : "https://x402-doctor.fizzl.eu/api/v1/credits"}}',
			headers: { 'x-credit-key': '={{$credentials.presignCreditKey || $credentials.doctorCreditKey}}' },
		},
	};
}
