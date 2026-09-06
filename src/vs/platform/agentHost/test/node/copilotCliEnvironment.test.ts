/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createCopilotCliEnvironment } from '../../node/copilot/copilotCliEnvironment.js';

suite('CopilotCliEnvironment', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('drops ambient model Provider values while preserving ordinary tool environment', () => {
		const environment = createCopilotCliEnvironment({
			PATH: '/bin',
			GITHUB_TOKEN: 'tool-token',
			ANTHROPIC_BASE_URL: 'https://wrong.example',
			ANTHROPIC_API_KEY: 'wrong-anthropic',
			OPENAI_API_KEY: 'wrong-openai',
			GEMINI_API_KEY: 'wrong-gemini',
		});
		assert.deepStrictEqual({
			path: environment.PATH,
			githubToken: environment.GITHUB_TOKEN,
			anthropicUrl: environment.ANTHROPIC_BASE_URL,
			anthropicKey: environment.ANTHROPIC_API_KEY,
			openAiKey: environment.OPENAI_API_KEY,
			geminiKey: environment.GEMINI_API_KEY,
		}, {
			path: '/bin',
			githubToken: 'tool-token',
			anthropicUrl: undefined,
			anthropicKey: undefined,
			openAiKey: undefined,
			geminiKey: undefined,
		});
	});
});
