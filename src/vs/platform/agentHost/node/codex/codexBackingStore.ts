/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import { dirname, join, resolve } from '../../../../base/common/path.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';
import { AgentHostCodexSqliteHomeEnvVar, AgentHostFumieHomeEnvVar, expandAgentHostUserPath } from '../../common/agentHostProductEnv.js';
import { AgentHostCodexAgentCodexHomeEnvVar } from '../../common/agentService.js';

export const CodexBackingStore = {
	Fumie: 'fumie',
	Native: 'native',
} as const;

export type CodexBackingStore = typeof CodexBackingStore[keyof typeof CodexBackingStore];

const CODEX_BACKING_RECEIPT_VERSION = 1;
const MANAGED_LINKS_FILE = '.fumie-managed-links.json';

export interface ICodexPersistedChat {
	readonly storage: CodexBackingStore;
	readonly sessionId: string;
	readonly threadId?: string;
	readonly provisional?: true;
	readonly model?: ModelSelection;
	readonly ownsManagedWorkingDirectory?: boolean;
}

interface ICodexBackingReceiptV1 {
	readonly version: typeof CODEX_BACKING_RECEIPT_VERSION;
	readonly storage: typeof CodexBackingStore.Fumie;
	readonly sessionId: string;
	readonly threadId?: string;
	readonly provisional?: true;
	readonly model?: ModelSelection;
	readonly ownsManagedWorkingDirectory?: boolean;
}

interface ILegacyCodexBackingReceipt {
	readonly sessionId: string;
	readonly threadId?: string;
	readonly provisional?: true;
	readonly model?: ModelSelection;
	readonly ownsManagedWorkingDirectory?: boolean;
}

export interface ICodexBackingHomes {
	readonly fumie: string;
	readonly native: string;
	readonly nativeSqlite: string;
}

export interface IPreparedCodexBackingHome {
	readonly linked: readonly string[];
	readonly preserved: readonly string[];
}

interface IManagedLinksManifest {
	readonly version: 1;
	readonly links: Readonly<Record<string, string>>;
}

/**
 * New receipts name the Fumie store explicitly. Pre-isolation receipts had no
 * version or storage field, so their only safe interpretation is the native
 * Codex store they were created in. Unknown versions fail closed.
 */
export function decodeCodexChat(data: string | undefined): ICodexPersistedChat | undefined {
	if (data === undefined) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(data) as Record<string, unknown> | null;
		if (!parsed || typeof parsed.sessionId !== 'string') {
			return undefined;
		}
		if (parsed.version === undefined && parsed.storage === undefined) {
			return { ...(parsed as unknown as ILegacyCodexBackingReceipt), storage: CodexBackingStore.Native };
		}
		if (parsed.version === CODEX_BACKING_RECEIPT_VERSION && parsed.storage === CodexBackingStore.Fumie) {
			const receipt = parsed as unknown as ICodexBackingReceiptV1;
			return {
				storage: CodexBackingStore.Fumie,
				sessionId: receipt.sessionId,
				...(receipt.threadId ? { threadId: receipt.threadId } : {}),
				...(receipt.provisional === true ? { provisional: true } : {}),
				...(receipt.model ? { model: receipt.model } : {}),
				...(receipt.ownsManagedWorkingDirectory === true ? { ownsManagedWorkingDirectory: true } : {}),
			};
		}
	} catch {
		// Invalid JSON is not a backing receipt.
	}
	return undefined;
}

/** Writes v1 receipts for Fumie backings and preserves the legacy native shape. */
export function encodeCodexChat(chat: ICodexPersistedChat): string {
	const fields: ILegacyCodexBackingReceipt = {
		sessionId: chat.sessionId,
		...(chat.threadId ? { threadId: chat.threadId } : {}),
		...(chat.provisional === true ? { provisional: true } : {}),
		...(chat.model ? { model: chat.model } : {}),
		...(chat.ownsManagedWorkingDirectory === true ? { ownsManagedWorkingDirectory: true } : {}),
	};
	return chat.storage === CodexBackingStore.Native
		? JSON.stringify(fields)
		: JSON.stringify({ version: CODEX_BACKING_RECEIPT_VERSION, storage: CodexBackingStore.Fumie, ...fields } satisfies ICodexBackingReceiptV1);
}

