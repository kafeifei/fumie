/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type { Database, RunResult } from '@vscode/sqlite3';
import { dirname } from '../../../base/common/path.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { AgentProvider } from '../common/agent.js';

/**
 * Durable origin used to resolve competing registrations for the same session.
 * In particular, discovery may upgrade a restored session to external, but must
 * never override an explicitly created Agent Host session. Removing legacy
 * migration alone does not make this redundant; it can only be removed if
 * registration APIs encode these conflict rules without relying on stored origin.
 */
export type AgentSessionRegistrationSource = 'explicit' | 'restore' | 'discovery';

export interface IAgentHostDatabaseSession {
	readonly session: string;
	readonly provider: AgentProvider;
	readonly startTime: number;
	readonly external: boolean | undefined;
	readonly source: AgentSessionRegistrationSource;
}

export interface IAgentHostDatabaseSessionOptions {
	readonly provider: AgentProvider;
	readonly startTime: number;
	readonly source: AgentSessionRegistrationSource;
}

export interface IAgentHostDatabaseRegisterOptions {
	readonly checkTombstone: boolean;
}

export interface IAgentHostDatabaseExternalUpdate {
	readonly session: string;
	readonly external: boolean;
}

/** Durable representation of an in-progress Fumie session deletion. */
export interface IAgentHostDatabaseSessionDeleteIntent {
	readonly session: string;
	readonly operationId: string;
	readonly provider: string;
	readonly phase: string;
	readonly targetsJson: string;
	readonly attempt: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly lastError: string | undefined;
}

/** Mutable fields of an existing Fumie session deletion. */
export interface IAgentHostDatabaseSessionDeleteIntentUpdate {
	readonly phase: string;
	readonly targetsJson: string;
	readonly attempt: number;
	readonly updatedAt: number;
	readonly lastError: string | undefined;
}

/**
 * Lifecycle transaction storage colocated with the Fumie session catalog.
 *
 * This is an optional capability on {@link IAgentHostDatabase} so legacy test
 * doubles that only exercise registry behavior remain valid. Production
 * {@link AgentHostDatabase} instances always expose it.
 */
export interface IAgentHostDatabaseSessionLifecycle {
	/** Insert `intent`, or return the already-prepared intent for its session. */
	prepareDeleteIntent(intent: IAgentHostDatabaseSessionDeleteIntent): Promise<IAgentHostDatabaseSessionDeleteIntent>;
	getDeleteIntent(session: string): Promise<IAgentHostDatabaseSessionDeleteIntent | undefined>;
	listDeleteIntents(): Promise<readonly IAgentHostDatabaseSessionDeleteIntent[]>;
	/** Update only when `operationId` still owns the session's intent. */
	updateDeleteIntent(session: string, operationId: string, update: IAgentHostDatabaseSessionDeleteIntentUpdate): Promise<boolean>;
	/** Atomically tombstone, unregister, and clear the matching delete intent. */
	finalizeDeleteIntent(session: string, operationId: string): Promise<boolean>;
}

