/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir } from 'os';
import type { Database } from '@vscode/sqlite3';
import { isAbsolute, join, resolve } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AgentHostFumieHomeEnvVar } from '../../common/agentHostProductEnv.js';

export const OpencodeDbEnvVar = 'OPENCODE_DB';
const XDG_DATA_HOME_ENV = 'XDG_DATA_HOME';
const OPENCODE_DATABASE_FILE = 'opencode.db';
const INITIALIZATION_LOCK = '.opencode.db.initialize.lock';
const INITIALIZATION_LOCK_OWNER = 'owner.json';
const LOCK_WAIT_TIMEOUT_MS = 60_000;
const LOCK_RETRY_DELAY_MS = 20;
const OWNER_WRITE_GRACE_MS = 2_000;
const BACKUP_STEP_PAGES = 256;

interface ISqliteBackup {
	readonly completed: boolean;
	readonly failed: boolean;
	step(pages: number, callback: (error: Error | null, completed: boolean) => void): void;
	finish(callback?: () => void): void;
}

interface IDatabaseWithBackup extends Database {
	backup(path: string, callback: (error: Error | null) => void): ISqliteBackup;
}

interface ISqliteError extends Error {
	readonly errno?: number;
	readonly code?: string;
}

interface IInitializationLockOwner {
	readonly version: 1;
	readonly pid: number;
	readonly token: string;
}

/** The native OpenCode database to seed from and Fumie's isolated destination. */
export interface IOpencodeBackingStorePaths {
	readonly nativeDbPath: string;
	readonly dbPath: string;
}

function expandUserPath(value: string | undefined, userHome: string): string | undefined {
	if (!value) {
		return undefined;
	}
	if (value === '~') {
		return userHome;
	}
	if (value.startsWith('~/') || value.startsWith('~\\')) {
		return `${userHome}${value.slice(1)}`;
	}
	return value;
}

/**
 * Resolves the same database override OpenCode uses while keeping Fumie's store
 * under its own provider namespace.
 */
