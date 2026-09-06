/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { encodeProviderData } from '../../node/agentChatBackings.js';
import { decodeClaudeChatBacking, encodeClaudeChatBacking } from '../../node/claude/claudeChatBackingCodec.js';

suite('Claude chat backing codec', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies an unversioned receipt as legacy without guessing a project directory', () => {
		const legacy = encodeProviderData({
			sdkSessionId: 'sdk-legacy',
			model: { id: 'claude-sonnet' },
			sideChat: { turnId: 'turn-1', inheritedTurnId: 'turn-inherited-1' },
		});

		assert.deepStrictEqual(decodeClaudeChatBacking(legacy), {
			sdkSessionId: 'sdk-legacy',
			model: { id: 'claude-sonnet' },
			sideChat: { turnId: 'turn-1', inheritedTurnId: 'turn-inherited-1' },
			storage: { kind: 'legacy-local-v0' },
		});
	});

	test('round-trips a versioned Fumie-store receipt with exact project routing', () => {
		const encoded = encodeClaudeChatBacking({
			sdkSessionId: 'sdk-fumie',
			model: { id: 'claude-opus', config: { thinkingLevel: 'high' } },
			agent: { uri: 'agent://reviewer' },
			sideChat: {
				source: 'ahp-chat://source',
				turnId: 'turn-2',
				inheritedTurnId: 'turn-inherited-2',
			},
			storage: { kind: 'fumie-store-v1', projectDir: '/worktrees/project-a' },
		});

		assert.strictEqual((JSON.parse(encoded) as { version?: unknown }).version, 1);
		assert.deepStrictEqual(decodeClaudeChatBacking(encoded), {
			sdkSessionId: 'sdk-fumie',
			model: { id: 'claude-opus', config: { thinkingLevel: 'high' } },
			agent: { uri: 'agent://reviewer' },
			sideChat: {
				source: 'ahp-chat://source',
				turnId: 'turn-2',
				inheritedTurnId: 'turn-inherited-2',
			},
			storage: { kind: 'fumie-store-v1', projectDir: '/worktrees/project-a' },
		});
	});

	test('round-trips an explicitly located legacy receipt', () => {
		const encoded = encodeClaudeChatBacking({
			sdkSessionId: 'sdk-legacy-known',
			storage: { kind: 'legacy-local-v0', projectDir: '/old/project' },
		});

		assert.deepStrictEqual(decodeClaudeChatBacking(encoded)?.storage, {
			kind: 'legacy-local-v0',
			projectDir: '/old/project',
		});
	});

	test('fails closed for unknown versions and malformed storage routing', () => {
		const base = { sdkSessionId: 'sdk-bad', version: 1 };

		assert.strictEqual(decodeClaudeChatBacking(JSON.stringify({ ...base, version: 2, storage: { kind: 'fumie-store-v1', projectDir: '/work' } })), undefined);
		assert.strictEqual(decodeClaudeChatBacking(JSON.stringify({ ...base, storage: { kind: 'fumie-store-v1' } })), undefined);
		assert.strictEqual(decodeClaudeChatBacking(JSON.stringify({ ...base, storage: { kind: 'legacy-local-v0', projectDir: '' } })), undefined);
		assert.strictEqual(decodeClaudeChatBacking(JSON.stringify({ ...base, storage: { kind: 'future-store-v2', projectDir: '/work' } })), undefined);
		assert.strictEqual(decodeClaudeChatBacking('{not json'), undefined);
	});
});
