/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseCodexModelSelection, toCodexModelSelectionId } from '../../../node/codex/codexAgent.js';

suite('CodexModelSelection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round trips provider and model identifiers', () => {
		const id = toCodexModelSelectionId('custom/provider', 'org/model:latest');
		assert.strictEqual(id, '@provider=custom%2Fprovider:org%2Fmodel%3Alatest');
		assert.deepStrictEqual(parseCodexModelSelection({ id }), {
			modelProvider: 'custom/provider',
			modelId: 'org/model:latest',
		});
	});

	test('a BYOK id stays intact behind the shared native provider; a bare id stays on the Copilot proxy', () => {
		assert.deepStrictEqual(
			[
				// allow-any-unicode-next-line
				parseCodexModelSelection({ id: 'customendpoint/Example/codex/gpt-5.6-sol' }),
				parseCodexModelSelection({ id: 'gpt-5.6-sol' }),
			],
			[
				// allow-any-unicode-next-line
				{ modelProvider: 'fumie-provider', modelId: 'customendpoint/Example/codex/gpt-5.6-sol' },
				{ modelProvider: 'vscode-proxy', modelId: 'gpt-5.6-sol' },
			],
		);
	});

	test('does not collide when display names match', () => {
		assert.notStrictEqual(
			toCodexModelSelectionId('vscode-proxy', 'gpt-5.6-sol'),
			toCodexModelSelectionId('openai', 'gpt-5.6-sol'),
		);
	});
});
