/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { renderMultilineInput } from '../../browser/agentSettingsForm.js';

suite('Sessions - Agent Settings form', () => {

	const testDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('renderMultilineInput renders a textarea (not a single-line input) and only commits on save', () => {
		const store = testDisposables.add(new DisposableStore());
		const saved: string[] = [];
		const control = renderMultilineInput(store, 'initial value', 'My Setting', 'Save', value => saved.push(value));

		const textarea = control.querySelector('textarea');
		assert.ok(textarea, 'expected a <textarea>, not a single-line <input>');
		assert.strictEqual(textarea.value, 'initial value');
		assert.strictEqual(textarea.ariaLabel, 'My Setting');

		// Typing (including newlines) must not commit anything by itself.
		textarea.value = 'first line\nsecond line';
		assert.deepStrictEqual(saved, []);

		const button = control.querySelector('.monaco-button') as HTMLElement | null;
		assert.ok(button, 'expected the save button');
		assert.strictEqual(button!.textContent, 'Save');
		button!.click();

		assert.deepStrictEqual(saved, ['first line\nsecond line']);
	});
});
