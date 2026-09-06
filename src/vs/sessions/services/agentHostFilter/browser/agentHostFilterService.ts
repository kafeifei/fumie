/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { isWeb } from '../../../../base/common/platform.js';
import { IRemoteAgentHostService, RemoteAgentHostConnectionStatus } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { isAgentHostProvider, IAgentHostSessionsProvider } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../sessions/browser/sessionsProvidersService.js';
import { AgentHostFilterConnectionStatus, AgentHostFilterScope, agentHostFilterScopeEquals, IAgentHostFilterEntry, IAgentHostFilterService } from '../common/agentHostFilter.js';

/**
 * Legacy single-host selection key, predating {@link SCOPE_STORAGE_KEY}. Read
 * for migration and mirrored on `host`-scope writes so a rollback to a build
 * that only knows this key still restores the last scoped host.
 */
const STORAGE_KEY = 'sessions.agentHostFilter.selectedProviderId';
const SCOPE_STORAGE_KEY = 'sessions.agentHostFilter.scope';

function mapStatus(s: RemoteAgentHostConnectionStatus): AgentHostFilterConnectionStatus {
	switch (s.kind) {
		case 'connected': return AgentHostFilterConnectionStatus.Connected;
		case 'connecting': return AgentHostFilterConnectionStatus.Connecting;
		case 'disconnected':
		case 'incompatible':
		default: return AgentHostFilterConnectionStatus.Disconnected;
	}
}

/**
 * Returns `true` if the given provider is a remote agent host provider that
 * exposes a connection status and a remote address — i.e. the providers that
 * the host filter combo is responsible for surfacing.
 */
function isRemoteAgentHostProvider(provider: unknown): provider is IAgentHostSessionsProvider & { readonly remoteAddress: string } {
	if (!provider || typeof provider !== 'object' || !('id' in provider)) {
		return false;
	}
	const p = provider as IAgentHostSessionsProvider;
	return isAgentHostProvider(p) && p.connectionStatus !== undefined && typeof p.remoteAddress === 'string';
}

