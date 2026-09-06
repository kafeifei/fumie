/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../log/common/log.js';
import type { ISessionDataService } from '../../common/sessionDataService.js';

export const SESSION_CUSTOM_TITLE_KEY = 'customTitle';
export const SESSION_CUSTOM_TITLE_SOURCE_KEY = 'customTitleSource';
export const SESSION_ARTIFACTS_KEY = 'sessionArtifacts';
export const AGENT_HOST_TITLE_SOURCE_USER = 'user';
export const AGENT_HOST_TITLE_SOURCE_AUTO = 'auto';

/**
 * Who produced a persisted session/chat title. Fumie only recognises titles it
 * owns: a rename by the user (which nothing else may overwrite) and its own
 * generated title. Titles pushed by a harness or written by an agent tool call
 * are ignored outright, so there is no tier for either here.
 */
export type AgentHostTitleSource =
	| typeof AGENT_HOST_TITLE_SOURCE_USER
	| typeof AGENT_HOST_TITLE_SOURCE_AUTO;

const AGENT_HOST_TITLE_SOURCES: ReadonlySet<string> = new Set<AgentHostTitleSource>([AGENT_HOST_TITLE_SOURCE_USER, AGENT_HOST_TITLE_SOURCE_AUTO]);

/**
 * Narrows a raw persisted metadata value to a known {@link AgentHostTitleSource}.
 * Returns `undefined` for a missing value and for any value this build no
 * longer recognises — a legacy row predating source tracking, or one an older
 * build wrote with a source this build has dropped (`'agent'`, `'provider'`,
 * `'prompt'`). All of them are read the same way: the persisted title stands,
 * unlocked.
 */
export function parseAgentHostTitleSource(value: string | undefined): AgentHostTitleSource | undefined {
	return value !== undefined && AGENT_HOST_TITLE_SOURCES.has(value) ? value as AgentHostTitleSource : undefined;
}

export function customChatTitleMetadataKey(chat: string): string {
	return `customChatTitle:${chat}`;
}

export function customChatTitleSourceMetadataKey(chat: string): string {
	return `customChatTitleSource:${chat}`;
}

/**
 * Fire-and-forget persistence of a single session-metadata key/value pair to a
 * session's database. Opens the database, writes the value, and disposes the
 * handle; failures are logged, not thrown.
 *
 * Used for host-owned fields that must survive restart (custom titles, isRead /
 * isArchived flags, merged config values, …). Shared so callers do not each
 * re-implement the open/write/dispose dance.
 */
export function persistSessionMetadata(sessionDataService: ISessionDataService, logService: ILogService, session: string, key: string, value: string): void {
	const onError = (err: unknown) => {
		logService.warn(`[AgentHost] Failed to persist session metadata '${key}'`, err);
	};
	try {
		const ref = sessionDataService.openDatabase(URI.parse(session));
		ref.object.setMetadata(key, value).catch(onError).finally(() => {
			ref.dispose();
		});
	} catch (err) {
		onError(err);
	}
}

/** Persists multiple metadata values before returning and propagates write failures. */
export async function persistSessionMetadataValues(sessionDataService: ISessionDataService, session: string, values: Readonly<Record<string, string>>): Promise<void> {
	const ref = sessionDataService.openDatabase(URI.parse(session));
	try {
		await ref.object.setMetadataValues(values);
	} finally {
		ref.dispose();
	}
}