export interface IAgentHostDatabase extends IDisposable {
	readonly sessionLifecycle?: IAgentHostDatabaseSessionLifecycle;
	/**
	 * Records a session with source-aware provenance. When requested, the
	 * tombstone check and registration are atomic.
	 */
	registerSession(session: string, sessionOptions: IAgentHostDatabaseSessionOptions, registerOptions: IAgentHostDatabaseRegisterOptions): Promise<boolean>;
	unregisterSession(session: string): Promise<void>;
	/** Atomically tombstones and removes a session so a stale restore cannot re-register it. */
	tombstoneAndUnregisterSession(session: string): Promise<void>;
	updateSessionExternal(updates: readonly IAgentHostDatabaseExternalUpdate[]): Promise<void>;
	getSession(session: string): Promise<IAgentHostDatabaseSession | undefined>;
	listSessions(): Promise<readonly IAgentHostDatabaseSession[]>;
	isSessionRegistryEmpty(): Promise<boolean>;
	/**
	 * @deprecated superseded by per-provider {@link isProviderBackfilled}.
	 * Retained only for reading databases written by pre-per-provider code.
	 * Neither this marker nor per-provider markers gate native discovery.
	 */
	isSessionRegistryBackfilled(): Promise<boolean>;
	/** @deprecated see {@link isSessionRegistryBackfilled}. */
	markSessionRegistryBackfilled(): Promise<void>;
	/** Whether `provider` has completed native discovery at least once (for compatibility/diagnostics). */
	isProviderBackfilled(provider: AgentProvider): Promise<boolean>;
	/** Durably records a completed provider-native discovery pass. */
	markProviderBackfilled(provider: AgentProvider): Promise<void>;
	/** Whether `session` was explicitly deleted and must not be resurrected by backfill. */
	isSessionTombstoned(session: string): Promise<boolean>;
	/** Durably records that `session` was explicitly deleted. */
	markSessionTombstoned(session: string): Promise<void>;
	/** Clears a session's deletion tombstone (used on explicit create). */
	clearSessionTombstone(session: string): Promise<void>;
	/**
	 * Records whether Agent Merge is enabled for `session`. This host-owned index
	 * lets startup find the few monitored sessions without opening every session
	 * database.
	 */
	setSessionAgentMergeEnabled(session: string, enabled: boolean): Promise<void>;
	/** Session URIs currently marked Agent-Merge-enabled. */
	listAgentMergeEnabledSessions(): Promise<readonly string[]>;
	close(): Promise<void>;
}

const migrations = [
	{
		version: 1,
		sql: [
			`CREATE TABLE IF NOT EXISTS sessions (
				session_uri TEXT PRIMARY KEY NOT NULL,
				provider    TEXT NOT NULL,
				start_time  INTEGER NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS metadata (
				key   TEXT PRIMARY KEY NOT NULL,
				value TEXT NOT NULL
			)`,
		].join(';\n'),
	},
] as const;

const currentSchemaVersion = 4;

/**
 * Reconciles the two historical version-2 schemas that existed before the
 * Code OSS and Fumie databases converged. Fumie version 2 added deletion
 * intents while upstream version 2 added `external`; relying on user_version
 * alone would therefore skip one side of the schema on existing profiles.
 */
async function migrateCurrentSchema(database: Database): Promise<void> {
	const columns = await all(database, 'PRAGMA table_info(sessions)', []);
	const columnNames = new Set(columns.map(column => column.name as string));

	await exec(database, 'BEGIN TRANSACTION');
	try {
		if (!columnNames.has('external')) {
			await exec(database, 'ALTER TABLE sessions ADD COLUMN external INTEGER');
		}
		if (!columnNames.has('registration_source')) {
			await exec(database, `ALTER TABLE sessions ADD COLUMN registration_source TEXT NOT NULL DEFAULT 'explicit'`);
			await exec(database, `UPDATE sessions SET registration_source = CASE WHEN external = 1 THEN 'discovery' ELSE 'explicit' END`);
		}
		await exec(database, [
			`CREATE TABLE IF NOT EXISTS session_delete_intents (
				session_uri TEXT PRIMARY KEY NOT NULL,
				operation_id TEXT UNIQUE NOT NULL,
				provider TEXT NOT NULL,
				phase TEXT NOT NULL,
				targets_json TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_error TEXT
			)`,
			`CREATE INDEX IF NOT EXISTS session_delete_intents_provider
				ON session_delete_intents (provider)`,
		].join(';\n'));
		await exec(database, `PRAGMA user_version = ${currentSchemaVersion}`);
		await exec(database, 'COMMIT');
	} catch (error) {
		await exec(database, 'ROLLBACK');
		throw error;
	}
}

