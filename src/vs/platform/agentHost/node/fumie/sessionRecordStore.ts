/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import type { ISessionDataService } from '../../common/sessionDataService.js';
import { AH_META_IS_ARCHIVED_DB_KEY, AH_META_IS_DONE_DB_KEY, AH_META_IS_READ_DB_KEY } from '../../common/state/sessionState.js';
import { AGENT_HOST_TITLE_SOURCE_USER, parseAgentHostTitleSource, persistSessionMetadataValues, SESSION_CUSTOM_TITLE_KEY, SESSION_CUSTOM_TITLE_SOURCE_KEY, type AgentHostTitleSource } from '../shared/persistSessionMetadata.js';

/**
 * Legacy archive-mirror outbox key. New code never writes an intent here;
 * startup consumes a leftover `"true"` / `"false"` as Fumie-local desired
 * state and clears it without calling a Harness archive API.
 */
export const SESSION_ARCHIVE_SYNC_TARGET_KEY = 'agentHost.archiveSyncTarget';

/** One-shot receipt proving that the current archive may preserve Git-visible dirt. */
export const SESSION_ARCHIVE_PRESERVE_CHANGES_KEY = 'agentHost.archivePreserveChanges';

/**
 * The Fumie-owned, host-persisted facts about a session: everything the catalog
 * keeps in the per-session `session.db` metadata table rather than in the
 * harness. This is a *view* over per-session metadata; additive lifecycle keys
 * default safely when absent, so older rows need no migration.
 */
export interface ISessionRecord {
	/** The persisted title (`customTitle`), or `undefined` when none was ever written. */
	readonly title: string | undefined;
	/** Who produced {@link title} (`customTitleSource`); `undefined` for a legacy row whose source predates or is no longer recognised by this build. */
	readonly titleSource: AgentHostTitleSource | undefined;
	/** `true` when the user renamed the session by hand, which no other producer may overwrite. */
	readonly titleLocked: boolean;
	/** The persisted read flag (`isRead`). */
	readonly isRead: boolean;
	/** The persisted archive flag (`isArchived`, falling back to the legacy `isDone`). */
	readonly isArchived: boolean;
	/** Legacy desired archive value awaiting one-time Fumie-local repair. */
	readonly archiveSyncTarget: boolean | undefined;
	/** Durable receipt for the current archive cleanup only. */
	readonly archivePreserveChanges: boolean;
}

/**
 * A partial write to an {@link ISessionRecord}. Only the provided fields are
 * persisted. `titleSource` rather than `titleLocked` is writable because the
 * source is what the database stores; `titleLocked` is its read-side projection.
 */
export interface ISessionRecordPatch {
	readonly title?: string;
	readonly titleSource?: AgentHostTitleSource;
	readonly isRead?: boolean;
	readonly isArchived?: boolean;
	/** `null` clears a legacy archive-mirror value; new code never writes a boolean. */
	readonly archiveSyncTarget?: boolean | null;
	/** `null` consumes the current archive's dirty-change receipt. */
	readonly archivePreserveChanges?: boolean | null;
}

/**
 * The metadata keys an {@link ISessionRecord} is projected from. Callers that
 * already batch a larger `getMetadataObject` read (the session catalog, restore)
 * spread this in so the session database is still hit exactly once.
 */
export const SESSION_RECORD_METADATA_KEYS = {
	[SESSION_CUSTOM_TITLE_KEY]: true,
	[SESSION_CUSTOM_TITLE_SOURCE_KEY]: true,
	[AH_META_IS_READ_DB_KEY]: true,
	[AH_META_IS_ARCHIVED_DB_KEY]: true,
	[AH_META_IS_DONE_DB_KEY]: true,
	[SESSION_ARCHIVE_SYNC_TARGET_KEY]: true,
	[SESSION_ARCHIVE_PRESERVE_CHANGES_KEY]: true,
} as const;

/** Projects raw session-database metadata onto an {@link ISessionRecord}. */
function readSessionRecordFromMetadata(metadata: { readonly [key: string]: string | undefined }): ISessionRecord {
	const titleSource = parseAgentHostTitleSource(metadata[SESSION_CUSTOM_TITLE_SOURCE_KEY]);
	const status = readSessionStatusFromMetadata(metadata);
	return {
		title: metadata[SESSION_CUSTOM_TITLE_KEY] || undefined,
		titleSource,
		titleLocked: titleSource === AGENT_HOST_TITLE_SOURCE_USER,
		isRead: status.isRead ?? false,
		isArchived: status.isArchived ?? false,
		archiveSyncTarget: metadata[SESSION_ARCHIVE_SYNC_TARGET_KEY] === 'true'
			? true
			: metadata[SESSION_ARCHIVE_SYNC_TARGET_KEY] === 'false' ? false : undefined,
		archivePreserveChanges: metadata[SESSION_ARCHIVE_PRESERVE_CHANGES_KEY] === 'true',
	};
}

