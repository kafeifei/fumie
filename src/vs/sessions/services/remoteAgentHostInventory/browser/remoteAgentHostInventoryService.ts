/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { agentHostAuthority } from '../../../../platform/agentHost/common/agentHostUri.js';
import { IRemoteAgentHostLocationPreferenceService } from '../../../../platform/agentHost/common/remoteAgentHostLocationPreference.js';
import {
	IRemoteAgentHostService,
	RemoteAgentHostConnectionStatus,
	RemoteAgentHostEntryType,
	getEntryAddress,
} from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ITunnelAgentHostService, TUNNEL_ADDRESS_PREFIX } from '../../../../platform/agentHost/common/tunnelAgentHost.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isAgentHostProvider } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../sessions/browser/sessionsProvidersService.js';
import {
	cachedSessionCount,
	clearCachedSessions,
	DISPLAY_NAMES_STORAGE_KEY,
	displayNameKey,
	IRemoteAgentHostInventoryEntry,
	IRemoteAgentHostInventoryService,
	LAST_CONNECTED_STORAGE_KEY,
	listCachedSessionAuthorities,
	RemoteAgentHostInventoryState,
} from '../common/remoteAgentHostInventory.js';

/** A stored `address` → value map, as both extra stores here are shaped. */
type StoredMap<T> = Record<string, T>;

