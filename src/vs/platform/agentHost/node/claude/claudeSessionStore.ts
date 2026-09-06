/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { Database, RunResult } from '@vscode/sqlite3';
import { Sequencer, SequencerByKey } from '../../../../base/common/async.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/path.js';

const MAIN_TRANSCRIPT_SUBPATH = '';

const migrations = [
	{
		version: 1,
		sql: [
			`CREATE TABLE IF NOT EXISTS claude_session_entries (
				entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
				project_key TEXT NOT NULL,
				session_id TEXT NOT NULL,
				subpath TEXT NOT NULL,
				uuid TEXT,
				payload TEXT NOT NULL
			)`,
			`CREATE UNIQUE INDEX IF NOT EXISTS claude_session_entries_uuid
				ON claude_session_entries (project_key, session_id, subpath, uuid)
				WHERE uuid IS NOT NULL`,
			`CREATE INDEX IF NOT EXISTS claude_session_entries_lookup
				ON claude_session_entries (project_key, session_id, subpath, entry_id)`,
			`CREATE TABLE IF NOT EXISTS claude_sessions (
				project_key TEXT NOT NULL,
				session_id TEXT NOT NULL,
				mtime INTEGER NOT NULL,
				PRIMARY KEY (project_key, session_id)
			)`,
		].join(';\n'),
	},
] as const;

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