/** Resolves both stores without deriving one from the other. */
export function resolveCodexBackingHomes(env: Readonly<Record<string, string | undefined>>, userHome = os.homedir()): ICodexBackingHomes {
	const native = expandAgentHostUserPath(env[AgentHostCodexAgentCodexHomeEnvVar]) ?? join(userHome, '.codex');
	return {
		fumie: join(expandAgentHostUserPath(env[AgentHostFumieHomeEnvVar]) ?? join(userHome, '.fumie'), 'providers', 'codex'),
		native,
		nativeSqlite: expandAgentHostUserPath(env[AgentHostCodexSqliteHomeEnvVar]) ?? native,
	};
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(path)).isFile();
	} catch {
		return false;
	}
}

async function readManifest(path: string): Promise<IManagedLinksManifest | undefined> {
	try {
		const parsed = JSON.parse(await fs.promises.readFile(path, 'utf8')) as IManagedLinksManifest;
		return parsed?.version === 1 && parsed.links && typeof parsed.links === 'object' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function readLinkTarget(path: string): Promise<string | undefined> {
	try {
		const stat = await fs.promises.lstat(path);
		if (!stat.isSymbolicLink()) {
			return undefined;
		}
		return resolve(dirname(path), await fs.promises.readlink(path));
	} catch {
		return undefined;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.promises.lstat(path);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ENOENT';
	}
}

/**
 * Creates only Fumie-owned links. A real file or an unrecognized symlink at a
 * target is preserved. The manifest lets a later launch refresh/remove links
 * that this adapter previously created without claiming user-authored links.
 */
export async function prepareFumieCodexHome(homes: ICodexBackingHomes): Promise<IPreparedCodexBackingHome> {
	await fs.promises.mkdir(homes.fumie, { recursive: true, mode: 0o700 });
	const manifestPath = join(homes.fumie, MANAGED_LINKS_FILE);
	const previous = await readManifest(manifestPath);
	const desired = new Map<string, string>();
	const override = join(homes.native, 'AGENTS.override.md');
	const agents = join(homes.native, 'AGENTS.md');
	if (await isFile(override)) {
		desired.set('AGENTS.override.md', override);
	} else if (await isFile(agents)) {
		desired.set('AGENTS.md', agents);
	}

	const managed: Record<string, string> = {};
	const linked: string[] = [];
	const preserved: string[] = [];
	for (const [name, oldSource] of Object.entries(previous?.links ?? {})) {
		if (desired.has(name)) {
			continue;
		}
		const target = join(homes.fumie, name);
		if (await readLinkTarget(target) === resolve(oldSource)) {
			await fs.promises.unlink(target);
		}
	}

	for (const [name, source] of desired) {
		const target = join(homes.fumie, name);
		const currentLink = await readLinkTarget(target);
		if (currentLink === resolve(source)) {
			managed[name] = source;
			linked.push(name);
			continue;
		}
		if (currentLink !== undefined && previous?.links[name] && currentLink === resolve(previous.links[name])) {
			await fs.promises.unlink(target);
		} else if (await pathExists(target)) {
			preserved.push(name);
			continue;
		}
		try {
			await fs.promises.symlink(source, target, 'file');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readLinkTarget(target) !== resolve(source)) {
				throw error;
			}
		}
		managed[name] = source;
		linked.push(name);
	}

	const manifest: IManagedLinksManifest = { version: 1, links: managed };
	const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
	await fs.promises.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, '\t')}\n`, { mode: 0o600 });
	await fs.promises.rename(temporaryManifest, manifestPath);
	return { linked, preserved };
}