export function resolveOpencodeBackingStorePaths(
	env: NodeJS.ProcessEnv = process.env,
	userHome: string = homedir(),
): IOpencodeBackingStorePaths {
	const absoluteHome = resolve(userHome);
	const fumieHome = resolve(expandUserPath(env[AgentHostFumieHomeEnvVar], absoluteHome) ?? join(absoluteHome, '.fumie'));
	const xdgDataHome = resolve(expandUserPath(env[XDG_DATA_HOME_ENV], absoluteHome) ?? join(absoluteHome, '.local', 'share'));
	const nativeDataPath = join(xdgDataHome, 'opencode');
	const configuredDatabase = env[OpencodeDbEnvVar];
	const nativeDbPath = configuredDatabase === ':memory:'
		? configuredDatabase
		: configuredDatabase
			? resolve(isAbsolute(configuredDatabase) ? configuredDatabase : join(nativeDataPath, configuredDatabase))
			: join(nativeDataPath, OPENCODE_DATABASE_FILE);
	return {
		nativeDbPath,
		dbPath: join(fumieHome, 'providers', 'opencode', OPENCODE_DATABASE_FILE),
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function readInitializationLockOwner(lockPath: string): Promise<IInitializationLockOwner | undefined> {
	try {
		const value = JSON.parse(await fs.readFile(join(lockPath, INITIALIZATION_LOCK_OWNER), 'utf8')) as Partial<IInitializationLockOwner>;
		return value.version === 1 && typeof value.pid === 'number' && typeof value.token === 'string'
			? value as IInitializationLockOwner
			: undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
			return undefined;
		}
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

async function recoverStaleInitializationLock(lockPath: string): Promise<boolean> {
	const owner = await readInitializationLockOwner(lockPath);
	if (owner && isProcessAlive(owner.pid)) {
		return false;
	}
	if (!owner) {
		try {
			const stat = await fs.stat(lockPath);
			if (Date.now() - stat.mtimeMs < OWNER_WRITE_GRACE_MS) {
				return false;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return true;
			}
			throw error;
		}
	}

	// Re-check immediately before the atomic rename so a contender never removes
	// a lock whose owner changed while the stale state was being inspected.
	const currentOwner = await readInitializationLockOwner(lockPath);
	if (owner?.token !== currentOwner?.token || (currentOwner && isProcessAlive(currentOwner.pid))) {
		return false;
	}
	const stalePath = `${lockPath}.stale.${process.pid}.${generateUuid()}`;
	try {
		await fs.rename(lockPath, stalePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return true;
		}
		throw error;
	}
	await fs.rm(stalePath, { recursive: true, force: true });
	return true;
}

async function acquireInitializationLock(lockPath: string, dbPath: string): Promise<(() => Promise<void>) | undefined> {
	const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
	while (true) {
		if (await exists(dbPath)) {
			return undefined;
		}
		try {
			await fs.mkdir(lockPath, { mode: 0o700 });
			const owner: IInitializationLockOwner = { version: 1, pid: process.pid, token: generateUuid() };
			try {
				await fs.writeFile(join(lockPath, INITIALIZATION_LOCK_OWNER), JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
			} catch (error) {
				await fs.rm(lockPath, { recursive: true, force: true });
				throw error;
			}
			return async () => {
				const currentOwner = await readInitializationLockOwner(lockPath);
				if (currentOwner?.token === owner.token) {
					await fs.rm(lockPath, { recursive: true, force: true });
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
			if (await recoverStaleInitializationLock(lockPath)) {
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting to initialize the OpenCode backing store at '${dbPath}'.`);
			}
			await delay(LOCK_RETRY_DELAY_MS);
		}
	}
}

async function openDatabase(path: string, mode?: number): Promise<Database> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	return new Promise((resolve, reject) => {
		const database = mode === undefined
			? new sqlite3.Database(path, error => error ? reject(error) : resolve(database))
			: new sqlite3.Database(path, mode, error => error ? reject(error) : resolve(database));
	});
}

function closeDatabase(database: Database): Promise<void> {
	return new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
}

function exec(database: Database, sql: string): Promise<void> {
	return new Promise((resolve, reject) => database.exec(sql, error => error ? reject(error) : resolve()));
}

function get(database: Database, sql: string): Promise<Record<string, unknown> | undefined> {
	return new Promise((resolve, reject) => {
		database.get(sql, (error: Error | null, row: Record<string, unknown> | undefined) => error ? reject(error) : resolve(row));
	});
}

async function copyDatabase(source: IDatabaseWithBackup, destinationPath: string): Promise<void> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	await new Promise<void>((resolve, reject) => {
		let backup: ISqliteBackup;
		let settled = false;
		const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
		const finishWithError = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			backup.finish(() => reject(error));
		};
		const step = () => {
			if (Date.now() >= deadline) {
				finishWithError(new Error(`Timed out while backing up the native OpenCode database to '${destinationPath}'.`));
				return;
			}
			backup.step(BACKUP_STEP_PAGES, (error, completed) => {
				if (error) {
					const sqliteError = error as ISqliteError;
					const retryable = sqliteError.errno === sqlite3.BUSY || sqliteError.errno === sqlite3.LOCKED
						|| sqliteError.code === 'SQLITE_BUSY' || sqliteError.code === 'SQLITE_LOCKED';
					if (retryable && Date.now() < deadline) {
						setTimeout(step, LOCK_RETRY_DELAY_MS);
						return;
					}
					finishWithError(error);
					return;
				}
				if (completed || backup.completed) {
					settled = true;
					resolve();
					return;
				}
				step();
			});
		};
		backup = source.backup(destinationPath, error => error ? reject(error) : step());
	});
}

async function sanitizeCopiedDatabase(path: string): Promise<void> {
	const database = await openDatabase(path);
	try {
		await exec(database, 'PRAGMA busy_timeout = 5000');
		const requiredTables = await get(database, `
			SELECT COUNT(*) AS count
			FROM sqlite_master
			WHERE type = 'table' AND name IN ('account', 'account_state')
		`);
		if (requiredTables?.count !== 0 && requiredTables?.count !== 2) {
			throw new Error('The native OpenCode database does not contain the account tables required for safe isolation.');
		}

		// Leave a standalone database file for atomic publication. OpenCode turns
		// WAL back on when it opens the isolated copy.
		await exec(database, 'PRAGMA journal_mode = DELETE');
		if (requiredTables?.count === 2) {
			await exec(database, 'PRAGMA secure_delete = ON');
			await exec(database, 'BEGIN IMMEDIATE');
			try {
				await exec(database, 'DELETE FROM account_state; DELETE FROM account');
				await exec(database, 'COMMIT');
			} catch (error) {
				await exec(database, 'ROLLBACK');
				throw error;
			}
		}

		const integrity = await get(database, 'PRAGMA integrity_check');
		if (integrity?.integrity_check !== 'ok') {
			throw new Error('The isolated OpenCode database failed its integrity check.');
		}
	} finally {
		await closeDatabase(database);
	}
}

async function assertExistingDatabaseHasNoNativeAccount(path: string): Promise<void> {
	const sqlite3 = (await import('@vscode/sqlite3')).default;
	const database = await openDatabase(path, sqlite3.OPEN_READONLY);
	try {
		const requiredTables = await get(database, `
			SELECT COUNT(*) AS count
			FROM sqlite_master
			WHERE type = 'table' AND name IN ('account', 'account_state')
		`);
		if (requiredTables?.count === 0) {
			return; // A newly-created empty store; OpenCode will install its schema.
		}
		if (requiredTables?.count !== 2) {
			throw new Error('The isolated OpenCode database has an incomplete account schema.');
		}
		const state = await get(database, `
			SELECT
				(SELECT COUNT(*) FROM account) AS account_count,
				(SELECT COUNT(*) FROM account_state
					WHERE active_account_id IS NOT NULL OR active_org_id IS NOT NULL) AS active_state_count
		`);
		if (state?.account_count !== 0 || state?.active_state_count !== 0) {
			throw new Error('The isolated OpenCode database contains a native account or active organization, so Fumie cannot safely take ownership of it.');
		}
	} finally {
		await closeDatabase(database);
	}
}

async function syncFile(path: string): Promise<void> {
	const handle = await fs.open(path, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(path: string): Promise<void> {
	if (process.platform === 'win32') {
		return;
	}
	const handle = await fs.open(path, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function publishWithoutOverwrite(tempPath: string, dbPath: string): Promise<void> {
	try {
		await fs.link(tempPath, dbPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
	}
}

/**
 * Creates Fumie's OpenCode database once and returns the absolute path to pass
 * to the child process as `OPENCODE_DB`.
 *
 * Existing isolated stores are authoritative and are never refreshed from the
 * native database. On the first run, SQLite's online backup API takes a
 * consistent snapshot of a live WAL database. Only the copy's first-party
 * account and active-organization state is removed; transcripts and integration
 * credentials remain byte-for-byte database rows owned by OpenCode.
 */
export async function prepareOpencodeBackingStore(
	paths: IOpencodeBackingStorePaths = resolveOpencodeBackingStorePaths(),
): Promise<string> {
	const dbPath = resolve(paths.dbPath);
	const nativeDbPath = paths.nativeDbPath === ':memory:' ? paths.nativeDbPath : resolve(paths.nativeDbPath);
	const providerDirectory = join(dbPath, '..');
	await fs.mkdir(providerDirectory, { recursive: true, mode: 0o700 });
	await fs.chmod(providerDirectory, 0o700);
	if (await exists(dbPath)) {
		await assertExistingDatabaseHasNoNativeAccount(dbPath);
		return dbPath;
	}

	const releaseLock = await acquireInitializationLock(join(providerDirectory, INITIALIZATION_LOCK), dbPath);
	if (!releaseLock) {
		await assertExistingDatabaseHasNoNativeAccount(dbPath);
		return dbPath;
	}

	const tempPath = join(providerDirectory, `.${OPENCODE_DATABASE_FILE}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
	try {
		if (await exists(dbPath)) {
			await assertExistingDatabaseHasNoNativeAccount(dbPath);
			return dbPath;
		}

		if (nativeDbPath !== ':memory:' && nativeDbPath !== dbPath && await exists(nativeDbPath)) {
			const sqlite3 = (await import('@vscode/sqlite3')).default;
			const source = await openDatabase(nativeDbPath, sqlite3.OPEN_READONLY) as IDatabaseWithBackup;
			try {
				await copyDatabase(source, tempPath);
			} finally {
				await closeDatabase(source);
			}
			await sanitizeCopiedDatabase(tempPath);
		} else {
			const empty = await openDatabase(tempPath);
			try {
				await exec(empty, 'PRAGMA journal_mode = DELETE');
			} finally {
				await closeDatabase(empty);
			}
		}

		await fs.chmod(tempPath, 0o600);
		await syncFile(tempPath);
		await publishWithoutOverwrite(tempPath, dbPath);
		await assertExistingDatabaseHasNoNativeAccount(dbPath);
		await syncDirectory(providerDirectory);
		return dbPath;
	} finally {
		await Promise.allSettled([
			fs.rm(tempPath, { force: true }),
			fs.rm(`${tempPath}-wal`, { force: true }),
			fs.rm(`${tempPath}-shm`, { force: true }),
			fs.rm(`${tempPath}-journal`, { force: true }),
		]);
		await releaseLock();
	}
}
