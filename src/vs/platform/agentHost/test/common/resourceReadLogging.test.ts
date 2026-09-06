/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isFileResourceProbe } from '../../common/resourceReadLogging.js';

/**
 * Opening a session probes the workspace root for optional agent config
 * files. Both endpoints share this predicate to keep the resulting
 * `NotFound` out of their failure logs, so it has to cover every command
 * the probe uses — a read, a stat and a watch.
 */
suite('AHP resource probe classification', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const optionalFiles = [
		'file:///workspace/.mcp.json',
		'file:///workspace/.claude/settings.json',
		'file:///workspace/.claude/settings.local.json',
		'file:///workspace/.github/copilot/settings.json',
		'file:///workspace/.github/copilot/settings.local.json',
	];

	for (const method of ['resourceRead', 'resourceResolve', 'createResourceWatch']) {
		test(`${method} on an absent optional file is a probe`, () => {
			for (const uri of optionalFiles) {
				assert.strictEqual(isFileResourceProbe(method, { channel: 'ahp-root://', uri }), true, uri);
			}
		});
	}

	test('watching a directory that does not exist yet is a probe', () => {
		assert.strictEqual(isFileResourceProbe('createResourceWatch', { uri: 'file:///workspace/.claude' }), true);
		assert.strictEqual(isFileResourceProbe('createResourceWatch', { uri: 'file:///workspace/.github/copilot' }), true);
	});

	test('commands that assert the resource exists are not probes', () => {
		const uri = 'file:///workspace/.mcp.json';
		for (const method of ['resourceDelete', 'resourceWrite', 'resourceMove', 'resourceCopy', 'resourceList', 'resourceMkdir']) {
			assert.strictEqual(isFileResourceProbe(method, { uri }), false, method);
		}
	});

	test('only file URIs are probes', () => {
		assert.strictEqual(isFileResourceProbe('resourceResolve', { uri: 'session-db:/session/1/edit' }), false);
		assert.strictEqual(isFileResourceProbe('resourceResolve', { uri: 'git-blob:/session/1/file.ts' }), false);
		assert.strictEqual(isFileResourceProbe('resourceResolve', { uri: 42 }), false);
		assert.strictEqual(isFileResourceProbe('resourceResolve', {}), false);
		assert.strictEqual(isFileResourceProbe('resourceResolve', undefined), false);
	});
});
