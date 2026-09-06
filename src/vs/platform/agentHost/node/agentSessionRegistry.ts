/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Limiter, SequencerByKey } from '../../../base/common/async.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { AgentProvider } from '../common/agent.js';
import { AgentSessionRegistrationSource, IAgentHostDatabase, IAgentHostDatabaseExternalUpdate, IAgentHostDatabaseRegisterOptions, IAgentHostDatabaseSessionOptions } from './agentHostDatabase.js';

/** A session recorded in the orchestrator-owned {@link AgentSessionRegistry}. */
export interface IRegisteredSession {
	readonly session: URI;
	readonly provider: AgentProvider;
	/** Session creation time (ms since epoch) as first observed by the orchestrator. */
	readonly startTime: number;
	/** Whether the session was first discovered from the provider's native catalog. */
	readonly external: boolean;
	/** Durable registration source used to protect external provenance. */
	readonly source: AgentSessionRegistrationSource;
}

export interface IStoredRegisteredSession extends Omit<IRegisteredSession, 'external'> {
	readonly external: boolean | undefined;
}

export type RegisteredSessionMigration = (entry: IStoredRegisteredSession) => Promise<IRegisteredSession | undefined>;

/**
 * Fumie's durable, authoritative top-level session catalog, keyed by session
 * URI. Provider-native catalogs are inputs to source-aware discovery, but a
 * session is visible only after it has been recorded here. A URI's provider
 * and first-observed creation time are immutable once registered.
 *
 * Restore and discovery registrations atomically respect tombstones. Explicit
 * creation may intentionally reuse a deleted URI and therefore clears its
 * tombstone. Legacy global and per-provider backfill markers are retained for
 * compatibility and discovery diagnostics; they do not determine membership.
 */
export class AgentSessionRegistry extends Disposable {

	private readonly _sessionSequencer = new SequencerByKey<string>();

	constructor(private readonly _database: IAgentHostDatabase) {
		super();
	}

	/** Records a session using source-aware provenance and tombstone behavior. */
	register(session: URI, sessionOptions: IAgentHostDatabaseSessionOptions, registerOptions: IAgentHostDatabaseRegisterOptions): Promise<boolean> {
		const key = session.toString();
		return this._sessionSequencer.queue(key, async () => {
			const existing = await this._database.getSession(key);
			if (existing && existing.provider !== sessionOptions.provider) {
				throw new Error(`Cannot reassign session ${key} from provider ${existing.provider} to ${sessionOptions.provider}`);
			}
			return this._database.registerSession(key, sessionOptions, registerOptions);
		});
	}

	/** Removes any registry entry for `session` without writing a tombstone. */
	unregister(session: URI): Promise<void> {
		const key = session.toString();
		return this._sessionSequencer.queue(key, () => this._database.unregisterSession(key));
	}

	/**
	 * Removes any registry entry for `session` (a true delete) and durably
	 * tombstones it so discovery cannot register it. Used both to delete a
	 * session the user explicitly removed and to keep a session that must never
	 * be listed (e.g. a throwaway chat surface) out of the registry entirely.
	 * No-op on the registry entry if absent; the tombstone is still written.
	 */
	tombstone(session: URI): Promise<void> {
		const key = session.toString();
		return this._sessionSequencer.queue(key, () => this._database.tombstoneAndUnregisterSession(key));
	}

	/** Whether `session` is currently a member of the Fumie catalog. */
	async has(session: URI): Promise<boolean> {
		return (await this._database.getSession(session.toString())) !== undefined;
	}

	/** Every registered session URI key without running legacy metadata migration. */
	async listSessionKeys(): Promise<ReadonlySet<string>> {
		return new Set((await this._database.listSessions()).map(entry => entry.session));
	}

