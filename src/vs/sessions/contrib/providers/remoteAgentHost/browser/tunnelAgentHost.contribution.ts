/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import * as nls from '../../../../../nls.js';
import { IRemoteAgentHostService, RemoteAgentHostAutoConnectSettingId, RemoteAgentHostConnectionStatus, RemoteAgentHostsEnabledSettingId } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { isTunnelHosted, ITunnelAgentHostService, TUNNEL_ADDRESS_PREFIX, type ITunnelInfo } from '../../../../../platform/agentHost/common/tunnelAgentHost.js';
import { PROTOCOL_VERSION } from '../../../../../platform/agentHost/common/state/protocol/version/registry.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { ITunnelHostService } from '../../../../../workbench/contrib/chat/common/tunnelHost.js';
import { AuthenticationSessionsChangeEvent, IAuthenticationService } from '../../../../../workbench/services/authentication/common/authentication.js';
import { logTunnelConnectAttempt, logTunnelConnectResolved, logTunnelDiscoveryResult, TunnelConnectErrorCategory, TunnelConnectFailureReason, TunnelDiscoveryTrigger } from '../../../../common/sessionsTelemetry.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { IAgentHostFilterService } from '../../../../services/agentHostFilter/common/agentHostFilter.js';
import { RemoteAgentHostSessionsProvider } from './remoteAgentHostSessionsProvider.js';
import { watchForIncompatibleNotifications } from './remoteHostOptions.js';

/** Minimum interval between silent status checks (5 minutes). */
const STATUS_CHECK_INTERVAL = 5 * 60 * 1000;

/**
 * How long a single connect attempt may run before it is called a failure.
 *
 * Without this a connect can hang indefinitely and the host's sessions stay
 * stuck showing a spinner, which is indistinguishable from a host that is
 * simply slow. A bounded attempt lets the sessions list offer retry/forget.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * How long tunnel discovery may run before it counts as "we cannot tell".
 *
 * The whole status machine hangs off this call: until it returns, every
 * provider is held in its startup `connecting` state, so an enumeration that
 * never resolves — an expired token waiting on a prompt nobody answers, a
 * network that swallows the request — leaves the sessions list spinning for
 * the life of the window with no way for the user to act on it.
 */
const DISCOVERY_TIMEOUT_MS = 15_000;

