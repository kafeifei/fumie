/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mergeProviderModelList } from '../../common/providerModelListRefresh.js';

suite('Sessions - Provider model list refresh', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const BASE = 'https://llm.example.com/v1';

	test('keeps entries still served upstream verbatim, including hand-tuned metadata', () => {
		const existing = [
			{ id: 'claude-fable-5', url: BASE, thinking: true, fumieHarnesses: ['claude', 'pi'], maxInputTokens: 1000000 },
			{ id: 'gpt-5.5', url: BASE, toolCalling: true },
		];
		const merge = mergeProviderModelList(existing, [{ id: 'claude-fable-5' }, { id: 'gpt-5.5' }], BASE);
		assert.deepStrictEqual(merge.added, []);
		assert.deepStrictEqual(merge.removed, []);
		assert.deepStrictEqual(merge.models, existing);
	});

	test('removes entries the provider no longer serves', () => {
		const existing = [
			{ id: 'claude-sonnet-5', url: BASE },
			{ id: 'claude-fable-5', url: BASE },
		];
		const merge = mergeProviderModelList(existing, [{ id: 'claude-fable-5' }], BASE);
		assert.deepStrictEqual(merge.removed, ['claude-sonnet-5']);
		assert.deepStrictEqual(merge.models.map(model => model['id']), ['claude-fable-5']);
	});

	test('new ids copy metadata from the longest-prefix sibling', () => {
		const existing = [
			{ id: 'claude-opus-4-8', url: BASE, thinking: true, fumieHarnesses: ['claude'], maxOutputTokens: 64000 },
			{ id: 'gpt-5.5', url: BASE, toolCalling: true },
		];
		const merge = mergeProviderModelList(existing, [{ id: 'claude-opus-4-8' }, { id: 'claude-opus-4-9' }, { id: 'gpt-5.5' }], BASE);
		assert.deepStrictEqual(merge.added, ['claude-opus-4-9']);
		const added = merge.models.find(model => model['id'] === 'claude-opus-4-9');
		assert.ok(added);
		assert.strictEqual(added['name'], 'claude-opus-4-9');
		assert.strictEqual(added['thinking'], true);
		assert.deepStrictEqual(added['fumieHarnesses'], ['claude']);
		assert.strictEqual(added['maxOutputTokens'], 64000);
	});

	test('new ids without a sibling get conservative defaults with the group url', () => {
		const merge = mergeProviderModelList([{ id: 'gpt-5.5', url: BASE }], [{ id: 'gpt-5.5' }, { id: 'zz-brand-new' }], BASE);
		const added = merge.models.find(model => model['id'] === 'zz-brand-new');
		assert.ok(added);
		assert.strictEqual(added['url'], BASE);
		assert.strictEqual(added['toolCalling'], true);
		assert.strictEqual(added['vision'], false);
		assert.strictEqual(typeof added['maxInputTokens'], 'number');
		assert.strictEqual(typeof added['maxOutputTokens'], 'number');
	});

	test('duplicate upstream ids are collapsed and reported once', () => {
		const merge = mergeProviderModelList([], [{ id: 'a-model' }, { id: 'a-model' }], undefined);
		assert.deepStrictEqual(merge.added, ['a-model']);
		assert.strictEqual(merge.models.length, 1);
	});

	test('entries without a string id are dropped rather than crashing the merge', () => {
		const merge = mergeProviderModelList([{ name: 'broken' }, { id: 'kept', url: BASE }], [{ id: 'kept' }], BASE);
		assert.deepStrictEqual(merge.models.map(model => model['id']), ['kept']);
		assert.deepStrictEqual(merge.removed, []);
	});

	test('new ids take the upstream name when the endpoint provides one', () => {
		const merge = mergeProviderModelList([], [{ id: 'claude-fable-5', name: 'Claude Fable 5' }], BASE);
		assert.strictEqual(merge.models[0]['name'], 'Claude Fable 5');
	});

	test('new ids fall back to the id when the endpoint provides no name', () => {
		const merge = mergeProviderModelList([], [{ id: 'claude-fable-5' }], BASE);
		assert.strictEqual(merge.models[0]['name'], 'claude-fable-5');
	});

	test('an existing placeholder name is replaced by the upstream name', () => {
		const existing = [{ id: 'claude-fable-5', name: 'claude-fable-5', url: BASE, thinking: true }];
		const merge = mergeProviderModelList(existing, [{ id: 'claude-fable-5', name: 'Claude Fable 5' }], BASE);
		assert.deepStrictEqual(merge.renamed, ['claude-fable-5']);
		assert.strictEqual(merge.models[0]['name'], 'Claude Fable 5');
		assert.strictEqual(merge.models[0]['thinking'], true);
		assert.deepStrictEqual(merge.added, []);
		assert.deepStrictEqual(merge.removed, []);
	});

	test('a hand-picked name is never overwritten by the upstream name', () => {
		const existing = [{ id: 'claude-fable-5', name: 'My Fable', url: BASE }];
		const merge = mergeProviderModelList(existing, [{ id: 'claude-fable-5', name: 'Claude Fable 5' }], BASE);
		assert.deepStrictEqual(merge.renamed, []);
		assert.deepStrictEqual(merge.models, existing);
	});

	test('a rename-only refresh counts as a change rather than as up to date', () => {
		const existing = [{ id: 'claude-fable-5', name: 'claude-fable-5', url: BASE }];
		const merge = mergeProviderModelList(existing, [{ id: 'claude-fable-5', name: 'Claude Fable 5' }], BASE);
		// Mirrors the condition the Models surface uses to decide whether a
		// group has anything to report.
		assert.ok(merge.added.length || merge.removed.length || merge.renamed.length);
		assert.strictEqual(merge.renamed.length, 1);
	});

	test('an unlabelled listing leaves the configured entries untouched', () => {
		const existing = [{ id: 'claude-fable-5', name: 'claude-fable-5', url: BASE }];
		const merge = mergeProviderModelList(existing, [{ id: 'claude-fable-5' }], BASE);
		assert.deepStrictEqual(merge.renamed, []);
		assert.deepStrictEqual(merge.added, []);
		assert.deepStrictEqual(merge.removed, []);
		assert.deepStrictEqual(merge.models, existing);
	});
});
