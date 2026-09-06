/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import type { IAgentSessionMetadata } from '../../common/agent.js';
import type { ISessionDataService } from '../../common/sessionDataService.js';
import { AH_META_PROVISIONAL_DB_KEY, AH_META_WORKSPACELESS_DB_KEY, readProvisionalDraftMarker, SessionStatus, type IProvisionalDraftMarker } from '../../common/state/sessionState.js';
import { AgentSessionRegistry, type IRegisteredSession } from '../agentSessionRegistry.js';
import { SESSION_RECORD_METADATA_KEYS, SessionRecordStore } from './sessionRecordStore.js';

/** Fumie-owned per-session metadata key for the persisted peer-chat catalog. */
export const SESSION_PEER_CHATS_METADATA_KEY = 'peerChats';

export interface IProvisionalDraftFacts {
	readonly marker: IProvisionalDraftMarker;
	readonly customTitle: string | undefined;
	readonly isArchived: boolean;
	readonly isRead: boolean;
}

export interface IColdProvisionalDraft {
	readonly untouched: boolean;
	readonly facts: IProvisionalDraftFacts;
}

export interface IAgentSessionCatalogHost {
	isCreationReserved(session: URI): boolean;
	hasLiveState(session: URI): boolean;
	readProviderMetadata(entry: IRegisteredSession): Promise<{
		readonly providerAvailable: boolean;
		readonly metadata?: IAgentSessionMetadata;
	}>;
	sweepOrphanedDraft(session: URI): void;
}

/**
 * Fumie's top-level session catalog boundary.
 *
 * The registry is the sole membership source. The host may enrich an exact
 * registered row with provider metadata, but provider-wide history never enters
 * here. When an available provider has no backing, this boundary classifies the
 * existing provisional metadata and either retains a revivable row or asks the
 * lifecycle host to sweep an untouched orphan.
 */
export class AgentSessionCatalog {

	constructor(
		private readonly _registry: AgentSessionRegistry,
		private readonly _sessionDataService: ISessionDataService,
		private readonly _sessionRecords: SessionRecordStore,
		private readonly _host: IAgentSessionCatalogHost,
		private readonly _logService: ILogService,
	) { }

	/** Lists only durable registry members, before presentation overlays. */
	async listBaseSessions(): Promise<IAgentSessionMetadata[]> {
		const registered = await this._registry.list();
		const rows = await Promise.all(registered.map(entry => this._resolveRegisteredRow(entry)));
		return rows.filter((row): row is IAgentSessionMetadata => row !== undefined);
	}

	private async _resolveRegisteredRow(entry: IRegisteredSession): Promise<IAgentSessionMetadata | undefined> {
		if (this._host.isCreationReserved(entry.session) && !this._host.hasLiveState(entry.session)) {
			return undefined;
		}
		const fallback: IAgentSessionMetadata = {
			session: entry.session,
			startTime: entry.startTime,
			modifiedTime: entry.startTime,
			summary: localize('agentHost.sessionFallbackTitle', "New Session"),
			status: SessionStatus.Idle,
		};

		let provider;
		try {
			provider = await this._host.readProviderMetadata(entry);
		} catch (error) {
			this._logService.warn(`[AgentSessionCatalog] Failed to read provider metadata for ${entry.session.toString()}: ${toErrorMessage(error)}`);
			return fallback;
		}
		if (!provider.providerAvailable) {
			return fallback;
		}
		if (provider.metadata) {
			return provider.metadata;
		}

		const draft = await this.classifyColdProvisionalDraft(entry.session);
		if (draft?.untouched) {
			this._host.sweepOrphanedDraft(entry.session);
			return undefined;
		}
		return fallback;
	}

	/** Classifies a cold registry row without consulting or enumerating providers. */
	async classifyColdProvisionalDraft(session: URI): Promise<IColdProvisionalDraft | undefined> {
		if (this._host.hasLiveState(session)) {
			return undefined;
		}
		const facts = await this._readProvisionalDraftFacts(session);
		return facts ? { untouched: !facts.customTitle && !facts.isArchived, facts } : undefined;
	}

	private async _readProvisionalDraftFacts(session: URI): Promise<IProvisionalDraftFacts | undefined> {
		let ref;
		try {
			ref = await this._sessionDataService.tryOpenDatabase(session);
		} catch (error) {
			this._logService.warn(`[AgentSessionCatalog] Failed to open provisional metadata for ${session.toString()}: ${toErrorMessage(error)}`);
			return undefined;
		}
		if (!ref) {
			// A crash may leave the durable reservation before its session DB exists.
			return { marker: {}, customTitle: undefined, isArchived: false, isRead: false };
		}
		try {
			const metadata = await ref.object.getMetadataObject({
				...SESSION_RECORD_METADATA_KEYS,
				[AH_META_PROVISIONAL_DB_KEY]: true,
				[AH_META_WORKSPACELESS_DB_KEY]: true,
				configValues: true,
				[SESSION_PEER_CHATS_METADATA_KEY]: true,
			});
			const legacyDraft = metadata[AH_META_PROVISIONAL_DB_KEY] === undefined
				&& metadata[AH_META_WORKSPACELESS_DB_KEY] === undefined
				&& !metadata.configValues
				&& !metadata[SESSION_PEER_CHATS_METADATA_KEY];
			const marker = readProvisionalDraftMarker(metadata[AH_META_PROVISIONAL_DB_KEY]) ?? (legacyDraft ? {} : undefined);
			if (!marker) {
				return undefined;
			}
			const record = this._sessionRecords.project(metadata);
			return {
				marker,
				customTitle: record.title,
				isArchived: record.isArchived,
				isRead: record.isRead,
			};
		} finally {
			ref.dispose();
		}
	}
}