function run(database: Database, sql: string, parameters: readonly unknown[]): Promise<{ readonly changes: number; readonly lastID: number }> {
	return new Promise((resolve, reject) => {
		database.run(sql, parameters, function (this: RunResult, error: Error | null) {
			error ? reject(error) : resolve({ changes: this.changes, lastID: this.lastID });
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

function closeDatabase(database: Database): Promise<void> {
	return new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
}

function sessionKey(key: Pick<SessionKey, 'projectKey' | 'sessionId'>): string {
	return `${key.projectKey}\0${key.sessionId}`;
}

function normalizedSubpath(key: SessionKey): string {
	return key.subpath ?? MAIN_TRANSCRIPT_SUBPATH;
}

/**
 * Fumie-owned durable implementation of the Claude Agent SDK's
 * {@link SessionStore} contract.
 *
 * The SDK owns every entry's schema. This adapter only JSON-round-trips the
 * opaque payload, preserves commit order, and uses a stable entry UUID as an
 * idempotency key when one is present. Main-transcript deletion cascades to
 * every subpath belonging to the same `{ projectKey, sessionId }`.
 *
 * This class is deliberately not wired into {@link ClaudeAgent} yet. It is a
 * dark-launched storage primitive for the Fumie session-lifecycle migration.
 */
export class ClaudeSessionStore implements SessionStore, IDisposable {

	private _databasePromise: Promise<Database> | undefined;
	private _closePromise: Promise<void> | undefined;
	private _isClosed = false;
	private readonly _sessionSequencer = new SequencerByKey<string>();
	private readonly _transactionSequencer = new Sequencer();
	private readonly _pendingOperations = new Set<Promise<unknown>>();

	constructor(private readonly _path: string) { }

	/** Open the store eagerly. Tests should pass `:memory:`. */
	static async open(path: string): Promise<ClaudeSessionStore> {
		const store = new ClaudeSessionStore(path);
		await store._ensureDatabase();
		return store;
	}

	append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
		if (entries.length === 0) {
			return Promise.resolve();
		}
		return this._track(this._sessionSequencer.queue(sessionKey(key), async () => {
			const database = await this._ensureDatabase();
			await this._transactionSequencer.queue(async () => {
				await this._transaction(database, async () => {
					let inserted = 0;
					for (const entry of entries) {
						const result = await run(
							database,
							`INSERT INTO claude_session_entries (
								project_key, session_id, subpath, uuid, payload
							) VALUES (?, ?, ?, ?, ?)
							ON CONFLICT DO NOTHING`,
							[
								key.projectKey,
								key.sessionId,
								normalizedSubpath(key),
								typeof entry.uuid === 'string' ? entry.uuid : null,
								JSON.stringify(entry),
							],
						);
						inserted += result.changes;
					}
					if (inserted > 0 && key.subpath === undefined) {
						const now = Date.now();
						await run(
							database,
							`INSERT INTO claude_sessions (project_key, session_id, mtime)
								VALUES (?, ?, ?)
								ON CONFLICT(project_key, session_id) DO UPDATE SET
								mtime = CASE
									WHEN excluded.mtime > claude_sessions.mtime THEN excluded.mtime
									ELSE claude_sessions.mtime + 1
								END`,
							[key.projectKey, key.sessionId, now],
						);
					}
				});
			});
		}));
	}

	load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
		return this._track(this._sessionSequencer.queue(sessionKey(key), async () => {
			const rows = await all(
				await this._ensureDatabase(),
				`SELECT payload FROM claude_session_entries
					WHERE project_key = ? AND session_id = ? AND subpath = ?
					ORDER BY entry_id`,
				[key.projectKey, key.sessionId, normalizedSubpath(key)],
			);
			if (rows.length === 0) {
				return null;
			}
			return rows.map(row => JSON.parse(row.payload as string) as SessionStoreEntry);
		}));
	}

	listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
		return this._track((async () => {
			const rows = await all(
				await this._ensureDatabase(),
				`SELECT session_id, mtime FROM claude_sessions
					WHERE project_key = ?
					ORDER BY mtime DESC, session_id`,
				[projectKey],
			);
			return rows.map(row => ({ sessionId: row.session_id as string, mtime: row.mtime as number }));
		})());
	}

	delete(key: SessionKey): Promise<void> {
		return this._track(this._sessionSequencer.queue(sessionKey(key), async () => {
			const database = await this._ensureDatabase();
			await this._transactionSequencer.queue(async () => {
				await this._transaction(database, async () => {
					if (key.subpath !== undefined) {
						await run(
							database,
							`DELETE FROM claude_session_entries
								WHERE project_key = ? AND session_id = ? AND subpath = ?`,
							[key.projectKey, key.sessionId, key.subpath],
						);
						return;
					}
					await run(
						database,
						`DELETE FROM claude_session_entries
							WHERE project_key = ? AND session_id = ?`,
						[key.projectKey, key.sessionId],
					);
					await run(
						database,
						`DELETE FROM claude_sessions
							WHERE project_key = ? AND session_id = ?`,
						[key.projectKey, key.sessionId],
					);
				});
			});
		}));
	}

	listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
		return this._track(this._sessionSequencer.queue(sessionKey(key), async () => {
			const rows = await all(
				await this._ensureDatabase(),
				`SELECT DISTINCT subpath FROM claude_session_entries
					WHERE project_key = ? AND session_id = ? AND subpath <> ?
					ORDER BY subpath`,
				[key.projectKey, key.sessionId, MAIN_TRANSCRIPT_SUBPATH],
			);
			return rows.map(row => row.subpath as string);
		}));
	}

	async whenIdle(): Promise<void> {
		while (this._pendingOperations.size > 0) {
			await Promise.allSettled([...this._pendingOperations]);
		}
	}

	close(): Promise<void> {
		return this._closePromise ??= (async () => {
			await this.whenIdle();
			this._isClosed = true;
			const databasePromise = this._databasePromise;
			if (databasePromise) {
				await closeDatabase(await databasePromise);
			}
		})();
	}

	dispose(): void {
		void this.close();
	}

	private async _ensureDatabase(): Promise<Database> {
		if (this._isClosed) {
			throw new Error('ClaudeSessionStore has been disposed');
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
						if (migration.version <= currentVersion) {
							continue;
						}
						await this._transaction(database, async () => {
							await exec(database, migration.sql);
							await exec(database, `PRAGMA user_version = ${migration.version}`);
						});
					}
					return database;
				} catch (error) {
					await closeDatabase(database);
					throw error;
				}
			})().catch(error => {
				this._databasePromise = undefined;
				throw error;
			});
		}
		return this._databasePromise;
	}

	private async _transaction<T>(database: Database, operation: () => Promise<T>): Promise<T> {
		await exec(database, 'BEGIN IMMEDIATE');
		try {
			const result = await operation();
			await exec(database, 'COMMIT');
			return result;
		} catch (error) {
			try {
				await exec(database, 'ROLLBACK');
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], 'ClaudeSessionStore transaction and rollback both failed');
			}
			throw error;
		}
	}

	private _track<T>(operation: Promise<T>): Promise<T> {
		this._pendingOperations.add(operation);
		const untrack = () => this._pendingOperations.delete(operation);
		operation.then(untrack, untrack);
		return operation;
	}
}
