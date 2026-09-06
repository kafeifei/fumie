/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AGENT_HOST_TITLE_SOURCE_AUTO, AGENT_HOST_TITLE_SOURCE_USER, SESSION_CUSTOM_TITLE_KEY, SESSION_CUSTOM_TITLE_SOURCE_KEY } from '../../../node/shared/persistSessionMetadata.js';
import { SESSION_ARCHIVE_PRESERVE_CHANGES_KEY, SESSION_ARCHIVE_SYNC_TARGET_KEY, SessionRecordStore } from '../../../node/fumie/sessionRecordStore.js';
import { AH_META_IS_ARCHIVED_DB_KEY, AH_META_IS_DONE_DB_KEY, AH_META_IS_READ_DB_KEY } from '../../../common/state/sessionState.js';
import { createNullSessionDataService, createSessionDataService, TestSessionDatabase } from '../../common/sessionTestHelpers.js';

suite('SessionRecordStore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const store = new SessionRecordStore(createNullSessionDataService(), new NullLogService());
	const metadataFor = (source: string | undefined, title: string | null) => ({
		...(title !== null ? { [SESSION_CUSTOM_TITLE_KEY]: title } : {}),
		...(source !== undefined ? { [SESSION_CUSTOM_TITLE_SOURCE_KEY]: source } : {}),
	});

	test('resolveSessionTitle prefers the persisted title regardless of its source', () => {
		const harness = 'Harness title';
		/** `title === null` means the session has no persisted title at all. */
		const resolved = (source: string | undefined, harnessSummary: string | undefined, title: string | null = 'Persisted title') =>
			store.resolveTitle(metadataFor(source, title), harnessSummary) ?? 'Session';

		assert.deepStrictEqual({
			user: resolved(AGENT_HOST_TITLE_SOURCE_USER, harness),
			auto: resolved(AGENT_HOST_TITLE_SOURCE_AUTO, harness),
			legacyNoSource: resolved(undefined, harness),
			legacyAgentSource: resolved('agent', harness),
			legacyProviderSource: resolved('provider', harness),
			legacyPromptSource: resolved('prompt', harness),
			untitledWithHarnessTitle: resolved(undefined, harness, null),
			untitledWithoutHarnessTitle: resolved(undefined, undefined, null),
			emptyPersistedTitle: resolved(AGENT_HOST_TITLE_SOURCE_USER, harness, ''),
		}, {
			user: 'Persisted title',
			auto: 'Persisted title',
			legacyNoSource: 'Persisted title',
			legacyAgentSource: 'Persisted title',
			legacyProviderSource: 'Persisted title',
			legacyPromptSource: 'Persisted title',
			untitledWithHarnessTitle: harness,
			untitledWithoutHarnessTitle: 'Session',
			emptyPersistedTitle: harness,
		});
	});

	test('readSessionRecordFromMetadata projects the persisted metadata keys', () => {
		assert.deepStrictEqual({
			empty: store.project({}),
			userRenamed: store.project({
				[SESSION_CUSTOM_TITLE_KEY]: 'My session',
				[SESSION_CUSTOM_TITLE_SOURCE_KEY]: AGENT_HOST_TITLE_SOURCE_USER,
				[AH_META_IS_READ_DB_KEY]: 'true',
				[AH_META_IS_ARCHIVED_DB_KEY]: '',
			}),
			legacyArchived: store.project({
				[SESSION_CUSTOM_TITLE_KEY]: 'Old session',
				[AH_META_IS_DONE_DB_KEY]: 'true',
			}),
			unknownSource: store.project({
				[SESSION_CUSTOM_TITLE_KEY]: 'Odd row',
				[SESSION_CUSTOM_TITLE_SOURCE_KEY]: 'something-else',
			}),
			// Rows an older build wrote with a harness-tier source read as
			// sourceless: the title is kept, nothing is migrated.
			legacyProviderSource: store.project({
				[SESSION_CUSTOM_TITLE_KEY]: 'Codex-named row',
				[SESSION_CUSTOM_TITLE_SOURCE_KEY]: 'provider',
			}),
			legacyPromptSource: store.project({
				[SESSION_CUSTOM_TITLE_KEY]: 'First prompt row',
				[SESSION_CUSTOM_TITLE_SOURCE_KEY]: 'prompt',
			}),
			pendingArchive: store.project({
				[SESSION_ARCHIVE_SYNC_TARGET_KEY]: 'true',
			}),
			pendingUnarchive: store.project({
				[SESSION_ARCHIVE_SYNC_TARGET_KEY]: 'false',
			}),
			confirmedDirtyArchive: store.project({
				[SESSION_ARCHIVE_PRESERVE_CHANGES_KEY]: 'true',
			}),
		}, {
			empty: { title: undefined, titleSource: undefined, titleLocked: false, isRead: false, isArchived: false, archiveSyncTarget: undefined, archivePreserveChanges: false },
			userRenamed: { title: 'My session', titleSource: AGENT_HOST_TITLE_SOURCE_USER, titleLocked: true, isRead: true, isArchived: false, archiveSyncTarget: undefined, archivePreserveChanges: false },
			legacyArchived: { title: 'Old session', titleSource: undefined, titleLocked: false, isRead: false, isArchived: true, archiveSyncTarget: undefined, archivePreserveChanges: false },
			unknownSource: { title: 'Odd row', titleSource: undefined, titleLocked: false, isRead: false, isArchived: false, archiveSyncTarget: undefined, archivePreserveChanges: false },
			legacyProviderSource: { title: 'Codex-named row', titleSource: undefined, titleLocked: false, isRead: false, isArchived: false, archiveSyncTarget: undefined, archivePreserveChanges: false },
			legacyPromptSource: { title: 'First prompt row', titleSource: undefined, titleLocked: false, isRead: false, isArchived: false, archiveSyncTarget: undefined, archivePreserveChanges: false },
			pendingArchive: { title: undefined, titleSource: undefined, titleLocked: false, isRead: false, isArchived: false, archiveSyncTarget: true, archivePreserveChanges: false },
			pendingUnarchive: { title: undefined, titleSource: undefined, titleLocked: false, isRead: false, isArchived: false, archiveSyncTarget: false, archivePreserveChanges: false },
			confirmedDirtyArchive: { title: undefined, titleSource: undefined, titleLocked: false, isRead: false, isArchived: false, archiveSyncTarget: undefined, archivePreserveChanges: true },
		});
	});

	test('projectStatus preserves absent, explicit false, true, and legacy archive metadata', () => {
		assert.deepStrictEqual({
			absent: store.projectStatus({}),
			explicitFalse: store.projectStatus({
				[AH_META_IS_READ_DB_KEY]: '',
				[AH_META_IS_ARCHIVED_DB_KEY]: '',
			}),
			explicitTrue: store.projectStatus({
				[AH_META_IS_READ_DB_KEY]: 'true',
				[AH_META_IS_ARCHIVED_DB_KEY]: 'true',
			}),
			legacyArchived: store.projectStatus({
				[AH_META_IS_DONE_DB_KEY]: 'true',
			}),
			currentArchiveWins: store.projectStatus({
				[AH_META_IS_ARCHIVED_DB_KEY]: '',
				[AH_META_IS_DONE_DB_KEY]: 'true',
			}),
		}, {
			absent: { isRead: undefined, isArchived: undefined },
			explicitFalse: { isRead: false, isArchived: false },
			explicitTrue: { isRead: true, isArchived: true },
			legacyArchived: { isRead: undefined, isArchived: true },
			currentArchiveWins: { isRead: undefined, isArchived: false },
		});
	});

	test('update writes the established metadata keys and read projects them back', async () => {
		const session = URI.parse('agent-session://claude/one');
		const database = new TestSessionDatabase();
		const store = new SessionRecordStore(createSessionDataService(database), new NullLogService());

		await store.update(session, {});
		const afterEmptyPatch = database.setMetadataCalls.length;
		await store.update(session, { title: 'Renamed by hand', titleSource: AGENT_HOST_TITLE_SOURCE_USER, isRead: true, isArchived: false, archiveSyncTarget: true, archivePreserveChanges: true });
		await store.update(session, { isArchived: true, archiveSyncTarget: null, archivePreserveChanges: null });

		assert.deepStrictEqual({
			emptyPatchWrites: afterEmptyPatch,
			written: database.setMetadataCalls,
			record: await store.read(session),
			withoutDatabase: await new SessionRecordStore(createNullSessionDataService(), new NullLogService()).read(session),
		}, {
			emptyPatchWrites: 0,
			written: [
				{ key: SESSION_CUSTOM_TITLE_KEY, value: 'Renamed by hand' },
				{ key: SESSION_CUSTOM_TITLE_SOURCE_KEY, value: AGENT_HOST_TITLE_SOURCE_USER },
				{ key: AH_META_IS_READ_DB_KEY, value: 'true' },
				{ key: AH_META_IS_ARCHIVED_DB_KEY, value: '' },
				{ key: SESSION_ARCHIVE_SYNC_TARGET_KEY, value: 'true' },
				{ key: SESSION_ARCHIVE_PRESERVE_CHANGES_KEY, value: 'true' },
				{ key: AH_META_IS_ARCHIVED_DB_KEY, value: 'true' },
				{ key: SESSION_ARCHIVE_SYNC_TARGET_KEY, value: '' },
				{ key: SESSION_ARCHIVE_PRESERVE_CHANGES_KEY, value: '' },
			],
			record: { title: 'Renamed by hand', titleSource: AGENT_HOST_TITLE_SOURCE_USER, titleLocked: true, isRead: true, isArchived: true, archiveSyncTarget: undefined, archivePreserveChanges: false },
			withoutDatabase: { title: undefined, titleSource: undefined, titleLocked: false, isRead: false, isArchived: false, archiveSyncTarget: undefined, archivePreserveChanges: false },
		});
	});
});
