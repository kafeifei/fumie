/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { RemoteAgentHostEntryType } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** Storage key prefix for cached session summaries, per remote authority. */
export const CACHED_SESSIONS_STORAGE_PREFIX = 'remoteAgentHost.cachedSessions.v2.';
// TODO@sandy081 Remove this legacy cache-key cleanup after 2026-10-14.
export const CACHED_SESSIONS_STORAGE_PREFIX_LEGACY = 'remoteAgentHost.cachedSessions.';

/** Storage key holding one host's cached session summaries. */
export function cachedSessionsStorageKey(authority: string): string {
	return `${CACHED_SESSIONS_STORAGE_PREFIX}${authority}`;
}

/**
 * Authorities that have a persisted session cache, whether or not a provider
 * exists for them.
 *
 * The cache is written per authority and read back only by the provider that
 * owns that authority, so a host that stops producing a provider leaves a key
 * nothing can reach. This is the one lookup that has to go through storage
 * directly — there is no host left to ask.
 */
export function listCachedSessionAuthorities(storageService: IStorageService): string[] {
	return storageService.keys(StorageScope.APPLICATION, StorageTarget.USER)
		.filter(key => key.startsWith(CACHED_SESSIONS_STORAGE_PREFIX))
		.map(key => key.slice(CACHED_SESSIONS_STORAGE_PREFIX.length))
		.filter(authority => authority.length > 0);
}

/** How many session summaries are cached for `authority`. */
export function cachedSessionCount(storageService: IStorageService, authority: string): number {
	const raw = storageService.get(cachedSessionsStorageKey(authority), StorageScope.APPLICATION);
	if (!raw) {
		return 0;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.length : 0;
	} catch {
		return 0;
	}
}

/** Drop a host's cached session summaries, including the pre-v2 key. */
export function clearCachedSessions(storageService: IStorageService, authority: string): void {
	storageService.remove(cachedSessionsStorageKey(authority), StorageScope.APPLICATION);
	storageService.remove(`${CACHED_SESSIONS_STORAGE_PREFIX_LEGACY}${authority}`, StorageScope.APPLICATION);
}

/** Storage key holding the user's own names for hosts, keyed by {@link displayNameKey}. */
export const DISPLAY_NAMES_STORAGE_KEY = 'remoteAgentHost.inventory.displayNames';

/** Storage key holding when each host was last seen connected, keyed by address. */
export const LAST_CONNECTED_STORAGE_KEY = 'remoteAgentHost.inventory.lastConnectedAt';

/**
 * The key a host's user-chosen name is stored under.
 *
 * The address is what every store agrees on — a settings entry, a cached
 * tunnel and a live provider for the same host all carry it — so a name keyed
 * by it survives the host moving between those stores. An entry that has lost
 * its address has only its authority left, which is what the address was
 * derived from in the first place.
 */
export function displayNameKey(entry: Pick<IRemoteAgentHostInventoryEntry, 'address' | 'authority'>): string {
	return entry.address ?? entry.authority;
}

/**
 * What a listed host is doing right now.
 *
 * `Orphaned` is the state this inventory exists for: cached sessions on disk
 * whose host is in no store any more, so nothing recreates a provider for them
 * and no other surface in the product can reach them.
 */
export const enum RemoteAgentHostInventoryState {
	Connected = 'connected',
	Connecting = 'connecting',
	Disconnected = 'disconnected',
	Orphaned = 'orphaned',
}

export interface IRemoteAgentHostInventoryEntry {
	/** Storage authority for this host — the key its cached sessions live under. */
	readonly authority: string;
	/** Address the host services address it by, when one is still known. */
	readonly address: string | undefined;
	/** Best available display name: the user's own name for the host when it has one. */
	readonly label: string;
	/** Which store this host comes back from on the next launch. */
	readonly kind: RemoteAgentHostEntryType | 'unknown';
	readonly state: RemoteAgentHostInventoryState;
	/** How many session summaries are cached on disk for this host. */
	readonly cachedSessionCount: number;
	/** When this host was last seen connected, `undefined` if it never has been. */
	readonly lastConnectedAt: number | undefined;
}

export const IRemoteAgentHostInventoryService = createDecorator<IRemoteAgentHostInventoryService>('remoteAgentHostInventoryService');

/**
 * The single place that can see, and erase, every remote agent host this
 * profile remembers.
 *
 * The stores that resurrect a host are spread across a setting, several storage
 * keys and a live provider registry, and each surface in the product reads only
 * the one it owns. A host that has fallen out of some of them keeps its session
 * cache forever, because the only code that deletes that cache needs a live
 * provider for the very host that no longer has one. Reading from storage
 * rather than from the provider registry is what makes those reachable.
 */
export interface IRemoteAgentHostInventoryService {
	readonly _serviceBrand: undefined;

	/** Fires when the inventory may have changed. */
	readonly onDidChange: Event<void>;

	/** Every host this profile remembers, orphans included. */
	list(): IRemoteAgentHostInventoryEntry[];

	/**
	 * Erase a host from every store, so nothing brings it back. Disconnects it
	 * first when it is live; a failure there does not stop the erase, because a
	 * host the user is removing is usually one that cannot answer.
	 */
	forget(entry: IRemoteAgentHostInventoryEntry): Promise<void>;

	/**
	 * Name a host whatever the user calls it, or clear that name with
	 * `undefined`.
	 *
	 * The name is kept here rather than in the store the host comes back from:
	 * those stores are a setting, a tunnel cache and a live provider, only one
	 * of which is writable at all, and every one of them is recreated behind
	 * the user's back. One key beside the inventory renames every kind of host
	 * and undoes with a single delete.
	 */
	rename(entry: IRemoteAgentHostInventoryEntry, displayName: string | undefined): void;

	/** The user's own name for the host at `address`, when it has one. */
	displayNameFor(address: string): string | undefined;
}