export class RemoteAgentHostInventoryService extends Disposable implements IRemoteAgentHostInventoryService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/**
	 * Addresses last seen connected. Only an address that is not in here is
	 * stamped, so a host that stays connected keeps the time it arrived rather
	 * than being pushed forward by every unrelated connection event.
	 */
	private _connectedAddresses = new Set<string>();

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@ITunnelAgentHostService private readonly _tunnelService: ITunnelAgentHostService,
		@IRemoteAgentHostLocationPreferenceService private readonly _locationPreferenceService: IRemoteAgentHostLocationPreferenceService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
	) {
		super();

		this._register(this._remoteAgentHostService.onDidChangeConnections(() => {
			this._stampConnected();
			this._onDidChange.fire();
		}));
		this._register(this._tunnelService.onDidChangeTunnels(() => this._onDidChange.fire()));
		this._register(this._sessionsProvidersService.onDidChangeProviders(() => {
			this._stampConnected();
			this._onDidChange.fire();
		}));

		// A host can already be connected when this service is first asked for,
		// and "last connected" that only starts counting from then would read
		// "never" for the host the user is looking at right now.
		this._stampConnected();
	}

	list(): IRemoteAgentHostInventoryEntry[] {
		const byAuthority = new Map<string, IRemoteAgentHostInventoryEntry>();
		const displayNames = this._readMap<string>(DISPLAY_NAMES_STORAGE_KEY);
		const lastConnected = this._readMap<number>(LAST_CONNECTED_STORAGE_KEY);

		const put = (entry: Omit<IRemoteAgentHostInventoryEntry, 'lastConnectedAt'>) => {
			// First writer wins: the passes below run most-informative first, so
			// a tunnel already described by its cached entry is not overwritten
			// by the bare authority its session cache would give it.
			if (byAuthority.has(entry.authority)) {
				return;
			}
			const key = displayNameKey(entry);
			const chosen = displayNames[key];
			byAuthority.set(entry.authority, {
				...entry,
				label: chosen || entry.label,
				lastConnectedAt: typeof lastConnected[key] === 'number' ? lastConnected[key] : undefined,
			});
		};

		for (const entry of this._remoteAgentHostService.configuredEntries) {
			const address = getEntryAddress(entry);
			put({
				authority: agentHostAuthority(address),
				address,
				label: entry.name || address,
				kind: entry.connection.type,
				state: this._stateFor(address),
				cachedSessionCount: cachedSessionCount(this._storageService, agentHostAuthority(address)),
			});
		}

		for (const tunnel of this._tunnelService.getCachedTunnels()) {
			// Suppressed means the user removed it. The entry survives in the
			// tunnel cache so it can be re-added deliberately, but it is gone
			// as far as every surface — including this one — is concerned.
			if (this._tunnelService.isAutoConnectSuppressed(tunnel.tunnelId)) {
				continue;
			}
			const address = `${TUNNEL_ADDRESS_PREFIX}${tunnel.tunnelId}`;
			put({
				authority: agentHostAuthority(address),
				address,
				label: tunnel.name || tunnel.tunnelId,
				kind: RemoteAgentHostEntryType.Tunnel,
				state: this._stateFor(address),
				cachedSessionCount: cachedSessionCount(this._storageService, agentHostAuthority(address)),
			});
		}

		// Anything left holding a session cache has no store to come back from.
		for (const authority of listCachedSessionAuthorities(this._storageService)) {
			put({
				authority,
				address: undefined,
				label: authority,
				kind: 'unknown',
				state: RemoteAgentHostInventoryState.Orphaned,
				cachedSessionCount: cachedSessionCount(this._storageService, authority),
			});
		}

		return [...byAuthority.values()].sort((a, b) => a.label.localeCompare(b.label));
	}

	async forget(entry: IRemoteAgentHostInventoryEntry): Promise<void> {
		const address = entry.address;

		if (address) {
			// Removal goes through the provider's own disconnect, the same path
			// the built-in host picker uses. For a tunnel that suppresses
			// auto-connect, which is what actually keeps it away: dropping it
			// from the tunnel cache alone does not, because discovery re-caches
			// every tunnel the account still owns on its next pass.
			const provider = this._sessionsProvidersService.getProviders()
				.find(p => isAgentHostProvider(p) && p.remoteAddress === address);
			try {
				if (provider && isAgentHostProvider(provider) && provider.disconnect) {
					await provider.disconnect();
				} else {
					await this._remoteAgentHostService.removeRemoteAgentHost(address);
				}
			} catch {
				// Best effort: a host worth forgetting is usually one that
				// cannot answer, and a failed teardown must not leave the
				// remaining stores behind.
			}

			this._locationPreferenceService.clearPreference(address);
		}

		clearCachedSessions(this._storageService, entry.authority);
		this._locationPreferenceService.clearPreference(entry.authority);
		// The name and the connection stamp are keyed by the host, not by the
		// store it came from, so nothing else ever drops them: a host that came
		// back later would come back wearing a name the user gave the machine
		// they just removed.
		this._dropStored(displayNameKey(entry));

		this._onDidChange.fire();
	}

	rename(entry: IRemoteAgentHostInventoryEntry, displayName: string | undefined): void {
		const key = displayNameKey(entry);
		const chosen = displayName?.trim();
		const names = this._readMap<string>(DISPLAY_NAMES_STORAGE_KEY);
		if (chosen ? names[key] === chosen : names[key] === undefined) {
			return;
		}
		if (chosen) {
			names[key] = chosen;
		} else {
			delete names[key];
		}
		this._writeMap(DISPLAY_NAMES_STORAGE_KEY, names, StorageTarget.USER);
		this._onDidChange.fire();
	}

	displayNameFor(address: string): string | undefined {
		return this._readMap<string>(DISPLAY_NAMES_STORAGE_KEY)[address];
	}

	/**
	 * Stamp every address that has just become connected.
	 *
	 * An address already in {@link _connectedAddresses} is left alone, so a
	 * host that simply stays connected keeps the time it arrived instead of
	 * being pushed forward by every unrelated connection event.
	 */
	private _stampConnected(): void {
		const connected = new Set<string>();
		for (const connection of this._remoteAgentHostService.connections) {
			if (RemoteAgentHostConnectionStatus.isConnected(connection.status)) {
				connected.add(connection.address);
			}
		}
		for (const provider of this._sessionsProvidersService.getProviders()) {
			if (!isAgentHostProvider(provider) || !provider.remoteAddress) {
				continue;
			}
			const status = provider.connectionStatus?.get();
			if (status && RemoteAgentHostConnectionStatus.isConnected(status)) {
				connected.add(provider.remoteAddress);
			}
		}

		const arrived = [...connected].filter(address => !this._connectedAddresses.has(address));
		this._connectedAddresses = connected;
		if (arrived.length === 0) {
			return;
		}

		const stamps = this._readMap<number>(LAST_CONNECTED_STORAGE_KEY);
		const now = Date.now();
		for (const address of arrived) {
			stamps[address] = now;
		}
		// MACHINE, not USER: when this machine last reached a host says nothing
		// about when another machine did.
		this._writeMap(LAST_CONNECTED_STORAGE_KEY, stamps, StorageTarget.MACHINE);
	}

	private _dropStored(key: string): void {
		const names = this._readMap<string>(DISPLAY_NAMES_STORAGE_KEY);
		if (names[key] !== undefined) {
			delete names[key];
			this._writeMap(DISPLAY_NAMES_STORAGE_KEY, names, StorageTarget.USER);
		}
		const stamps = this._readMap<number>(LAST_CONNECTED_STORAGE_KEY);
		if (stamps[key] !== undefined) {
			delete stamps[key];
			this._writeMap(LAST_CONNECTED_STORAGE_KEY, stamps, StorageTarget.MACHINE);
		}
		this._connectedAddresses.delete(key);
	}

	private _readMap<T>(key: string): StoredMap<T> {
		const raw = this._storageService.get(key, StorageScope.PROFILE);
		if (!raw) {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed as StoredMap<T> } : {};
		} catch {
			return {};
		}
	}

	private _writeMap<T>(key: string, map: StoredMap<T>, target: StorageTarget): void {
		if (Object.keys(map).length === 0) {
			this._storageService.remove(key, StorageScope.PROFILE);
			return;
		}
		this._storageService.store(key, JSON.stringify(map), StorageScope.PROFILE, target);
	}

	private _stateFor(address: string): RemoteAgentHostInventoryState {
		const connection = this._remoteAgentHostService.connections.find(c => c.address === address);
		if (connection && RemoteAgentHostConnectionStatus.isConnected(connection.status)) {
			return RemoteAgentHostInventoryState.Connected;
		}
		if (connection && RemoteAgentHostConnectionStatus.isConnecting(connection.status)) {
			return RemoteAgentHostInventoryState.Connecting;
		}
		const provider = this._sessionsProvidersService.getProviders()
			.find(p => isAgentHostProvider(p) && p.remoteAddress === address);
		if (provider && isAgentHostProvider(provider) && provider.connectionStatus) {
			const status = provider.connectionStatus.get();
			if (RemoteAgentHostConnectionStatus.isConnecting(status)) {
				return RemoteAgentHostInventoryState.Connecting;
			}
		}
		return RemoteAgentHostInventoryState.Disconnected;
	}

}

registerSingleton(IRemoteAgentHostInventoryService, RemoteAgentHostInventoryService, InstantiationType.Delayed);
