/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { normalizeSessionSummaryChanges, SessionStatus, type SessionSummary } from '../../../common/state/sessionState.js';

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		resource: 'ahp-session:/s1',
		provider: 'claude',
		title: 'Session',
		status: SessionStatus.Idle,
		createdAt: '2026-01-01T00:00:00.000Z',
		modifiedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

suite('normalizeSessionSummaryChanges', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a null clears the field when the diff is spread onto a cached summary', () => {
		// The end-to-end shape of the bug: the host announces an activity, then
		// clears it. Before, the clear arrived as `{}` and the cached summary
		// kept the stale activity (and its spinner) forever.
		const cached = makeSummary({ activity: 'Creating isolated worktree' });
		const wire = JSON.parse(JSON.stringify({ activity: null }));

		const merged = { ...cached, ...normalizeSessionSummaryChanges(wire) };

		assert.strictEqual(merged.activity, undefined);
	});

	test('keeps the key present so hasOwnProperty-style consumers still see the clear', () => {
		const normalized = normalizeSessionSummaryChanges({ activity: null, project: null, _meta: null });
		assert.deepStrictEqual({
			keys: Object.keys(normalized).sort(),
			values: [normalized.activity, normalized.project, normalized._meta],
		}, {
			keys: ['_meta', 'activity', 'project'],
			values: [undefined, undefined, undefined],
		});
	});

	test('carries values through unchanged', () => {
		const normalized = normalizeSessionSummaryChanges({
			title: 'Renamed',
			status: SessionStatus.InProgress,
			activity: 'Running tests',
			workingDirectories: ['file:///repo'],
			changes: { files: 3 },
		});
		assert.deepStrictEqual(normalized, {
			title: 'Renamed',
			status: SessionStatus.InProgress,
			activity: 'Running tests',
			workingDirectories: ['file:///repo'],
			changes: { files: 3 },
		});
	});

	test('an empty diff leaves the cached summary untouched', () => {
		const cached = makeSummary({ activity: 'Thinking' });
		assert.deepStrictEqual({ ...cached, ...normalizeSessionSummaryChanges({}) }, cached);
	});

	test('drops identity fields a sender should not have carried', () => {
		const normalized = normalizeSessionSummaryChanges({
			resource: 'ahp-session:/other',
			provider: 'codex',
			createdAt: '2020-01-01T00:00:00.000Z',
			title: 'Renamed',
		});
		assert.deepStrictEqual(normalized, { title: 'Renamed' });
	});
});
