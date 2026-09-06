/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeProviderData, type IPersistedChat } from '../agentChatBackings.js';

const CLAUDE_CHAT_BACKING_VERSION = 1;

/**
 * Historical Claude transcript in the user's native Claude storage. Old
 * receipts did not persist the project directory, so it remains optional for
 * compatibility and must not be guessed by a cleanup sweep.
 */
export interface IClaudeLegacyLocalBackingStorage {
	readonly kind: 'legacy-local-v0';
	readonly projectDir?: string;
}

/** Fumie-owned Claude SessionStore namespace introduced by lifecycle v1. */
export interface IClaudeFumieStoreBackingStorage {
	readonly kind: 'fumie-store-v1';
	/** Directory the Claude SDK deterministically projects onto `projectKey`. */
	readonly projectDir: string;
}

export type ClaudeChatBackingStorage = IClaudeLegacyLocalBackingStorage | IClaudeFumieStoreBackingStorage;

/**
 * Claude's opaque, exact-chat backing receipt.
 *
 * Agent Host persists this object without interpreting it. `storage` is the
 * durable routing fact that lets a cold lifecycle operation select the right
 * namespace without scanning either Fumie or native Claude history.
 */
export interface IClaudePersistedChatBacking extends IPersistedChat {
	readonly storage: ClaudeChatBackingStorage;
}

interface IClaudePersistedChatBackingV1 extends IPersistedChat {
	readonly version: typeof CLAUDE_CHAT_BACKING_VERSION;
	readonly storage: ClaudeChatBackingStorage;
}

/** Encode a new, versioned Claude backing receipt. */
export function encodeClaudeChatBacking(backing: IClaudePersistedChatBacking): string {
	const persisted: IClaudePersistedChatBackingV1 = {
		version: CLAUDE_CHAT_BACKING_VERSION,
		sdkSessionId: backing.sdkSessionId,
		...(backing.model ? { model: backing.model } : {}),
		...(backing.agent ? { agent: backing.agent } : {}),
		...(backing.sideChat ? { sideChat: backing.sideChat } : {}),
		storage: backing.storage,
	};
	return JSON.stringify(persisted);
}

/**
 * Decode a Claude backing receipt.
 *
 * Receipts written before versioning were the shared `IPersistedChat` JSON
 * shape. They are classified as `legacy-local-v0` with an unknown project
 * directory; no path is inferred. Unknown future versions and malformed
 * Fumie-store routing data fail closed.
 */
export function decodeClaudeChatBacking(providerData: string): IClaudePersistedChatBacking | undefined {
	const base = decodeProviderData(providerData);
	if (!base) {
		return undefined;
	}

	let raw: { readonly version?: unknown; readonly storage?: unknown };
	try {
		raw = JSON.parse(providerData) as { readonly version?: unknown; readonly storage?: unknown };
	} catch {
		return undefined;
	}

	if (raw.version === undefined) {
		return { ...base, storage: { kind: 'legacy-local-v0' } };
	}
	if (raw.version !== CLAUDE_CHAT_BACKING_VERSION) {
		return undefined;
	}
	const storage = decodeStorage(raw.storage);
	return storage ? { ...base, storage } : undefined;
}

function decodeStorage(value: unknown): ClaudeChatBackingStorage | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { kind, projectDir } = value as { readonly kind?: unknown; readonly projectDir?: unknown };
	if (kind === 'legacy-local-v0') {
		return projectDir === undefined
			? { kind }
			: typeof projectDir === 'string' && projectDir.length > 0
				? { kind, projectDir }
				: undefined;
	}
	if (kind === 'fumie-store-v1' && typeof projectDir === 'string' && projectDir.length > 0) {
		return { kind, projectDir };
	}
	return undefined;
}
