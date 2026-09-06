/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isModelProviderEnvironmentVariable, scrubModelProviderEnvironment, withoutModelProviderEnvironment } from '../../node/modelProviderEnvironment.js';

suite('ModelProviderEnvironment', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognizes provider credentials and endpoints without matching ordinary runtime settings', () => {
		assert.deepStrictEqual({
			anthropicKey: isModelProviderEnvironmentVariable('ANTHROPIC_API_KEY'),
			anthropicUrl: isModelProviderEnvironmentVariable('anthropic_base_url'),
			openAiKey: isModelProviderEnvironmentVariable('OPENAI_API_KEY'),
			geminiKey: isModelProviderEnvironmentVariable('GEMINI_API_KEY'),
			deepSeekKey: isModelProviderEnvironmentVariable('DEEPSEEK_API_KEY'),
			claudeBedrock: isModelProviderEnvironmentVariable('CLAUDE_CODE_USE_BEDROCK'),
			claudeManaged: isModelProviderEnvironmentVariable('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'),
			ollamaHost: isModelProviderEnvironmentVariable('OLLAMA_HOST'),
			path: isModelProviderEnvironmentVariable('PATH'),
			githubToken: isModelProviderEnvironmentVariable('GITHUB_TOKEN'),
			fumieHome: isModelProviderEnvironmentVariable('FUMIE_HOME'),
		}, {
			anthropicKey: true,
			anthropicUrl: true,
			openAiKey: true,
			geminiKey: true,
			deepSeekKey: true,
			claudeBedrock: true,
			claudeManaged: true,
			ollamaHost: true,
			path: false,
			githubToken: false,
			fumieHome: false,
		});
	});

	test('scrubs in place and reports names without values', () => {
		const environment: NodeJS.ProcessEnv = {
			PATH: '/bin',
			ANTHROPIC_BASE_URL: 'https://wrong.example',
			ANTHROPIC_API_KEY: 'secret',
			OPENAI_API_KEY: 'other-secret',
			GITHUB_TOKEN: 'keep-for-tools',
		};
		assert.deepStrictEqual(scrubModelProviderEnvironment(environment).sort(), [
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_BASE_URL',
			'OPENAI_API_KEY',
		]);
		assert.deepStrictEqual(environment, { PATH: '/bin', GITHUB_TOKEN: 'keep-for-tools' });
	});

	test('copy helper does not mutate its input', () => {
		const source: NodeJS.ProcessEnv = { PATH: '/bin', ANTHROPIC_API_KEY: 'secret' };
		assert.deepStrictEqual(withoutModelProviderEnvironment(source), { PATH: '/bin' });
		assert.strictEqual(source.ANTHROPIC_API_KEY, 'secret');
	});
});