export class AgentHostFilterService extends Disposable implements IAgentHostFilterService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidChangeDiscovering = this._register(new Emitter<void>());
	readonly onDidChangeDiscovering: Event<void> = this._onDidChangeDiscovering.event;

	private _scope: AgentHostFilterScope;
	private _hosts: readonly IAgentHostFilterEntry[] = [];

	/**
	 * Whether the currently scoped host has been observed in {@link _hosts}
	 * at some point. Guards the desktop fallback-to-`all`: a persisted host
	 * scope must survive the startup window where remote providers have not
	 * registered yet, but must reset once a host it *did* see goes away.
	 */
	private _scopedHostSeen = false;

	/**
	 * Whether {@link _scope} is a user choice (picked in a menu or restored
	 * from storage) rather than a platform default or a normalization
	 * fallback. Web tells the two apart: an explicitly picked `all` is the
	 * union of every host and stays, while the default `all` still resolves
	 * to the first known host.
	 */
	private _scopeIsExplicit = false;

	/**
	 * Discovery handlers contributed by host providers (e.g. dev tunnels).
	 * {@link rediscover} fans out to every handler and waits for them to
	 * settle.
	 */
	private readonly _discoveryHandlers = new Set<() => Promise<void>>();
	/**
	 * Number of in-flight {@link rediscover} calls. {@link isDiscovering}
	 * is `true` while this is non-zero. Tracked as a counter so concurrent
	 * calls don't race a flag back to `false`.
	 */
	private _discoveringCount = 0;

	/**
	 * Subscriptions to the `connectionStatus` observable of every currently
	 * registered remote provider. Rebuilt whenever the set of providers
	 * changes so we always observe the live set.
	 */
	private readonly _providerWatchers = this._register(new DisposableStore());

	constructor(
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();

		this._scope = this._loadScope();

		this._rewatchProviders();
		this._register(this._sessionsProvidersService.onDidChangeProviders(() => this._rewatchProviders()));
	}

	get scope(): AgentHostFilterScope {
		return this._scope;
	}

	get selectedProviderId(): string | undefined {
		return this._scope.kind === 'host' ? this._scope.providerId : undefined;
	}

	get hosts(): readonly IAgentHostFilterEntry[] {
		return this._hosts;
	}

	get isDiscovering(): boolean {
		return this._discoveringCount > 0;
	}

	async rediscover(): Promise<void> {
		if (this._discoveryHandlers.size === 0) {
			return;
		}
		this._discoveringCount++;
		if (this._discoveringCount === 1) {
			this._onDidChangeDiscovering.fire();
		}
		try {
			await Promise.allSettled(
				[...this._discoveryHandlers].map(h => h().catch(() => { /* swallowed */ }))
			);
		} finally {
			this._discoveringCount--;
			if (this._discoveringCount === 0) {
				this._onDidChangeDiscovering.fire();
			}
		}
	}

	registerDiscoveryHandler(handler: () => Promise<void>): IDisposable {
		this._discoveryHandlers.add(handler);
		return toDisposable(() => this._discoveryHandlers.delete(handler));
	}

	setScope(scope: AgentHostFilterScope): void {
		if (scope.kind === 'host' && !this._hosts.some(h => h.providerId === scope.providerId)) {
			return;
		}
		if (agentHostFilterScopeEquals(scope, this._scope)) {
			return;
		}
		this._scope = scope;
		this._scopedHostSeen = scope.kind === 'host';
		this._scopeIsExplicit = true;
		this._persist();
		this._onDidChange.fire();
	}

	setSelectedProviderId(providerId: string): void {
		this.setScope({ kind: 'host', providerId });
	}

	reconnect(providerId: string): void {
		const provider = this._sessionsProvidersService.getProvider(providerId);
		if (provider && isAgentHostProvider(provider) && provider.connect) {
			provider.connect().catch(() => { /* errors are surfaced by the provider */ });
			return;
		}
		const host = this._hosts.find(h => h.providerId === providerId);
		if (!host) {
			return;
		}
		this._remoteAgentHostService.reconnect(host.address);
	}

	disconnect(providerId: string): void {
		const provider = this._sessionsProvidersService.getProvider(providerId);
		if (provider && isAgentHostProvider(provider) && provider.disconnect) {
			provider.disconnect().catch(() => { /* errors are surfaced by the provider */ });
		}
	}

	forget(providerId: string): void {
		const provider = this._sessionsProvidersService.getProvider(providerId);
		if (provider && isAgentHostProvider(provider) && provider.forget) {
			provider.forget().catch(() => { /* errors are surfaced by the provider */ });
			return;
		}
		const host = this._hosts.find(h => h.providerId === providerId);
		if (!host) {
			return;
		}
		this._remoteAgentHostService.removeRemoteAgentHost(host.address)
			.catch(() => { /* errors are surfaced by the host service */ });
	}

	/**
	 * Reads the persisted scope, marking it as an explicit choice (see
	 * {@link _scopeIsExplicit}) when one was stored.
	 */
	private _loadScope(): AgentHostFilterScope {
		const raw = this._storageService.get(SCOPE_STORAGE_KEY, StorageScope.PROFILE);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as { readonly kind?: unknown; readonly providerId?: unknown } | null;
				if (parsed && typeof parsed === 'object') {
					if (parsed.kind === 'all' || parsed.kind === 'local') {
						this._scopeIsExplicit = true;
						return { kind: parsed.kind };
					}
					if (parsed.kind === 'host' && typeof parsed.providerId === 'string') {
						this._scopeIsExplicit = true;
						return { kind: 'host', providerId: parsed.providerId };
					}
				}
			} catch {
				// Unreadable value — fall through to the legacy key / default.
			}
		}
		const legacy = this._storageService.get(STORAGE_KEY, StorageScope.PROFILE);
		if (legacy) {
			this._scopeIsExplicit = true;
			return { kind: 'host', providerId: legacy };
		}
		return { kind: 'all' };
	}

	/**
	 * Normalize the scope against the current host list.
	 *
	 * Web has no local agent host, so `local` is normalized away and the
	 * implicit scope is a concrete host: the default and the fallback for a
	 * host that disappeared are both the first known host. An `all` scope the
	 * user actually picked is kept — there it means the union of every remote
	 * host — while the `all` a fresh profile starts from is not (it also
	 * stands in for the old "no hosts known" `undefined`).
	 *
	 * Desktop keeps `all`/`local` as-is and only resets a `host` scope to
	 * `all` when a host this service had seen disappears (forget/remove).
	 * A host scope whose provider is merely absent right now is left alone:
	 * at startup providers register in no guaranteed order, so "the host
	 * list is non-empty without it" is not evidence the host is gone.
	 */
	private _validateScope(scope: AgentHostFilterScope): AgentHostFilterScope {
		if (isWeb) {
			if (scope.kind === 'host' && this._hosts.some(h => h.providerId === scope.providerId)) {
				return scope;
			}
			if (scope.kind === 'all' && this._scopeIsExplicit) {
				return scope;
			}
			if (this._hosts.length > 0) {
				return { kind: 'host', providerId: this._hosts[0].providerId };
			}
			// Nothing to scope to yet. The resulting `all` is a placeholder,
			// not a pick, so a host registering later still wins.
			this._scopeIsExplicit = false;
			return { kind: 'all' };
		}
		if (scope.kind !== 'host') {
			return scope;
		}
		if (this._hosts.some(h => h.providerId === scope.providerId)) {
			this._scopedHostSeen = true;
			return scope;
		}
		if (this._scopedHostSeen) {
			this._scopedHostSeen = false;
			return { kind: 'all' };
		}
		return scope;
	}

	/**
	 * Subscribe to the current set of remote providers so that host list
	 * updates (registration/unregistration and status changes) are surfaced
	 * via {@link onDidChange}. One `autorun` reads every provider's
	 * `connectionStatus` observable and recomputes the host list.
	 */
	private _rewatchProviders(): void {
		this._providerWatchers.clear();

		const providers = this._sessionsProvidersService.getProviders().filter(isRemoteAgentHostProvider);

		this._providerWatchers.add(autorun(reader => {
			const hosts: IAgentHostFilterEntry[] = providers.map(provider => ({
				providerId: provider.id,
				label: provider.label,
				address: provider.remoteAddress,
				status: mapStatus(provider.connectionStatus!.read(reader)),
				hasLiveConnection: provider.hasLiveConnection?.read(reader) ?? false,
			})).sort((a, b) => a.label.localeCompare(b.label));

			this._applyHosts(hosts);
		}));
	}

	private _applyHosts(hosts: readonly IAgentHostFilterEntry[]): void {
		const changed = hosts.length !== this._hosts.length
			|| hosts.some((h, i) => h.providerId !== this._hosts[i].providerId
				|| h.label !== this._hosts[i].label
				|| h.address !== this._hosts[i].address
				|| h.status !== this._hosts[i].status
				|| h.hasLiveConnection !== this._hosts[i].hasLiveConnection);

		this._hosts = hosts;

		const validated = this._validateScope(this._scope);
		const scopeChanged = !agentHostFilterScopeEquals(validated, this._scope);
		if (scopeChanged) {
			this._scope = validated;
			if (this._scopeIsExplicit) {
				// A normalization of the platform default is not worth
				// recording: persisting it would make the next launch read it
				// back as a choice the user never made.
				this._persist();
			}
		}

		if (changed || scopeChanged) {
			this._onDidChange.fire();
		}
	}

	private _persist(): void {
		this._storageService.store(SCOPE_STORAGE_KEY, JSON.stringify(this._scope), StorageScope.PROFILE, StorageTarget.USER);
		if (this._scope.kind === 'host') {
			// Rollback mirror — see the comment on STORAGE_KEY.
			this._storageService.store(STORAGE_KEY, this._scope.providerId, StorageScope.PROFILE, StorageTarget.USER);
		}
	}
}

registerSingleton(IAgentHostFilterService, AgentHostFilterService, InstantiationType.Delayed);