function openDatabase(path: string): Promise<Database> {
	return new Promise((resolve, reject) => {
		import('@vscode/sqlite3').then(sqlite3 => {
			const database = new sqlite3.default.Database(path, error => error ? reject(error) : resolve(database));
		}, reject);
	});
}

function exec(database: Database, sql: string): Promise<void> {
	return new Promise((resolve, reject) => database.exec(sql, error => error ? reject(error) : resolve()));
}

function run(database: Database, sql: string, parameters: readonly unknown[]): Promise<void> {
	return new Promise((resolve, reject) => {
		database.run(sql, parameters, function (this: RunResult, error: Error | null) {
			error ? reject(error) : resolve();
		});
	});
}

/** Like {@link run}, but resolves with the number of rows the statement actually affected. */
function runReturningChanges(database: Database, sql: string, parameters: readonly unknown[]): Promise<number> {
	return new Promise((resolve, reject) => {
		database.run(sql, parameters, function (this: RunResult, error: Error | null) {
			error ? reject(error) : resolve(this.changes);
		});
	});
}

function get(database: Database, sql: string, parameters: readonly unknown[]): Promise<Record<string, unknown> | undefined> {
	return new Promise((resolve, reject) => {
		database.get(sql, parameters, (error: Error | null, row: Record<string, unknown> | undefined) => error ? reject(error) : resolve(row));
	});
}

function all(database: Database, sql: string, parameters: readonly unknown[]): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		database.all(sql, parameters, (error: Error | null, rows: Record<string, unknown>[]) => error ? reject(error) : resolve(rows));
	});
}

/** Metadata key for the durable per-provider backfill-completion marker. */
function providerBackfillKey(provider: AgentProvider): string {
	return `sessionRegistryBackfilled:${provider}`;
}

/** Metadata key for a session's durable "explicitly deleted" tombstone. */
function tombstoneKey(session: string): string {
	return `sessionTombstone:${session}`;
}

const agentMergeEnabledKeyPrefix = 'agentMergeEnabled:';

/** Metadata key marking a session as Agent-Merge-enabled. */
function agentMergeEnabledKey(session: string): string {
	return `${agentMergeEnabledKeyPrefix}${session}`;
}

function quoteSqlString(value: string): string {
	return `'${value.replaceAll('\'', '\'\'')}'`;
}

function close(database: Database): Promise<void> {
	return new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
}

function readDeleteIntent(row: Record<string, unknown>): IAgentHostDatabaseSessionDeleteIntent {
	return {
		session: row.session_uri as string,
		operationId: row.operation_id as string,
		provider: row.provider as string,
		phase: row.phase as string,
		targetsJson: row.targets_json as string,
		attempt: row.attempt as number,
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
		lastError: typeof row.last_error === 'string' ? row.last_error : undefined,
	};
}

export class AgentHostDatabase implements IAgentHostDatabase {

	private _databasePromise: Promise<Database> | undefined;
	private _closed: Promise<void> | true | undefined;

	constructor(private readonly _path: string) { }

	get sessionLifecycle(): IAgentHostDatabaseSessionLifecycle { return this; }

	async prepareDeleteIntent(intent: IAgentHostDatabaseSessionDeleteIntent): Promise<IAgentHostDatabaseSessionDeleteIntent> {
		const database = await this._ensureDatabase();
		await run(
			database,
			`INSERT INTO session_delete_intents (
				session_uri, operation_id, provider, phase, targets_json,
				attempt, created_at, updated_at, last_error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_uri) DO NOTHING`,
			[
				intent.session,
				intent.operationId,
				intent.provider,
				intent.phase,
				intent.targetsJson,
				intent.attempt,
				intent.createdAt,
				intent.updatedAt,
				intent.lastError ?? null,
			],
		);
		const row = await get(database, 'SELECT * FROM session_delete_intents WHERE session_uri = ?', [intent.session]);
		if (!row) {
			throw new Error(`Failed to prepare session deletion: ${intent.session}`);
		}
		return readDeleteIntent(row);
	}