function readSessionStatusFromMetadata(metadata: { readonly [key: string]: string | undefined }): { readonly isRead: boolean | undefined; readonly isArchived: boolean | undefined } {
	const isRead = metadata[AH_META_IS_READ_DB_KEY];
	const isArchived = metadata[AH_META_IS_ARCHIVED_DB_KEY] ?? metadata[AH_META_IS_DONE_DB_KEY];
	return {
		isRead: isRead === undefined ? undefined : isRead === 'true',
		isArchived: isArchived === undefined ? undefined : isArchived === 'true',
	};
}

/** The title-relevant slice of {@link ISessionRecord} that {@link resolveSessionTitle} reads. */
export type ISessionTitleRecord = Pick<ISessionRecord, 'title'>;

/**
 * The single read-side title rule of the Fumie catalog: given a session's
 * persisted {@link ISessionRecord} and whatever title the harness currently
 * reports, decide which one the user sees. Returns `undefined` when neither
 * side has a title; callers supply their own placeholder for that case.
 *
 * Every title Fumie shows is one Fumie itself persisted, so the persisted title
 * always wins and the harness title is only a fallback for a session Fumie has
 * not titled yet. There is no priority chain and no source to consult: a
 * harness-pushed title never reaches this record (see
 * `AgentSideEffects._handleAgentSignal`).
 */
function resolveSessionTitle(record: ISessionTitleRecord, harnessSummary: string | undefined): string | undefined {
	return record.title ?? harnessSummary;
}

/**
 * Reads and writes the {@link ISessionRecord} of a session, hiding the
 * per-session database open/close dance and the raw metadata key names from
 * callers.
 */
export class SessionRecordStore {

	constructor(
		private readonly _sessionDataService: ISessionDataService,
		private readonly _logService: ILogService,
	) { }

	/** Projects a batched session-database metadata read onto the Fumie-owned record. */
	project(metadata: { readonly [key: string]: string | undefined }): ISessionRecord {
		return readSessionRecordFromMetadata(metadata);
	}

	/** Projects optional read/archive overlays while preserving absent metadata. */
	projectStatus(metadata: { readonly [key: string]: string | undefined }): { readonly isRead: boolean | undefined; readonly isArchived: boolean | undefined } {
		return readSessionStatusFromMetadata(metadata);
	}

	/** Resolves the user-visible title from a batched metadata read and a harness fallback. */
	resolveTitle(metadata: { readonly [key: string]: string | undefined }, harnessSummary: string | undefined): string | undefined {
		return resolveSessionTitle(this.project(metadata), harnessSummary);
	}

	/**
	 * Reads a session's persisted record. Returns an empty record when the
	 * session has no database yet (reads never create one) or when the read
	 * fails, so a catalog row is never dropped over unreadable metadata.
	 */
	async read(session: URI): Promise<ISessionRecord> {
		let ref;
		try {
			ref = await this._sessionDataService.tryOpenDatabase(session);
		} catch (err) {
			this._logService.warn(`[SessionRecordStore] Failed to open session database for ${session.toString()}`, err);
			return this.project({});
		}
		if (!ref) {
			return this.project({});
		}
		try {
			return this.project(await ref.object.getMetadataObject(SESSION_RECORD_METADATA_KEYS));
		} catch (err) {
			this._logService.warn(`[SessionRecordStore] Failed to read session record for ${session.toString()}`, err);
			return this.project({});
		} finally {
			ref.dispose();
		}
	}

	/** Atomically persists the provided fields of a session's record. */
	async update(session: URI, patch: ISessionRecordPatch): Promise<void> {
		const values: Record<string, string> = {};
		if (patch.title !== undefined) {
			values[SESSION_CUSTOM_TITLE_KEY] = patch.title;
		}
		if (patch.titleSource !== undefined) {
			values[SESSION_CUSTOM_TITLE_SOURCE_KEY] = patch.titleSource;
		}
		if (patch.isRead !== undefined) {
			values[AH_META_IS_READ_DB_KEY] = patch.isRead ? 'true' : '';
		}
		if (patch.isArchived !== undefined) {
			values[AH_META_IS_ARCHIVED_DB_KEY] = patch.isArchived ? 'true' : '';
		}
		if (patch.archiveSyncTarget !== undefined) {
			values[SESSION_ARCHIVE_SYNC_TARGET_KEY] = patch.archiveSyncTarget === null ? '' : patch.archiveSyncTarget ? 'true' : 'false';
		}
		if (patch.archivePreserveChanges !== undefined) {
			values[SESSION_ARCHIVE_PRESERVE_CHANGES_KEY] = patch.archivePreserveChanges === true ? 'true' : '';
		}
		if (Object.keys(values).length === 0) {
			return;
		}
		await persistSessionMetadataValues(this._sessionDataService, session.toString(), values);
	}
}
