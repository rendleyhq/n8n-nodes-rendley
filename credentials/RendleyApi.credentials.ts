import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class RendleyApi implements ICredentialType {
	name = 'rendleyApi';

	displayName = 'Rendley API';

	icon: Icon = { light: 'file:rendley.svg', dark: 'file:rendley.dark.svg' };

	documentationUrl = 'https://docs.rendley.com/api/authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Your Rendley API key. Create one at app.rendley.com/settings.',
		},
		{
			displayName: 'API Base URL',
			name: 'apiBaseUrl',
			type: 'string',
			default: 'https://api.rendley.com/v1',
			description:
				'Base URL of the Rendley API. Leave the default unless Rendley gave you a different host.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.apiBaseUrl}}',
			url: '/users/me',
		},
	};
}
