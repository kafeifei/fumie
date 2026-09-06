/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { AgentHostFilterConnectionStatus, IAgentHostFilterEntry } from '../../../../../services/agentHostFilter/common/agentHostFilter.js';
import { buildHostFilterMenuEntries } from '../../browser/hostFilterActionViewItem.js';

function entry(providerId: string, label: string, status = AgentHostFilterConnectionStatus.Connected): IAgentHostFilterEntry {
	return {
		providerId,
		label,
		address: providerId.replace('agenthost-', ''),
		status,
		hasLiveConnection: status === AgentHostFilterConnectionStatus.Connected,
	};
}

suite('host filter menu', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('all machines tops the menu and is checked in the all scope', () => {
		const entries = buildHostFilterMenuEntries({ kind: 'all' }, [entry('agenthost-a', 'Host A'), entry('agenthost-b', 'Host B')]);

		assert.deepStrictEqual(entries.map(e => e.id), [
			'agentHostFilter.scope.all',
			'agentHostFilter.host.agenthost-a',
			'agentHostFilter.host.agenthost-b',
		]);
		assert.deepStrictEqual(entries.map(e => e.checked), [true, false, false]);
		assert.deepStrictEqual(entries[0].scope, { kind: 'all' });
	});

	test('the scoped host is the checked entry', () => {
		const entries = buildHostFilterMenuEntries({ kind: 'host', providerId: 'agenthost-b' }, [entry('agenthost-a', 'Host A'), entry('agenthost-b', 'Host B')]);

		assert.deepStrictEqual(entries.map(e => e.checked), [false, false, true]);
		assert.deepStrictEqual(entries[2].scope, { kind: 'host', providerId: 'agenthost-b' });
	});

	test('a single host still offers a choice of scope', () => {
		const entries = buildHostFilterMenuEntries({ kind: 'host', providerId: 'agenthost-a' }, [entry('agenthost-a', 'Host A')]);

		assert.strictEqual(entries.length, 2);
		assert.deepStrictEqual(entries[0].scope, { kind: 'all' });
		assert.strictEqual(entries[1].label, 'Host A');
	});

	test('offline hosts stay pickable and say so', () => {
		const entries = buildHostFilterMenuEntries({ kind: 'all' }, [
			entry('agenthost-a', 'Host A', AgentHostFilterConnectionStatus.Connecting),
			entry('agenthost-b', 'Host B', AgentHostFilterConnectionStatus.Disconnected),
		]);

		assert.strictEqual(entries.length, 3);
		for (const offline of entries.slice(1)) {
			// The status is appended to the host name, so the label is no
			// longer the bare name but still contains it.
			assert.ok(offline.label.includes('Host'), offline.label);
			assert.notStrictEqual(offline.label, 'Host A');
			assert.notStrictEqual(offline.label, 'Host B');
		}
		assert.deepStrictEqual(entries[2].scope, { kind: 'host', providerId: 'agenthost-b' });
	});

	test('no hosts leaves the union entry alone', () => {
		const entries = buildHostFilterMenuEntries({ kind: 'all' }, []);

		assert.deepStrictEqual(entries.map(e => e.id), ['agentHostFilter.scope.all']);
		assert.strictEqual(entries[0].checked, true);
	});
});