	async getDeleteIntent(session: string): Promise<IAgentHostDatabaseSessionDeleteIntent | undefined> {
		const row = await get(await this._ensureDatabase(), 'SELECT * FROM session_delete_intents WHERE session_uri = ?', [session]);
		return row ? readDeleteIntent(row) : undefined;
	}

	async listDeleteIntents(): Promise<readonly IAgentHostDatabaseSessionDeleteIntent[]> {
		const rows = await all(await this._ensureDatabase(), 'SELECT * FROM session_delete_intents ORDER BY created_at, session_uri', []);
		return rows.map(readDeleteIntent);
	}

	async updateDeleteIntent(session: string, operationId: string, update: IAgentHostDatabaseSessionDeleteIntentUpdate): Promise<boolean> {
		const changes = await runReturningChanges(
			await this._ensureDatabase(),
			`UPDATE session_delete_intents
				SET phase = ?, targets_json = ?, attempt = ?, updated_at = ?, last_error = ?
				WHERE session_uri = ? AND operation_id = ?`,
			[
				update.phase,
				update.targetsJson,
				update.attempt,
				update.updatedAt,
				update.lastError ?? null,
				session,
				operationId,
			],
		);
		return changes > 0;
	}

	async finalizeDeleteIntent(session: string, operationId: string): Promise<boolean> {
		const database = await this._ensureDatabase();
		await exec(database, 'BEGIN IMMEDIATE');
		try {
			const intent = await get(
				database,
				'SELECT operation_id FROM session_delete_intents WHERE session_uri = ?',
				[session],
			);
			if (intent?.operation_id !== operationId) {
				await exec(database, 'ROLLBACK');
				return false;
			}
			await run(
				database,
				`INSERT INTO metadata (key, value) VALUES (?, 'true')
					ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				[tombstoneKey(session)],
			);
			await run(database, 'DELETE FROM metadata WHERE key = ?', [agentMergeEnabledKey(session)]);
			await run(database, 'DELETE FROM sessions WHERE session_uri = ?', [session]);
			await run(
				database,
				'DELETE FROM session_delete_intents WHERE session_uri = ? AND operation_id = ?',
				[session, operationId],
			);
			await exec(database, 'COMMIT');
			return true;
		} catch (error) {
			try {
				await exec(database, 'ROLLBACK');
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], `Failed to finalize session deletion ${session}`);
			}
			throw error;
		}
	}

	async registerSession(session: string, sessionOptions: IAgentHostDatabaseSessionOptions, registerOptions: IAgentHostDatabaseRegisterOptions): Promise<boolean> {
		const { provider, startTime, source } = sessionOptions;
		const changes = await runReturningChanges(
			await this._ensureDatabase(),
			`INSERT INTO sessions (session_uri, provider, start_time, external, registration_source)
				SELECT ?, ?, ?, CASE WHEN ? = 'discovery' THEN 1 ELSE 0 END, ?
				WHERE ? = 0 OR NOT EXISTS (SELECT 1 FROM metadata WHERE key = ? AND value = 'true')
				ON CONFLICT(session_uri) DO UPDATE SET
					provider = CASE WHEN excluded.registration_source = 'explicit' THEN excluded.provider ELSE sessions.provider END,
					external = CASE
						WHEN excluded.registration_source = 'explicit' THEN 0
						WHEN excluded.registration_source = 'restore' THEN 0
						WHEN sessions.registration_source = 'explicit' THEN sessions.external
						ELSE 1
					END,
					registration_source = CASE
						WHEN excluded.registration_source = 'explicit' THEN 'explicit'
						WHEN sessions.registration_source = 'explicit' THEN 'explicit'
						ELSE excluded.registration_source
					END`,
			[session, provider, startTime, source, source, registerOptions.checkTombstone ? 1 : 0, tombstoneKey(session)],
		);
		if (!registerOptions.checkTombstone) {
			await this.clearSessionTombstone(session);
		}
		return changes > 0;
	}

	async unregisterSession(session: string): Promise<void> {
		const database = await this._ensureDatabase();
		try {
			await exec(
				database,
				`BEGIN IMMEDIATE;
				DELETE FROM sessions WHERE session_uri = ${quoteSqlString(session)};
				DELETE FROM metadata WHERE key = ${quoteSqlString(agentMergeEnabledKey(session))};
				COMMIT;`,
			);
		} catch (error) {
			try {
				await exec(database, 'ROLLBACK');
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], `Failed to unregister session ${session}`);
			}
			throw error;
		}
	}

	async tombstoneAndUnregisterSession(session: string): Promise<void> {
		const database = await this._ensureDatabase();
		const sessionValue = quoteSqlString(session);
		const tombstoneValue = quoteSqlString(tombstoneKey(session));
		try {
			await exec(
				database,
				`BEGIN IMMEDIATE;
				INSERT INTO metadata (key, value) VALUES (${tombstoneValue}, 'true')
					ON CONFLICT(key) DO UPDATE SET value = excluded.value;
				DELETE FROM metadata WHERE key = ${quoteSqlString(agentMergeEnabledKey(session))};
				DELETE FROM sessions WHERE session_uri = ${sessionValue};
				COMMIT;`,
			);
		} catch (error) {
			try {
				await exec(database, 'ROLLBACK');
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], `Failed to tombstone session ${session}`);
			}
			throw error;
		}
	}

	async updateSessionExternal(updates: readonly IAgentHostDatabaseExternalUpdate[]): Promise<void> {
		if (updates.length === 0) {
			return;
		}
		const database = await this._ensureDatabase();
		const statements = updates.map(({ session, external }) => {
			const externalValue = external ? 1 : 0;
			const source = external
				? `'discovery'`
				: `CASE WHEN registration_source = 'explicit' THEN 'explicit' ELSE 'restore' END`;
			return `UPDATE sessions SET external = ${externalValue}, registration_source = ${source} WHERE session_uri = ${quoteSqlString(session)} AND external IS NULL`;
		});
		try {
			await exec(database, `BEGIN IMMEDIATE;\n${statements.join(';\n')};\nCOMMIT`);
		} catch (error) {
			try {
				await exec(database, 'ROLLBACK');
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], 'Failed to update legacy session provenance');
			}
			throw error;
		}
	}

	async listSessions(): Promise<readonly IAgentHostDatabaseSession[]> {
		const rows = await all(await this._ensureDatabase(), 'SELECT session_uri, provider, start_time, external, registration_source FROM sessions', []);
		return rows.map(row => ({
			session: row.session_uri as string,
			provider: row.provider as AgentProvider,
			startTime: row.start_time as number,
			external: row.external === null ? undefined : row.external === 1,
			source: row.registration_source as AgentSessionRegistrationSource,
		}));
	}

	async getSession(session: string): Promise<IAgentHostDatabaseSession | undefined> {
		const row = await get(await this._ensureDatabase(), 'SELECT session_uri, provider, start_time, external, registration_source FROM sessions WHERE session_uri = ?', [session]);
		if (!row) {
			return undefined;
		}
		return {
			session: row.session_uri as string,
			provider: row.provider as AgentProvider,
			startTime: row.start_time as number,
			external: row.external === null || row.external === undefined ? undefined : row.external === 1,
			source: row.registration_source as AgentSessionRegistrationSource,
		};
	}

	async isSessionRegistryEmpty(): Promise<boolean> {
		const row = await get(await this._ensureDatabase(), 'SELECT 1 AS present FROM sessions LIMIT 1', []);
		return row === undefined;
	}

	async isSessionRegistryBackfilled(): Promise<boolean> {
		const row = await get(await this._ensureDatabase(), `SELECT value FROM metadata WHERE key = 'sessionRegistryBackfilled'`, []);
		return row?.value === 'true';
	}

	markSessionRegistryBackfilled(): Promise<void> {
		return this._run(
			`INSERT INTO metadata (key, value) VALUES ('sessionRegistryBackfilled', 'true')
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			[],
		);
	}

	async isProviderBackfilled(provider: AgentProvider): Promise<boolean> {
		const row = await get(await this._ensureDatabase(), 'SELECT value FROM metadata WHERE key = ?', [providerBackfillKey(provider)]);
		return row?.value === 'true';
	}

	markProviderBackfilled(provider: AgentProvider): Promise<void> {
		return this._run(
			`INSERT INTO metadata (key, value) VALUES (?, 'true')
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			[providerBackfillKey(provider)],
		);
	}

	async isSessionTombstoned(session: string): Promise<boolean> {
		const row = await get(await this._ensureDatabase(), 'SELECT value FROM metadata WHERE key = ?', [tombstoneKey(session)]);
		return row?.value === 'true';
	}

	markSessionTombstoned(session: string): Promise<void> {
		return this._run(
			`INSERT INTO metadata (key, value) VALUES (?, 'true')
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			[tombstoneKey(session)],
		);
	}

	clearSessionTombstone(session: string): Promise<void> {
		return this._run('DELETE FROM metadata WHERE key = ?', [tombstoneKey(session)]);
	}

	setSessionAgentMergeEnabled(session: string, enabled: boolean): Promise<void> {
		return enabled
			? this._run(
				`INSERT INTO metadata (key, value) VALUES (?, 'true')
					ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				[agentMergeEnabledKey(session)],
			)
			: this._run('DELETE FROM metadata WHERE key = ?', [agentMergeEnabledKey(session)]);
	}

	async listAgentMergeEnabledSessions(): Promise<readonly string[]> {
		const rows = await all(
			await this._ensureDatabase(),
			`SELECT key FROM metadata WHERE key LIKE ? || '%' AND value = 'true'`,
			[agentMergeEnabledKeyPrefix],
		);
		return rows.map(row => (row.key as string).slice(agentMergeEnabledKeyPrefix.length));
	}

	private async _run(sql: string, parameters: readonly unknown[]): Promise<void> {
		await run(await this._ensureDatabase(), sql, parameters);
	}

	private _ensureDatabase(): Promise<Database> {
		if (this._closed) {
			return Promise.reject(new Error('AgentHostDatabase has been disposed'));
		}
		if (!this._databasePromise) {
			this._databasePromise = (async () => {
				if (this._path !== ':memory:') {
					await fs.promises.mkdir(dirname(this._path), { recursive: true });
				}
				const database = await openDatabase(this._path);
				try {
					database.serialize();
					const versionRow = await get(database, 'PRAGMA user_version', []);
					const currentVersion = (versionRow?.user_version as number | undefined) ?? 0;
					for (const migration of migrations) {
						if (migration.version > currentVersion) {
							await exec(database, 'BEGIN TRANSACTION');
							try {
								await exec(database, migration.sql);
								await exec(database, `PRAGMA user_version = ${migration.version}`);
								await exec(database, 'COMMIT');
							} catch (error) {
								await exec(database, 'ROLLBACK');
								throw error;
							}
						}
					}
					if (currentVersion < currentSchemaVersion) {
						await migrateCurrentSchema(database);
					}
					return database;
				} catch (error) {
					await close(database);
					throw error;
				}
			})().catch(error => {
				this._databasePromise = undefined;
				throw error;
			});
		}
		return this._databasePromise;
	}

	async close(): Promise<void> {
		await (this._closed ??= this._databasePromise?.then(database => close(database)).catch(() => { }) || true);
	}

	dispose(): void {
		void this.close();
	}
}
