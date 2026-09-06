/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionKey, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeSessionStore } from '../../node/claude/claudeSessionStore.js';

suite('ClaudeSessionStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let store: ClaudeSessionStore;
	const main: SessionKey = { projectKey: 'project-a', sessionId: 'session-a' };

	setup(async () => {
		store = await ClaudeSessionStore.open(':memory:');
	});

	teardown(async () => {
		await store.close();
	});

	test('round-trips opaque entries and deduplicates only stable UUIDs', async () => {
		const first: SessionStoreEntry = {
			type: 'user',
			uuid: 'entry-1',
			timestamp: '2026-08-20T00:00:00.000Z',
			payload: { nested: ['opaque', 1, true] },
		};
		const marker: SessionStoreEntry = { type: 'mode', mode: 'plan' };

		await store.append(main, [first, marker]);
		await store.append(main, [
			{ ...first, payload: { must: 'not overwrite the first commit' } },
			marker,
		]);

		assert.deepStrictEqual(await store.load(main), [first, marker, marker]);
	});

	test('serializes concurrent main and subpath appends for one session', async () => {
		const subagent: SessionKey = { ...main, subpath: 'subagents/agent-a' };

		await Promise.all([
			store.append(main, [{ type: 'user', uuid: 'main-1' }]),
			store.append(subagent, [{ type: 'assistant', uuid: 'sub-1' }]),
			store.append(main, [{ type: 'assistant', uuid: 'main-2' }]),
		]);

		assert.deepStrictEqual(await store.load(main), [
			{ type: 'user', uuid: 'main-1' },
			{ type: 'assistant', uuid: 'main-2' },
		]);
		assert.deepStrictEqual(await store.load(subagent), [
			{ type: 'assistant', uuid: 'sub-1' },
		]);
		assert.deepStrictEqual(await store.listSubkeys(main), ['subagents/agent-a']);
	});

	test('lists only main transcripts and keeps project namespaces independent', async () => {
		const otherProject: SessionKey = { projectKey: 'project-b', sessionId: main.sessionId };
		const orphanSubpath: SessionKey = { projectKey: main.projectKey, sessionId: 'subpath-only', subpath: 'subagents/agent-z' };

		await store.append(main, [{ type: 'user', uuid: 'a' }]);
		await store.append(otherProject, [{ type: 'user', uuid: 'b' }]);
		await store.append(orphanSubpath, [{ type: 'assistant', uuid: 'z' }]);

		assert.deepStrictEqual((await store.listSessions(main.projectKey)).map(session => session.sessionId), [main.sessionId]);
		assert.deepStrictEqual((await store.listSessions(otherProject.projectKey)).map(session => session.sessionId), [otherProject.sessionId]);
	});

	test('subpath delete is exact and main delete cascades every subpath', async () => {
		const subagentA: SessionKey = { ...main, subpath: 'subagents/agent-a' };
		const subagentB: SessionKey = { ...main, subpath: 'subagents/nested/agent-b' };
		await store.append(main, [{ type: 'user', uuid: 'main' }]);
		await store.append(subagentA, [{ type: 'assistant', uuid: 'a' }]);
		await store.append(subagentB, [{ type: 'assistant', uuid: 'b' }]);

		await store.delete(subagentA);
		assert.strictEqual(await store.load(subagentA), null);
		assert.deepStrictEqual(await store.listSubkeys(main), ['subagents/nested/agent-b']);

		await store.delete(main);
		await store.delete(main);

		assert.deepStrictEqual({
			main: await store.load(main),
			subagent: await store.load(subagentB),
			listed: await store.listSessions(main.projectKey),
			subkeys: await store.listSubkeys(main),
		}, {
			main: null,
			subagent: null,
			listed: [],
			subkeys: [],
		});
	});

	test('empty append does not create a listed session', async () => {
		await store.append(main, []);

		assert.strictEqual(await store.load(main), null);
		assert.deepStrictEqual(await store.listSessions(main.projectKey), []);
	});
});
