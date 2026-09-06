/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constants as fsConstants, promises as fs, type Dirent } from 'fs';
import { join } from '../../../../base/common/path.js';
import { hasKey } from '../../../../base/common/types.js';
import { ILogService } from '../../../log/common/log.js';

const LegacyGlobalStorageDirectory = join('User', 'globalStorage');
const AgentHostGlobalFiles = [
	'agent-host-config.json',
	'agent-host-storage.json',
] as const;
const LegacyCatalogFiles = [
	'agent-host.db',
	'agent-host.db-shm',
	'agent-host.db-wal',
] as const;
const FumieCatalogFiles = [
	'catalog.db',
	'catalog.db-shm',
	'catalog.db-wal',
] as const;

/**
 * Migrates legacy profile-owned Fumie data into the Cursor-style `FUMIE_HOME`
 * layout. Existing targets always win; legacy roots are removed after every
 * transferable entry has been copied.
 */
export async function migrateLegacyFumieData(
	legacyUserDataPath: string | undefined,
	fumieHome: string | undefined,
	logService: ILogService,
): Promise<void> {
	if (!legacyUserDataPath || !fumieHome || legacyUserDataPath === fumieHome) {
		return;
	}

	const sessionsHome = join(fumieHome, 'sessions');
	let copiedEntries = 0;
	try {
		const directoryMappings = [
			[join(legacyUserDataPath, 'agentSessionData'), sessionsHome],
			[join(legacyUserDataPath, 'agentHost', 'kimi'), join(fumieHome, 'providers', 'kimi')],
			[join(legacyUserDataPath, 'agentHost', 'deepseek'), join(fumieHome, 'providers', 'deepseek')],
			[join(legacyUserDataPath, 'agent-host'), join(fumieHome, 'agent-host')],
			[join(legacyUserDataPath, 'agentPlugins'), join(fumieHome, 'plugins', 'cache')],
		] as const;
		for (const [source, target] of directoryMappings) {
			copiedEntries += await mergeDirectory(source, target);
			await fs.rm(source, { recursive: true, force: true });
		}

		const legacyGlobalStorage = join(legacyUserDataPath, LegacyGlobalStorageDirectory);
		copiedEntries += await migrateCatalogDatabase(legacyGlobalStorage, sessionsHome);
		const fileMappings = AgentHostGlobalFiles.map(file => [file, file] as const);
		for (const [sourceName, targetName] of fileMappings) {
			const source = join(legacyGlobalStorage, sourceName);
			copiedEntries += await copyFileIfMissing(source, join(sessionsHome, targetName));
			await fs.rm(source, { force: true });
		}
	} catch (error) {
		logService.error(`[FumieDataMigration] Failed to copy legacy data from '${legacyUserDataPath}' to '${fumieHome}'`, error);
		return;
	}

	if (copiedEntries > 0) {
		logService.info(`[FumieDataMigration] Migrated ${copiedEntries} legacy data entr${copiedEntries === 1 ? 'y' : 'ies'} into '${fumieHome}' and removed the old Fumie-owned roots`);
	}
}

/**
 * Migrates the SQLite catalog as one unit. A new catalog always wins as a
 * whole: legacy WAL/SHM files must never be attached to an existing main DB.
 * When publishing a legacy catalog, sidecars land first and the main DB last,
 * so an interrupted attempt never exposes a partially copied catalog as
 * complete. Failed publications remove only the files created by this attempt;
 * source cleanup remains idempotent and is retried on the next startup.
 */
async function migrateCatalogDatabase(sourceDirectory: string, targetDirectory: string): Promise<number> {
	const sources = LegacyCatalogFiles.map(file => join(sourceDirectory, file));
	const targets = FumieCatalogFiles.map(file => join(targetDirectory, file));

	if (await pathExists(targets[0])) {
		await removeFiles(sources);
		return 0;
	}
	if (!await pathExists(sources[0])) {
		// Sidecars without their main DB are not a transferable catalog.
		await removeFiles(sources.slice(1));
		return 0;
	}

	await fs.mkdir(targetDirectory, { recursive: true });
	// A missing main DB makes any target sidecars leftovers from an interrupted
	// migration. Remove them before publishing one coherent source generation.
	await removeFiles(targets.slice(1));

	const published: string[] = [];
	try {
		for (let index = 1; index < sources.length; index++) {
			if (await copyFileIfPresent(sources[index], targets[index])) {
				published.push(targets[index]);
			}
		}
		await fs.copyFile(sources[0], targets[0], fsConstants.COPYFILE_EXCL);
		published.push(targets[0]);
	} catch (error) {
		await removeFiles(published);
		throw error;
	}

	await removeFiles(sources);
	return published.length;
}

async function copyFileIfPresent(source: string, target: string): Promise<boolean> {
	try {
		await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
		return true;
	} catch (error) {
		if (isFileSystemError(error, 'ENOENT')) {
			return false;
		}
		throw error;
	}
}

async function removeFiles(paths: readonly string[]): Promise<void> {
	for (const path of paths) {
		await fs.rm(path, { force: true });
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.lstat(path);
		return true;
	} catch (error) {
		if (isFileSystemError(error, 'ENOENT')) {
			return false;
		}
		throw error;
	}
}

async function mergeDirectory(source: string, target: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(source, { withFileTypes: true });
	} catch (error) {
		if (isFileSystemError(error, 'ENOENT')) {
			return 0;
		}
		throw error;
	}

	await fs.mkdir(target, { recursive: true });
	let copiedEntries = 0;
	for (const entry of entries) {
		const sourceEntry = join(source, entry.name);
		const targetEntry = join(target, entry.name);
		if (entry.isDirectory()) {
			copiedEntries += await mergeDirectory(sourceEntry, targetEntry);
			continue;
		}
		copiedEntries += await copyEntryIfMissing(sourceEntry, targetEntry);
	}
	return copiedEntries;
}

async function copyFileIfMissing(source: string, target: string): Promise<number> {
	try {
		await fs.mkdir(join(target, '..'), { recursive: true });
		await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
		return 1;
	} catch (error) {
		if (isFileSystemError(error, 'ENOENT') || isFileSystemError(error, 'EEXIST')) {
			return 0;
		}
		throw error;
	}
}

async function copyEntryIfMissing(source: string, target: string): Promise<number> {
	try {
		await fs.lstat(target);
		return 0;
	} catch (error) {
		if (!isFileSystemError(error, 'ENOENT')) {
			throw error;
		}
	}

	await fs.cp(source, target, { recursive: true, errorOnExist: false, force: false, preserveTimestamps: true });
	return 1;
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && hasFileSystemErrorCode(error, code);
}

function hasFileSystemErrorCode(error: Error | { code: unknown }, code: string): boolean {
	return hasKey(error, { code: true }) && error.code === code;
}
