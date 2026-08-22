import ljharb from '@ljharb/eslint-config/flat';

export default [
	...ljharb,
	{
		rules: {
			'func-name-matching': 'warn',
			'new-cap': [
				'error', {
					capIsNewExceptions: [
						'Call',
						'NewPromiseCapability',
						'Type',
					],
				},
			],
		},
	},
	{
		files: ['test/**'],
		rules: {
			'max-lines-per-function': 'off',
			'no-invalid-this': 'warn',
			'prefer-promise-reject-errors': 'off',
		},
	},
];