	/**
	 * Every session currently recorded, in no particular order. Legacy entries
	 * are passed through `migrate`, when provided, before the resolved list is returned.
	 */
	async list(migrate?: RegisteredSessionMigration): Promise<IRegisteredSession[]> {
		const entries: IStoredRegisteredSession[] = (await this._database.listSessions()).map(entry => ({
			session: URI.parse(entry.session),
			provider: entry.provider,
			startTime: entry.startTime,
			external: entry.external,
			source: entry.source,
		}));
		const limiter = new Limiter<IRegisteredSession | undefined>(4);
		const migrations: readonly (IRegisteredSession | undefined)[] = migrate
			? await Promise.all(entries.map(entry => limiter.queue(() => migrate(entry))))
			: entries.map(() => undefined);
		const updates: IAgentHostDatabaseExternalUpdate[] = [];
		const result = entries.map((entry, index): IRegisteredSession => {
			const migrated = migrations[index];
			if (migrated) {
				this._assertMigrationPreservesIdentity(entry, migrated);
				updates.push({
					session: entry.session.toString(),
					external: migrated.external,
				});
				return migrated;
			}
			if (entry.external === undefined) {
				throw new Error(`Session migration did not resolve registry entry ${entry.session.toString()}`);
			}
			return {
				...entry,
				external: entry.external,
			};
		});
		if (updates.length > 0) {
			await this._database.updateSessionExternal(updates);
		}
		return result;
	}

	/** Returns the session registered under `session`, or `undefined` when it is unknown. */
	async get(session: URI, migrate?: RegisteredSessionMigration): Promise<IRegisteredSession | undefined> {
		const stored = await this._database.getSession(session.toString());
		if (!stored) {
			return undefined;
		}
		const entry: IStoredRegisteredSession = {
			session: URI.parse(stored.session),
			provider: stored.provider,
			startTime: stored.startTime,
			external: stored.external,
			source: stored.source,
		};
		const migrated = await migrate?.(entry);
		if (migrated) {
			this._assertMigrationPreservesIdentity(entry, migrated);
			await this._database.updateSessionExternal([{ session: entry.session.toString(), external: migrated.external }]);
			return migrated;
		}
		if (entry.external === undefined) {
			throw new Error(`Session migration did not resolve registry entry ${entry.session.toString()}`);
		}
		return {
			...entry,
			external: entry.external,
		};
	}

	/** Whether the registry has ever been populated. Retained for compatibility. */
	async isEmpty(): Promise<boolean> {
		return this._database.isSessionRegistryEmpty();
	}

	/**
	 * @deprecated legacy global one-shot marker, retained for reading databases
	 * written before per-provider tracking existed; see
	 * {@link isProviderBackfilled} for per-provider discovery diagnostics.
	 */
	async isBackfilled(): Promise<boolean> {
		return this._database.isSessionRegistryBackfilled();
	}

	/** Writes the legacy global marker for explicit migration tooling. */
	async markBackfilled(): Promise<void> {
		await this._database.markSessionRegistryBackfilled();
	}

	/** Whether a specific provider has completed native discovery at least once. */
	async isProviderBackfilled(provider: AgentProvider): Promise<boolean> {
		return this._database.isProviderBackfilled(provider);
	}

	/** Records a provider-native discovery pass idempotently. */
	async markProviderBackfilled(provider: AgentProvider): Promise<void> {
		await this._database.markProviderBackfilled(provider);
	}

	/** Whether `session` was explicitly deleted and must not be resurrected by backfill. */
	async isTombstoned(session: URI): Promise<boolean> {
		return this._database.isSessionTombstoned(session.toString());
	}

	/** Clears an explicit-deletion tombstone for `session` (used on explicit create). */
	clearTombstone(session: URI): Promise<void> {
		const key = session.toString();
		return this._sessionSequencer.queue(key, () => this._database.clearSessionTombstone(key));
	}

	/** Maintains the host-owned index of Agent-Merge-enabled sessions. */
	setAgentMergeEnabled(session: URI, enabled: boolean): Promise<void> {
		const key = session.toString();
		return this._sessionSequencer.queue(key, () => this._database.setSessionAgentMergeEnabled(key, enabled));
	}

	/** Session URIs the index marks Agent-Merge-enabled, without opening any session database. */
	async listAgentMergeEnabled(): Promise<readonly URI[]> {
		const sessions = await this._database.listAgentMergeEnabledSessions();
		return sessions.map(session => URI.parse(session));
	}

	private _assertMigrationPreservesIdentity(stored: IStoredRegisteredSession, migrated: IRegisteredSession): void {
		if (migrated.session.toString() !== stored.session.toString()
			|| migrated.provider !== stored.provider
			|| migrated.startTime !== stored.startTime) {
			throw new Error(`Session migration cannot change the identity of ${stored.session.toString()}`);
		}
	}
}