export class TunnelAgentHostContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.tunnelAgentHostContribution';

	private readonly _providerStores = this._register(new DisposableMap<string /* address */, DisposableStore>());
	private readonly _providerInstances = new Map<string, RemoteAgentHostSessionsProvider>();
	private readonly _pendingConnects = new Map<string, Promise<void>>();
	private _lastStatusCheck = 0;
	/**
	 * `false` until the first {@link _silentStatusCheck} resolves. Until then
	 * we keep newly-created providers in the `Connecting` state so the picker
	 * doesn't briefly show every cached tunnel as "Offline" on startup.
	 */
	private _initialStatusChecked = false;

	/** Previous connection status per address — used to detect Connected→Disconnected transitions. */
	private readonly _previousStatuses = new Map<string, RemoteAgentHostConnectionStatus>();
	/**
	 * Why a tunnel is parked after a failed connect. A parked tunnel is never
	 * retried on its own — the sessions list surfaces retry and forget
	 * controls instead, so a failure the user can see is a failure that stays
	 * put until they act on it.
	 */
	private readonly _reconnectPauseReasons = new Map<string, TunnelConnectFailureReason>();
	/**
	 * Addresses whose provider currently holds a live connection. Tracked
	 * separately from {@link _previousStatuses} so a drop is still detected when
	 * the connection passes through an intermediate `connecting` state on its
	 * way down.
	 */
	private readonly _wiredAddresses = new Set<string>();
	/**
	 * Per-address connect sessions for telemetry. A session starts at the
	 * first attempt of a connect cycle (initial or reconnect) and ends on
	 * terminal resolution (connected, host-offline, max-attempts).
	 */
	private readonly _connectSessions = new Map<string, { startedAt: number; attempts: number; isReconnect: boolean }>();

	constructor(
		@ITunnelAgentHostService private readonly _tunnelService: ITunnelAgentHostService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ITunnelHostService private readonly _tunnelHostService: ITunnelHostService,
		@IAgentHostFilterService agentHostFilterService: IAgentHostFilterService,
	) {
		super();

		// Create providers for cached tunnels
		this._reconcileProviders();

		// Plug our silent status check into the shared host picker UX so
		// the user-triggered "Re-discover hosts" action runs the same
		// discovery routine.
		this._register(agentHostFilterService.registerDiscoveryHandler(() => this._silentStatusCheck()));

		// Update connection statuses when connections change
		this._register(this._remoteAgentHostService.onDidChangeConnections(() => {
			this._handleConnectionChanges();
			this._updateConnectionStatuses();
			this._wireConnections();
		}));

		// Reconcile providers when the tunnel cache changes
		this._register(this._tunnelService.onDidChangeTunnels(() => {
			this._reconcileProviders();
			// Stop any reconnect loops for tunnels that no longer exist
			this._pruneReconnectState();
		}));

		this._register(this._tunnelHostService.onDidChangeStatus(() => {
			this._resetHostedTunnelReconnectState();
			this._silentStatusCheck();
		}));

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(RemoteAgentHostsEnabledSettingId)) {
				this._reconcileProviders();
				this._pruneReconnectState();
			}
		}));

		// Re-run discovery when a GitHub session becomes available,
		// and tear down tunnel state bound to that provider if its session
		// is removed.
		this._register(this._authenticationService.onDidChangeSessions(e => {
			if (e.providerId !== 'github') {
				return;
			}
			this._handleSessionsChange(e);
		}));

		// Silently check status of cached tunnels on startup. Routed
		// through the filter service's `rediscover` so the host pill
		// pulses while the initial automatic discovery is in flight,
		// then switches to a static label once we know what hosts exist.
		agentHostFilterService.rediscover();
	}

	/**
	 * Called by the workspace picker when it opens. Silently re-checks
	 * tunnel statuses if more than 5 minutes have elapsed since the last check.
	 */
	async checkTunnelStatuses(): Promise<void> {
		if (Date.now() - this._lastStatusCheck < STATUS_CHECK_INTERVAL) {
			return;
		}
		await this._silentStatusCheck();
	}

	// -- Provider management --

	private _reconcileProviders(): void {
		const enabled = this._configurationService.getValue<boolean>(RemoteAgentHostsEnabledSettingId);
		const cached = enabled ? this._getProviderTunnels() : [];
		const desiredAddresses = new Set(cached.map(t => `${TUNNEL_ADDRESS_PREFIX}${t.tunnelId}`));

		// Remove providers no longer cached
		for (const [address] of this._providerStores) {
			if (!desiredAddresses.has(address)) {
				this._providerStores.deleteAndDispose(address);
				this._providerInstances.delete(address);
			}
		}

		// Add providers for cached tunnels
		for (const tunnel of cached) {
			const address = `${TUNNEL_ADDRESS_PREFIX}${tunnel.tunnelId}`;
			if (!this._providerStores.has(address)) {
				this._createProvider(address, tunnel.name);
			}
		}
	}

	private _getProviderTunnels() {
		return this._tunnelService.getCachedTunnels().filter(tunnel => !this._tunnelService.isAutoConnectSuppressed(tunnel.tunnelId));
	}

	private _isHostedTunnel(tunnel: Pick<ITunnelInfo, 'tunnelId' | 'name'>): boolean {
		return isTunnelHosted(this._tunnelHostService.sharingInfo, tunnel);
	}

	private _resetHostedTunnelReconnectState(): void {
		for (const tunnel of this._tunnelService.getCachedTunnels()) {
			if (this._isHostedTunnel(tunnel)) {
				const address = `${TUNNEL_ADDRESS_PREFIX}${tunnel.tunnelId}`;
				this._resetReconnectState(address);
				if (this._remoteAgentHostService.connections.some(connection => connection.address === address && RemoteAgentHostConnectionStatus.isConnected(connection.status))) {
					this._tunnelService.disconnect(address).catch(() => { /* best effort */ });
				}
			}
		}
	}

	private _createProvider(address: string, name: string): void {
		const store = new DisposableStore();
		const provider = this._instantiateProvider(address, name);
		// Surface as "Connecting" until the first silent status check or an
		// auto-connect attempt determines the real state; otherwise the picker
		// flashes "Offline" for every cached tunnel on startup.
		provider.setConnectionStatus(RemoteAgentHostConnectionStatus.connecting);
		store.add(provider);
		store.add(this._sessionsProvidersService.registerProvider(provider));
		store.add(watchForIncompatibleNotifications(provider, this._instantiationService, this._notificationService));
		this._providerInstances.set(address, provider);
		store.add(toDisposable(() => {
			this._providerInstances.delete(address);
			this._wiredAddresses.delete(address);
		}));
		this._providerStores.set(address, store);
	}

	protected _instantiateProvider(address: string, name: string): RemoteAgentHostSessionsProvider {
		return this._instantiationService.createInstance(
			RemoteAgentHostSessionsProvider, {
			address,
			name,
			connectOnDemand: () => this._connectTunnel(address, { userInitiated: true }),
			disconnectOnDemand: () => this._disconnectTunnel(address),
			forgetOnDemand: () => this._forgetTunnel(address),
		},
		);
	}

	// -- Connection status --

	private _updateConnectionStatuses(): void {
		for (const [address, provider] of this._providerInstances) {
			const connectionInfo = this._remoteAgentHostService.connections.find(c => c.address === address);
			if (connectionInfo) {
				// Service has an entry — its status is authoritative
				// (including incompatible from the WebSocket connect
				// failure path, and connecting/connected from a fresh
				// reconnect after an upgrade).
				provider.setConnectionStatus(connectionInfo.status);
				continue;
			}
			// Preserve incompatible state set by `_connectTunnel`'s catch
			// (where the failure happens before the service ever has an
			// entry) until the user retries — otherwise the `finally`
			// block would immediately overwrite it back to `disconnected`.
			if (RemoteAgentHostConnectionStatus.isIncompatible(provider.connectionStatus.get())) {
				continue;
			}
			if (this._pendingConnects.has(address)) {
				provider.setConnectionStatus(RemoteAgentHostConnectionStatus.connecting);
			} else if (!this._initialStatusChecked) {
				// Keep the initial "Connecting" state so the picker doesn't
				// flash "Offline" before the first silent status check runs.
				provider.setConnectionStatus(RemoteAgentHostConnectionStatus.connecting);
			} else {
				provider.setConnectionStatus(RemoteAgentHostConnectionStatus.disconnected);
			}
		}
	}

	/**
	 * Wire live connections to their providers so session operations work, and
	 * drop a provider's connection once its transport is gone.
	 */
	private _wireConnections(): void {
		for (const [address, provider] of this._providerInstances) {
			const connectionInfo = this._remoteAgentHostService.connections.find(c => c.address === address);
			if (connectionInfo && RemoteAgentHostConnectionStatus.isConnected(connectionInfo.status)) {
				const connection = this._remoteAgentHostService.getConnection(address);
				if (connection) {
					provider.setConnection(connection, connectionInfo.defaultDirectory);
					this._wiredAddresses.add(address);
				}
			} else if (this._wiredAddresses.has(address) && !RemoteAgentHostConnectionStatus.isConnecting(connectionInfo?.status)) {
				// Keep the provider live while a replacement transport is connecting.
				this._wiredAddresses.delete(address);
				provider.clearConnection();
			}
		}
	}

	// -- On-demand connection --

	/**
	 * Establish a relay connection to a cached tunnel. Called on demand
	 * when the user invokes the browse action on an online-but-not-connected tunnel.
	 */
	private _connectTunnel(address: string, options: { readonly userInitiated: boolean }): Promise<void> {
		const existing = this._pendingConnects.get(address);
		if (existing) {
			return existing;
		}

		const tunnelId = address.slice(TUNNEL_ADDRESS_PREFIX.length);
		const cached = this._tunnelService.getCachedTunnels().find(t => t.tunnelId === tunnelId);
		if (!cached) {
			return Promise.resolve();
		}
		if (this._isHostedTunnel(cached)) {
			this._resetReconnectState(address);
			return Promise.resolve();
		}
		if (!options.userInitiated && this._tunnelService.isAutoConnectSuppressed(tunnelId)) {
			this._logService.info(`[TunnelAgentHost] Skipping background connect for user-disconnected tunnel ${address}`);
			return Promise.resolve();
		}
		if (options.userInitiated) {
			this._tunnelService.clearAutoConnectSuppression(tunnelId);
			// Clear any sticky `incompatible` state so this attempt can
			// transition through `connecting` and report a fresh result.
			const provider = this._providerInstances.get(address);
			if (provider && RemoteAgentHostConnectionStatus.isIncompatible(provider.connectionStatus.get())) {
				provider.setConnectionStatus(RemoteAgentHostConnectionStatus.connecting);
			}
		}

		const { attemptNumber, attemptStart, session, isReconnect } = this._beginConnectAttempt(address);

		const promise = (async () => {
			// Show a progress notification after a short delay so quick
			// connects don't flash a notification. Only show for user-initiated
			// connects; background auto-connects and reconnects stay silent.
			let handle: { close(): void } | undefined;
			const timer = options.userInitiated ? setTimeout(() => {
				handle = this._notificationService.notify({
					severity: Severity.Info,
					message: nls.localize('tunnelConnecting', "Connecting to tunnel '{0}'...", cached.name),
					progress: { infinite: true },
				});
			}, 1000) : undefined;

			this._updateConnectionStatuses();
			try {
				const tunnelInfo: ITunnelInfo = {
					tunnelId: cached.tunnelId,
					clusterId: cached.clusterId,
					name: cached.name,
					tags: [],
					protocolVersion: 5,
					hostConnectionCount: 0,
				};
				let timedOut = false;
				await raceTimeout(
					this._tunnelService.connect(tunnelInfo, cached.authProvider, { userInitiated: options.userInitiated }),
					CONNECT_TIMEOUT_MS,
					() => { timedOut = true; },
				);
				if (timedOut) {
					throw new Error(nls.localize('tunnelConnectTimedOut', "Timed out connecting to tunnel '{0}'.", cached.name));
				}
				if (this._isHostedTunnel(cached)) {
					await this._tunnelService.disconnect(address);
					this._resetReconnectState(address);
					return;
				}
				// Re-check after the await: the user may have disconnected this
				// tunnel while this background connect was already in flight.
				if (!options.userInitiated && this._tunnelService.isAutoConnectSuppressed(cached.tunnelId)) {
					this._logService.info(`[TunnelAgentHost] Disconnecting background connection for user-disconnected tunnel ${address}`);
					await this._tunnelService.disconnect(address);
					this._connectSessions.delete(address);
					return;
				}
				this._finishConnectAttempt(address, { success: true, attemptNumber, attemptStart, session, isReconnect });
			} catch (err) {
				this._logService.warn(`[TunnelAgentHost] Connect to ${cached.name} failed:`, err);
				const errorCategory = this._categorizeError(err);
				this._finishConnectAttempt(address, { success: false, attemptNumber, attemptStart, session, isReconnect, error: err });
				// Clear the pending-connect entry BEFORE deciding what to do
				// next so the parked state below reflects this attempt rather
				// than racing the in-flight guard.
				this._pendingConnects.delete(address);

				// Protocol version mismatch is a deterministic failure that
				// cannot be fixed by retrying. Surface it on the provider so
				// the workspace picker can show the host's message, and stop
				// scheduling reconnects until the user manually retries via
				// the picker's Manage menu.
				const incompatible = RemoteAgentHostConnectionStatus.fromConnectError(err, [PROTOCOL_VERSION]);
				if (incompatible) {
					this._providerInstances.get(address)?.setConnectionStatus(incompatible);
					this._resetReconnectState(address);
					throw err;
				}

				// Auth failures are not worth retrying — a fresh token must
				// be acquired by the user or by a session-change event. Pause
				// immediately and let `_handleSessionsChange` resume us when
				// a new session appears.
				if (errorCategory === 'authExpired' || errorCategory === 'auth') {
					this._pauseReconnect(address, errorCategory);
					throw err;
				}

				const hostOnline = await this._probeHostOnline(cached.tunnelId);
				this._pauseReconnect(address, hostOnline === false ? 'hostOffline' : 'connectFailed');
				throw err;
			} finally {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				handle?.close();
				this._pendingConnects.delete(address);
				this._updateConnectionStatuses();
			}
		})();

		// Swallow the promise rejection here so unhandled rejection noise
		// doesn't bubble up for the background reconnect path; callers that
		// await `_connectTunnel` directly will still see it via their own `await`.
		promise.catch(() => { /* the failure is parked in _pauseReconnect */ });

		this._pendingConnects.set(address, promise);
		return promise;
	}

	/**
	 * Tear down the active tunnel relay for {@link address} and cancel any
	 * pending auto-reconnect. The cached tunnel entry is kept so the user
	 * can re-connect later; only the live WebSocket is closed.
	 */
	private async _disconnectTunnel(address: string): Promise<void> {
		this._resetReconnectState(address);
		this._tunnelService.suppressAutoConnect(address.slice(TUNNEL_ADDRESS_PREFIX.length));
		// Mark as explicitly disconnected so `_handleConnectionChanges` does
		// not treat the impending Connected→(removed) transition as a
		// reconnect-worthy drop.
		this._previousStatuses.delete(address);
		await this._tunnelService.disconnect(address);
	}

	/**
	 * Forget {@link address} for good: close the transport and drop the tunnel
	 * from the recent list, so no provider is recreated for it on the next
	 * launch. The provider clears its own persisted session cache before
	 * calling this.
	 */
	private async _forgetTunnel(address: string): Promise<void> {
		this._resetReconnectState(address);
		this._previousStatuses.delete(address);
		await this._tunnelService.disconnect(address).catch(() => { /* transport may already be dead */ });
		this._tunnelService.removeCachedTunnel(address.slice(TUNNEL_ADDRESS_PREFIX.length));
	}

	/**
	 * Detect tunnel connections that transitioned from Connected to
	 * Disconnected and park them.
	 *
	 * Important: we only trigger on a Connected → Disconnected transition
	 * where the connection entry is still present. If the entry has been
	 * removed from the service (e.g. the user clicked "Remove Remote"),
	 * we do NOT schedule a reconnect — that would override their intent.
	 */
	private _handleConnectionChanges(): void {
		if (!this._configurationService.getValue<boolean>(RemoteAgentHostsEnabledSettingId)) {
			return;
		}

		const cachedAddresses = new Set(this._getProviderTunnels().map(t => `${TUNNEL_ADDRESS_PREFIX}${t.tunnelId}`));
		const currentStatuses = new Map<string, RemoteAgentHostConnectionStatus>();
		for (const conn of this._remoteAgentHostService.connections) {
			currentStatuses.set(conn.address, conn.status);
		}

		for (const address of cachedAddresses) {
			const previous = this._previousStatuses.get(address);
			const current = currentStatuses.get(address);

			// Only react to an explicit Connected→Disconnected transition. If
			// the address is absent from the connection list, the user (or
			// another code path) removed it — honour that.
			const wasConnected = RemoteAgentHostConnectionStatus.isConnected(previous);
			const isExplicitlyDisconnected = RemoteAgentHostConnectionStatus.isDisconnected(current);

			if (wasConnected && isExplicitlyDisconnected && !this._pendingConnects.has(address)) {
				this._logService.info(`[TunnelAgentHost] Connection lost for ${address}; parking until the user retries.`);
				this._pauseReconnect(address, 'connectionLost');
			}

			// Only track previous status while the entry is present so a
			// future re-registration starts from a clean slate. If the
			// entry disappeared (e.g. user-initiated removal), also drop its
			// parked state so the removal is honoured.
			if (current !== undefined) {
				this._previousStatuses.set(address, current);
			} else {
				this._previousStatuses.delete(address);
				this._resetReconnectState(address);
			}
		}

		// Drop previous-status entries for addresses no longer cached.
		for (const address of [...this._previousStatuses.keys()]) {
			if (!cachedAddresses.has(address)) {
				this._previousStatuses.delete(address);
			}
		}
	}

	/**
	 * Enumerate tunnels, giving up after {@link DISCOVERY_TIMEOUT_MS}.
	 *
	 * `listTunnels` has no deadline of its own, and every caller here treats a
	 * missing answer as a reason to keep waiting rather than to report what it
	 * knows, so the bound belongs on this side of it.
	 */
	private async _listTunnelsBounded(): Promise<ITunnelInfo[]> {
		let timedOut = false;
		const tunnels = await raceTimeout(
			this._tunnelService.listTunnels({ silent: true }),
			DISCOVERY_TIMEOUT_MS,
			() => { timedOut = true; },
		);
		if (timedOut) {
			throw new Error('Timed out enumerating tunnels.');
		}
		return tunnels ?? [];
	}

	/**
	 * Best-effort probe of whether the host backing `tunnelId` is online
	 * (has any host connections). Returns `undefined` if we couldn't
	 * determine — caller should treat as "retry normally" in that case.
	 */
	private async _probeHostOnline(tunnelId: string): Promise<boolean | undefined> {
		try {
			const tunnels = await this._listTunnelsBounded();
			if (!tunnels) {
				return undefined;
			}
			const info = tunnels.find(t => t.tunnelId === tunnelId);
			if (!info) {
				return false;
			}
			return info.hostConnectionCount > 0;
		} catch {
			return undefined;
		}
	}

	/** Clear the parked-failure state for an address. */
	private _clearReconnectBackoff(address: string): void {
		this._reconnectPauseReasons.delete(address);
	}

	/** Drop all reconnect + telemetry state for an address (e.g. on removal). */
	private _resetReconnectState(address: string): void {
		this._clearReconnectBackoff(address);
		this._connectSessions.delete(address);
	}

	/**
	 * React to auth session add/remove. Additions re-run discovery (a fresh
	 * token may unblock a previously auth-paused tunnel). Removals drop any
	 * tunnel state that depended on that provider — otherwise we'd sit on a
	 * stale auth pause forever, or hammer a provider whose session is gone.
	 */
	private _handleSessionsChange(e: { providerId: string; label: string; event: AuthenticationSessionsChangeEvent }): void {
		const added = (e.event.added?.length ?? 0) > 0;
		const removed = (e.event.removed?.length ?? 0) > 0;

		if (removed) {
			const cached = this._tunnelService.getCachedTunnels();
			for (const tunnel of cached) {
				if (tunnel.authProvider !== e.providerId) {
					continue;
				}
				const address = `${TUNNEL_ADDRESS_PREFIX}${tunnel.tunnelId}`;
				this._logService.info(
					`[TunnelAgentHost] Auth session removed for ${e.providerId}; tearing down ${address}.`
				);
				this._resetReconnectState(address);
				// Best-effort disconnect — the transport may already be dead.
				this._tunnelService.disconnect(address).catch(() => { /* ignore */ });
			}
		}

		if (added) {
			this._logService.info(`[TunnelAgentHost] ${e.providerId} session added; rediscovering.`);
			// An auth-paused tunnel is unblocked by the new token, so let the
			// discovery pass reach it again. Every other parked failure stays
			// parked until the user retries it from the sessions list.
			for (const [address, reason] of [...this._reconnectPauseReasons]) {
				if (reason === 'auth' || reason === 'authExpired') {
					this._reconnectPauseReasons.delete(address);
				}
			}
			this._silentStatusCheck('sessionChange');
		}
	}

	/**
	 * Park an address after a failed connect. Nothing retries it in the
	 * background; the sessions list shows the host as disconnected and offers
	 * retry and forget, so the user decides what happens next.
	 */
	private _pauseReconnect(address: string, reason: TunnelConnectFailureReason): void {
		this._reconnectPauseReasons.set(address, reason);
		this._logService.info(
			`[TunnelAgentHost] Parking ${address} (${reason}); waiting for the user to retry.`
		);
		const session = this._connectSessions.get(address);
		if (session) {
			logTunnelConnectResolved(this._telemetryService, {
				isReconnect: session.isReconnect,
				totalAttempts: session.attempts,
				totalDurationMs: Date.now() - session.startedAt,
				success: false,
				failureReason: reason,
			});
			this._connectSessions.delete(address);
		}
	}

	/**
	 * Begin (or continue) a connect telemetry session for `address` and
	 * return the bookkeeping needed to later finish the attempt. A session
	 * already exists if `_handleConnectionChanges` marked this as a
	 * reconnect cycle; otherwise this starts a fresh initial-connect session.
	 */
	private _beginConnectAttempt(address: string): { session: { startedAt: number; attempts: number; isReconnect: boolean }; attemptNumber: number; attemptStart: number; isReconnect: boolean } {
		let session = this._connectSessions.get(address);
		if (!session) {
			session = { startedAt: Date.now(), attempts: 0, isReconnect: false };
			this._connectSessions.set(address, session);
		}
		session.attempts++;
		return { session, attemptNumber: session.attempts, attemptStart: Date.now(), isReconnect: session.isReconnect };
	}

	/**
	 * Finalize the telemetry for a single connect attempt. On success, also
	 * clears backoff state and closes the session; on failure, only the
	 * per-attempt event is emitted (the caller decides whether to retry).
	 */
	private _finishConnectAttempt(address: string, args: {
		success: boolean;
		attemptNumber: number;
		attemptStart: number;
		session: { startedAt: number; attempts: number; isReconnect: boolean };
		isReconnect: boolean;
		error?: unknown;
	}): void {
		const { success, attemptNumber, attemptStart, session, isReconnect, error } = args;
		const durationMs = Date.now() - attemptStart;
		if (success) {
			this._clearReconnectBackoff(address);
			logTunnelConnectAttempt(this._telemetryService, { isReconnect, attempt: attemptNumber, durationMs, success: true });
			logTunnelConnectResolved(this._telemetryService, { isReconnect, totalAttempts: attemptNumber, totalDurationMs: Date.now() - session.startedAt, success: true });
			this._connectSessions.delete(address);
		} else {
			logTunnelConnectAttempt(this._telemetryService, { isReconnect, attempt: attemptNumber, durationMs, success: false, errorCategory: this._categorizeError(error) });
		}
	}

	private _categorizeError(err: unknown): TunnelConnectErrorCategory {
		const message = err instanceof Error ? err.message : String(err);
		// Expired / invalid credential — callers short-circuit this category
		// to avoid burning retry budget on a token the user has to refresh.
		if (/\b(401|403)\b|token.*expired|expired.*token|invalid[_ -]?grant/i.test(message)) {
			return 'authExpired';
		}
		// Match authentication-specific language but NOT "connection token"
		// or other protocol uses of the word "token".
		if (/authenticat|unauthoriz|auth.*(fail|error|invalid)/i.test(message)) {
			return 'auth';
		}
		if (/WebSocket relay connection failed|failed to connect to relay/i.test(message)) {
			return 'relayConnectionFailed';
		}
		if (/network|fetch|offline|ECONN|ENOTFOUND|ETIMEDOUT/i.test(message)) {
			return 'network';
		}
		return 'other';
	}

	/** Drop reconnect state for addresses whose tunnel is no longer cached. */
	private _pruneReconnectState(): void {
		const cachedAddresses = new Set(this._getProviderTunnels().map(t => `${TUNNEL_ADDRESS_PREFIX}${t.tunnelId}`));
		const tracked = new Set<string>([
			...this._reconnectPauseReasons.keys(),
			...this._connectSessions.keys(),
		]);
		for (const address of tracked) {
			if (!cachedAddresses.has(address)) {
				this._resetReconnectState(address);
			}
		}
	}

	// -- Silent status check --

	private async _silentStatusCheck(trigger?: TunnelDiscoveryTrigger): Promise<void> {
		const resolvedTrigger: TunnelDiscoveryTrigger = trigger ?? (this._initialStatusChecked ? 'rediscover' : 'startup');
		const hostsEnabled = this._configurationService.getValue<boolean>(RemoteAgentHostsEnabledSettingId);
		const autoConnectEnabled = this._configurationService.getValue<boolean>(RemoteAgentHostAutoConnectSettingId);
		if (!hostsEnabled) {
			this._initialStatusChecked = true;
			this._updateConnectionStatuses();
			logTunnelDiscoveryResult(this._telemetryService, {
				trigger: resolvedTrigger,
				totalFound: 0,
				withActiveHost: 0,
				cachedBefore: this._tunnelService.getCachedTunnels().length,
				autoConnectEnabled,
				hostsEnabled,
				success: true,
			});
			return;
		}

		this._lastStatusCheck = Date.now();
		const cachedBefore = this._tunnelService.getCachedTunnels().length;

		// Fetch tunnel list silently to check online status
		let onlineTunnels: ITunnelInfo[] | undefined;
		try {
			onlineTunnels = await this._listTunnelsBounded();
		} catch {
			// No cached token or network error, so we cannot tell which hosts
			// are reachable. Mark the initial check done regardless: that flips
			// every unconnected provider out of its startup `connecting` state
			// and into `disconnected`, which is what puts retry and forget on
			// its section header instead of a spinner that never stops.
			this._initialStatusChecked = true;
			this._updateConnectionStatuses();
			logTunnelDiscoveryResult(this._telemetryService, {
				trigger: resolvedTrigger,
				totalFound: 0,
				withActiveHost: 0,
				cachedBefore,
				autoConnectEnabled,
				hostsEnabled,
				success: false,
			});
			return;
		}

		const cached = this._tunnelService.getCachedTunnels();
		if (onlineTunnels) {
			const onlineIds = new Set(onlineTunnels.map(t => t.tunnelId));
			// Remove cached tunnels that no longer exist on the account
			for (const tunnel of cached) {
				if (!onlineIds.has(tunnel.tunnelId)) {
					this._tunnelService.removeCachedTunnel(tunnel.tunnelId);
				}
			}

			// Auto-cache every discovered tunnel that isn't cached yet so
			// it appears in the picker on first discovery (e.g. fresh web
			// session), including tunnels whose host process is currently
			// offline — those render grayed-out via the status-update loop
			// below. Pass 'github' as authProvider so _handleSessionsChange
			// can match these tunnels for teardown on session removal.
			const cachedIds = new Set(cached.map(t => t.tunnelId));
			for (const tunnel of onlineTunnels) {
				if (!cachedIds.has(tunnel.tunnelId)) {
					this._tunnelService.cacheTunnel(tunnel, 'github');
				}
			}

			// Update online/offline status based on hostConnectionCount.
			// For tunnels, Connected means "host is online" (clickable to connect),
			// Disconnected means "host is offline". Actual relay connection
			// establishment happens when the user clicks the tunnel (or via
			// auto-connect below when enabled).
			const onlineTunnelMap = new Map(onlineTunnels.map(t => [t.tunnelId, t]));
			for (const [address, provider] of this._providerInstances) {
				// Skip tunnels that already have an active relay connection
				const hasConnection = this._remoteAgentHostService.connections.some(
					c => c.address === address && RemoteAgentHostConnectionStatus.isConnected(c.status)
				);
				if (hasConnection) {
					continue;
				}

				const tunnelId = address.slice(TUNNEL_ADDRESS_PREFIX.length);
				const info = onlineTunnelMap.get(tunnelId);
				// A tunnel this window is hosting reports a host connection —
				// its own. Calling that "online" would advertise this machine to
				// itself as a remote host and publish its sessions twice, so it
				// counts as offline for as long as we are the one serving it.
				if (info && info.hostConnectionCount > 0 && !this._isHostedTunnel(info)) {
					provider.setConnectionStatus(RemoteAgentHostConnectionStatus.connected);

					// The host is reachable again, so a stale host-offline park
					// must not keep the auto-connect pass below from reaching it.
					if (this._reconnectPauseReasons.get(address) === 'hostOffline') {
						this._clearReconnectBackoff(address);
					}
				} else {
					// Host is not online. Its cached sessions stay listed, but
					// `disconnected` renders them greyed and unopenable with
					// retry and forget on the section header — hiding them
					// instead would take away the only way to get rid of a host
					// that is never coming back.
					provider.setConnectionStatus(RemoteAgentHostConnectionStatus.disconnected);
				}
			}

			// Auto-connect online tunnels that aren't connected yet when the
			// user has opted into auto-connect (default on). This mirrors the
			// web embedder behaviour where no workspace picker is available
			// to trigger manual connection.
			const autoConnect = this._configurationService.getValue<boolean>(RemoteAgentHostAutoConnectSettingId);
			if (autoConnect) {
				for (const tunnel of onlineTunnels) {
					if (tunnel.hostConnectionCount > 0 && !this._isHostedTunnel(tunnel)) {
						const address = `${TUNNEL_ADDRESS_PREFIX}${tunnel.tunnelId}`;
						if (this._tunnelService.isAutoConnectSuppressed(tunnel.tunnelId)) {
							continue;
						}
						if (this._reconnectPauseReasons.has(address)) {
							continue;
						}
						const alreadyConnected = this._remoteAgentHostService.connections.some(
							c => c.address === address && RemoteAgentHostConnectionStatus.isConnected(c.status)
						);
						if (!alreadyConnected) {
							const mode = this._tunnelService.getAutoConnectMode(tunnel);
							if (mode === 'prompt') {
								this._logService.info(`[TunnelAgentHost] Prompting for the initial agent host location for ${address}`);
								this._connectTunnel(address, { userInitiated: true });
							} else {
								this._connectTunnel(address, { userInitiated: false });
							}
						}
					}
				}
			}
		}

		this._initialStatusChecked = true;
		this._updateConnectionStatuses();

		const totalFound = onlineTunnels?.length ?? 0;
		const withActiveHost = onlineTunnels?.filter(t => t.hostConnectionCount > 0).length ?? 0;
		this._logService.info(
			`[TunnelAgentHost] Silent status check (${resolvedTrigger}): totalFound=${totalFound}, withActiveHost=${withActiveHost}, cachedBefore=${cachedBefore}, autoConnect=${autoConnectEnabled}`
		);
		logTunnelDiscoveryResult(this._telemetryService, {
			trigger: resolvedTrigger,
			totalFound,
			withActiveHost,
			cachedBefore,
			autoConnectEnabled,
			hostsEnabled,
			success: true,
		});
	}
}

registerWorkbenchContribution2(TunnelAgentHostContribution.ID, TunnelAgentHostContribution, WorkbenchPhase.AfterRestored);
