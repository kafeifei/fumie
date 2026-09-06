/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IAgentConnection } from '../../../../../../platform/agentHost/common/agentService.js';
import {
	IRemoteAgentHostConnectionInfo,
	IRemoteAgentHostService,
	RemoteAgentHostAutoConnectSettingId,
	RemoteAgentHostConnectionStatus,
	RemoteAgentHostsEnabledSettingId,
} from '../../../../../../platform/agentHost/common/remoteAgentHostService.js';
import {
	ICachedTunnel,
	ITunnelAgentHostService,
	TUNNEL_ADDRESS_PREFIX,
	type ITunnelHostInfo,
	type ITunnelInfo,
} from '../../../../../../platform/agentHost/common/tunnelAgentHost.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IAuthenticationService } from '../../../../../../workbench/services/authentication/common/authentication.js';
import { IHostService } from '../../../../../../workbench/services/host/browser/host.js';
import { ITunnelHostService } from '../../../../../../workbench/contrib/chat/common/tunnelHost.js';
import type { TunnelConnectFailureReason } from '../../../../../common/sessionsTelemetry.js';
import { ISessionsProvider } from '../../../../../services/sessions/common/sessionsProvider.js';
import { ISessionsProvidersChangeEvent, ISessionsProvidersService } from '../../../../../services/sessions/browser/sessionsProvidersService.js';
import { IAgentHostFilterService } from '../../../../../services/agentHostFilter/common/agentHostFilter.js';
import { RemoteAgentHostSessionsProvider } from '../../browser/remoteAgentHostSessionsProvider.js';
import { TunnelAgentHostContribution } from '../../browser/tunnelAgentHost.contribution.js';

class StubProvider extends mock<RemoteAgentHostSessionsProvider>() {
	readonly setConnectionCalls: Array<{ connection: IAgentConnection; defaultDirectory: string | undefined }> = [];
	readonly clearConnectionCalls: undefined[] = [];

	override readonly id: string;
	override readonly remoteAddress: string;
	override readonly label: string;

	private readonly _status = observableValue<RemoteAgentHostConnectionStatus>('status', RemoteAgentHostConnectionStatus.connecting);
	override readonly connectionStatus = this._status;

	constructor(address: string, name: string) {
		super();
		this.id = `agenthost-${address}`;
		this.remoteAddress = address;
		this.label = name;
	}

	override setConnectionStatus(status: RemoteAgentHostConnectionStatus): void {
		this._status.set(status, undefined);
	}

	override setConnection(connection: IAgentConnection, defaultDirectory?: string): void {
		this.setConnectionCalls.push({ connection, defaultDirectory });
	}

	readonly unpublishCalls: string[] = [];
	override unpublishCachedSessions(): void { this.unpublishCalls.push(this.remoteAddress); }
	override clearConnection(): void { this.clearConnectionCalls.push(undefined); }

	override dispose(): void { /* noop */ }
}

class StubTunnelService extends Disposable implements ITunnelAgentHostService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTunnels = this._register(new Emitter<void>());
	readonly onDidChangeTunnels = this._onDidChangeTunnels.event;

	private _cached: ICachedTunnel[] = [];
	private _listed: ITunnelInfo[] | undefined;
	private readonly _suppressed = new Set<string>();
	autoConnectMode: 'background' | 'prompt' = 'background';

	/** Records every `connect()` call for assertions on the `userInitiated` threading. */
	readonly connectCalls: Array<{ tunnel: ITunnelInfo; authProvider: string | undefined; options: { readonly userInitiated?: boolean } | undefined }> = [];

	setCached(tunnels: ICachedTunnel[]): void {
		this._cached = tunnels;
		this._onDidChangeTunnels.fire();
	}

	getCachedTunnels(): ICachedTunnel[] { return this._cached; }
	setListed(tunnels: ITunnelInfo[] | undefined): void { this._listed = tunnels; }
	/** Simulates an enumeration that cannot run at all (no token, network down). */
	listShouldThrow = false;
	async listUserLimits(): Promise<undefined> {
		return undefined;
	}

	async listTunnels(): Promise<ITunnelInfo[]> {
		if (this.listShouldThrow) {
			throw new Error('no cached token');
		}
		return this._listed ?? [];
	}
	getAutoConnectMode(): 'background' | 'prompt' { return this.autoConnectMode; }
	readonly canDeleteTunnels = true;
	async deleteTunnel(tunnel: ITunnelInfo): Promise<void> { this.removeCachedTunnel(tunnel.tunnelId); }
	cacheTunnel(tunnel: ITunnelInfo, authProvider?: 'github' | 'microsoft'): void {
		this._cached = [{ tunnelId: tunnel.tunnelId, clusterId: tunnel.clusterId, name: tunnel.name, authProvider }, ...this._cached.filter(cached => cached.tunnelId !== tunnel.tunnelId)];
		this._onDidChangeTunnels.fire();
	}
	removeCachedTunnel(tunnelId: string): void {
		this._cached = this._cached.filter(tunnel => tunnel.tunnelId !== tunnelId);
		this._onDidChangeTunnels.fire();
	}
	isAutoConnectSuppressed(id: string): boolean { return this._suppressed.has(id); }
	suppressAutoConnect(id: string): void { this._suppressed.add(id); }
	clearAutoConnectSuppression(id: string): void { this._suppressed.delete(id); }
	async getAuthProvider(): Promise<'github' | 'microsoft' | undefined> { return undefined; }

	async connect(tunnel: ITunnelInfo, authProvider?: 'github' | 'microsoft', options?: { readonly userInitiated?: boolean }): Promise<void> {
		this.connectCalls.push({ tunnel, authProvider, options });
	}

	async disconnect(_address: string): Promise<void> { /* noop */ }
}

class StubRemoteAgentHostService extends Disposable {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnections = this._register(new Emitter<void>());
	readonly onDidChangeConnections = this._onDidChangeConnections.event;

	private readonly _connections: IRemoteAgentHostConnectionInfo[] = [];
	private readonly _agentConnections = new Map<string, IAgentConnection>();

	get connections(): readonly IRemoteAgentHostConnectionInfo[] { return this._connections; }

	getConnection(address: string): IAgentConnection | undefined {
		return this._agentConnections.get(address);
	}

	addConnection(info: IRemoteAgentHostConnectionInfo, connection: IAgentConnection): void {
		this._connections.push(info);
		this._agentConnections.set(info.address, connection);
		this._onDidChangeConnections.fire();
	}

	setConnectionStatus(address: string, status: RemoteAgentHostConnectionStatus): void {
		const index = this._connections.findIndex(connection => connection.address === address);
		if (index >= 0) {
			this._connections[index] = { ...this._connections[index], status };
			this._onDidChangeConnections.fire();
		}
	}

	fireConnectionChange(): void {
		this._onDidChangeConnections.fire();
	}
}

class StubHostService extends mock<IHostService>() {
	private readonly _onDidChangeFocus = new Emitter<boolean>();
	override readonly onDidChangeFocus = this._onDidChangeFocus.event;

	fireFocus(focused: boolean): void {
		this._onDidChangeFocus.fire(focused);
	}
}

class StubTunnelHostService extends Disposable implements ITunnelHostService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<void>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private _sharingInfo: ITunnelHostInfo | undefined;

	get isSharing(): boolean {
		return this._sharingInfo !== undefined;
	}

	get isConnecting(): boolean {
		return false;
	}

	get sharingInfo(): ITunnelHostInfo | undefined {
		return this._sharingInfo;
	}

	setSharingInfo(tunnelName: string | undefined): void {
		this._sharingInfo = tunnelName ? { tunnelName } : undefined;
		this._onDidChangeStatus.fire();
	}

	async startSharing(): Promise<void> { throw new Error('Not implemented'); }
	async stopSharing(): Promise<void> { this.setSharingInfo(undefined); }
	async rollPhonePairing(): Promise<void> { throw new Error('Not implemented'); }
	readonly onDidChangeClients = Event.None;
	async listClients(): Promise<never[]> { return []; }
	async disconnectClient(): Promise<void> { }
}

class StubSessionsProvidersService extends Disposable {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<ISessionsProvidersChangeEvent>());
	readonly onDidChangeProviders = this._onDidChange.event;

	private readonly _providers = new Map<string, ISessionsProvider>();

	registerProvider(provider: ISessionsProvider): IDisposable {
		this._providers.set(provider.id, provider);
		this._onDidChange.fire({ added: [provider], removed: [] });
		return toDisposable(() => {
			if (this._providers.delete(provider.id)) {
				this._onDidChange.fire({ added: [], removed: [provider] });
			}
		});
	}

	getProviders(): ISessionsProvider[] {
		return [...this._providers.values()];
	}
}

class StubFilterService {
	declare readonly _serviceBrand: undefined;
	registerDiscoveryHandler(_handler: () => Promise<void>): IDisposable { return toDisposable(() => { }); }
	async rediscover(): Promise<void> { /* noop — production routes through the discovery handler */ }
}

class TestTunnelContribution extends TunnelAgentHostContribution {
	readonly stubProviders = new Map<string, StubProvider>();

	protected override _instantiateProvider(address: string, name: string): RemoteAgentHostSessionsProvider {
		const stub = new StubProvider(address, name);
		this.stubProviders.set(address, stub);
		return stub as unknown as RemoteAgentHostSessionsProvider;
	}
}

suite('TunnelAgentHostContribution', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Let the background connects a status check fires settle. `_silentStatusCheck`
	 * deliberately does not await them, so an assertion on `connectCalls` has to
	 * drain the microtask queue first.
	 */
	async function flushBackgroundConnects(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 0));
	}

	test('newly-cached tunnel binds to subsequent live connection', async () => {
		// Regression guard for the picker flow: `tunnelService.connect()` is
		// contractually obligated to cache the tunnel BEFORE announcing the
		// live connection via `addManagedConnection`. That ordering lets the
		// `onDidChangeTunnels` handler create the provider first, so the
		// `onDidChangeConnections` handler can wire it. Both halves are
		// exercised here.
		const tunnelService = store.add(new StubTunnelService());
		const remoteService = store.add(new StubRemoteAgentHostService());
		const providersService = store.add(new StubSessionsProvidersService());
		const configurationService = new TestConfigurationService({ [RemoteAgentHostsEnabledSettingId]: true });
		const hostService = new StubHostService();

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ITunnelAgentHostService, tunnelService);
		instantiationService.stub(IRemoteAgentHostService, remoteService as unknown as IRemoteAgentHostService);
		instantiationService.stub(ISessionsProvidersService, providersService as unknown as ISessionsProvidersService);
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INotificationService, { notify: () => ({ close() { } }) } as unknown as INotificationService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IAuthenticationService, { onDidChangeSessions: Event.None } as unknown as IAuthenticationService);
		instantiationService.stub(ITelemetryService, { publicLog2: () => { } } as unknown as ITelemetryService);
		instantiationService.stub(IHostService, hostService);
		instantiationService.stub(ITunnelHostService, store.add(new StubTunnelHostService()));
		instantiationService.stub(IAgentHostFilterService, new StubFilterService() as unknown as IAgentHostFilterService);

		const contribution = store.add(instantiationService.createInstance(TestTunnelContribution));

		const tunnelId = 'tunnel-abc';
		const address = `${TUNNEL_ADDRESS_PREFIX}${tunnelId}`;
		const fakeConnection = {} as IAgentConnection;

		// Step 1: cache the tunnel — creates the provider via `_reconcileProviders`.
		tunnelService.setCached([{ tunnelId, clusterId: 'use', name: 'My Tunnel' }]);
		const provider = contribution.stubProviders.get(address);
		assert.ok(provider, 'provider should be created for the cached tunnel');
		assert.strictEqual(provider!.setConnectionCalls.length, 0, 'no live connection yet — wire-up must wait');

		// Step 2: announce the live connection — `_wireConnections` should bind it.
		remoteService.addConnection({
			address,
			name: 'My Tunnel',
			clientId: 'client-1',
			status: RemoteAgentHostConnectionStatus.connected,
		}, fakeConnection);

		assert.deepStrictEqual(provider!.setConnectionCalls.map(c => c.connection), [fakeConnection]);

		await configurationService.setUserConfiguration(RemoteAgentHostsEnabledSettingId, false);
		configurationService.onDidChangeConfigurationEmitter.fire({
			affectsConfiguration: key => key === RemoteAgentHostsEnabledSettingId,
			affectedKeys: new Set([RemoteAgentHostsEnabledSettingId]),
			change: { keys: [RemoteAgentHostsEnabledSettingId], overrides: [] },
			source: ConfigurationTarget.USER,
		});

		assert.deepStrictEqual(providersService.getProviders(), []);
	});

	test('background auto-connect threads userInitiated: false through to tunnelService.connect, while explicit connects thread userInitiated: true', async () => {
		// Focused regression test for the userInitiated/silent policy:
		// background/auto-connect must never be treated as user-initiated
		// (so it can reuse, but never prompt for, a saved location), while an
		// explicit connect must retain userInitiated: true.
		const tunnelService = store.add(new StubTunnelService());
		const remoteService = store.add(new StubRemoteAgentHostService());
		const providersService = store.add(new StubSessionsProvidersService());
		const configurationService = new TestConfigurationService({ [RemoteAgentHostsEnabledSettingId]: true });
		const hostService = new StubHostService();

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ITunnelAgentHostService, tunnelService);
		instantiationService.stub(IRemoteAgentHostService, remoteService as unknown as IRemoteAgentHostService);
		instantiationService.stub(ISessionsProvidersService, providersService as unknown as ISessionsProvidersService);
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INotificationService, { notify: () => ({ close() { } }) } as unknown as INotificationService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IAuthenticationService, { onDidChangeSessions: Event.None } as unknown as IAuthenticationService);
		instantiationService.stub(ITelemetryService, { publicLog2: () => { } } as unknown as ITelemetryService);
		instantiationService.stub(IHostService, hostService);
		instantiationService.stub(ITunnelHostService, store.add(new StubTunnelHostService()));
		instantiationService.stub(IAgentHostFilterService, new StubFilterService() as unknown as IAgentHostFilterService);

		const contribution = store.add(instantiationService.createInstance(TestTunnelContribution));

		const tunnelId = 'tunnel-bg';
		const address = `${TUNNEL_ADDRESS_PREFIX}${tunnelId}`;
		tunnelService.setCached([{ tunnelId, clusterId: 'use', name: 'Background Tunnel' }]);

		// Access the private connect-orchestration method via a typed seam —
		// it's the only place `tunnelService.connect()` is invoked, so this
		// exercises the exact threading the fix introduces without needing
		// to drive the full `connectOnDemand`/reconnect-timer machinery.
		const testable = contribution as unknown as {
			_connectTunnel(address: string, options: { readonly userInitiated: boolean }): Promise<void>;
		};

		await testable._connectTunnel(address, { userInitiated: false });
		assert.strictEqual(tunnelService.connectCalls.length, 1);
		assert.strictEqual(tunnelService.connectCalls[0].options?.userInitiated, false, 'background connect must pass userInitiated: false');

		await testable._connectTunnel(address, { userInitiated: true });
		assert.strictEqual(tunnelService.connectCalls.length, 2);
		assert.strictEqual(tunnelService.connectCalls[1].options?.userInitiated, true, 'explicit/user-initiated connect must pass userInitiated: true');
	});

	test('auto-connect prompts once for an initial location, then reconnects silently', async () => {
		const tunnelService = store.add(new StubTunnelService());
		tunnelService.autoConnectMode = 'prompt';
		const remoteService = store.add(new StubRemoteAgentHostService());
		const providersService = store.add(new StubSessionsProvidersService());
		const configurationService = new TestConfigurationService({
			[RemoteAgentHostsEnabledSettingId]: true,
			[RemoteAgentHostAutoConnectSettingId]: true,
		});
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ITunnelAgentHostService, tunnelService);
		instantiationService.stub(IRemoteAgentHostService, remoteService as unknown as IRemoteAgentHostService);
		instantiationService.stub(ISessionsProvidersService, providersService as unknown as ISessionsProvidersService);
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INotificationService, { notify: () => ({ close() { } }) } as unknown as INotificationService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IAuthenticationService, { onDidChangeSessions: Event.None } as unknown as IAuthenticationService);
		instantiationService.stub(ITelemetryService, { publicLog2: () => { } } as unknown as ITelemetryService);
		instantiationService.stub(IHostService, new StubHostService());
		instantiationService.stub(ITunnelHostService, store.add(new StubTunnelHostService()));
		instantiationService.stub(IAgentHostFilterService, new StubFilterService() as unknown as IAgentHostFilterService);

		const contribution = store.add(instantiationService.createInstance(TestTunnelContribution));
		const tunnel: ITunnelInfo = { tunnelId: 'tunnel-needs-choice', clusterId: 'use', name: 'Needs Choice', tags: ['protocolv6'], protocolVersion: 6, hostConnectionCount: 1 };
		tunnelService.setListed([tunnel]);
		const testable = contribution as unknown as { _silentStatusCheck(): Promise<void> };

		await testable._silentStatusCheck();
		await flushBackgroundConnects();
		assert.deepStrictEqual(tunnelService.connectCalls.map(call => call.options?.userInitiated), [true]);

		tunnelService.autoConnectMode = 'background';
		await testable._silentStatusCheck();
		await flushBackgroundConnects();
		assert.deepStrictEqual(tunnelService.connectCalls.map(call => call.options?.userInitiated), [true, false]);
	});

	test('does not auto-connect the locally hosted tunnel and reconnects it after sharing stops', async () => {
		const tunnelService = store.add(new StubTunnelService());
		const remoteService = store.add(new StubRemoteAgentHostService());
		const providersService = store.add(new StubSessionsProvidersService());
		const configurationService = new TestConfigurationService({
			[RemoteAgentHostsEnabledSettingId]: true,
			[RemoteAgentHostAutoConnectSettingId]: true,
		});
		const hostService = new StubHostService();
		const tunnelHostService = store.add(new StubTunnelHostService());
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ITunnelAgentHostService, tunnelService);
		instantiationService.stub(IRemoteAgentHostService, remoteService as unknown as IRemoteAgentHostService);
		instantiationService.stub(ISessionsProvidersService, providersService as unknown as ISessionsProvidersService);
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INotificationService, { notify: () => ({ close() { } }) } as unknown as INotificationService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IAuthenticationService, { onDidChangeSessions: Event.None } as unknown as IAuthenticationService);
		instantiationService.stub(ITelemetryService, { publicLog2: () => { } } as unknown as ITelemetryService);
		instantiationService.stub(IHostService, hostService);
		instantiationService.stub(ITunnelHostService, tunnelHostService);
		instantiationService.stub(IAgentHostFilterService, new StubFilterService() as unknown as IAgentHostFilterService);

		const locallyHostedTunnel: ITunnelInfo = { tunnelId: 'tunnel-local', clusterId: 'use', name: 'This Machine', tags: [], protocolVersion: 6, hostConnectionCount: 1 };
		const remoteTunnel: ITunnelInfo = { tunnelId: 'tunnel-remote', clusterId: 'use', name: 'Remote Machine', tags: [], protocolVersion: 6, hostConnectionCount: 1 };
		tunnelHostService.setSharingInfo(locallyHostedTunnel.name);

		const contribution = store.add(instantiationService.createInstance(TestTunnelContribution));
		tunnelService.setCached([
			{ tunnelId: locallyHostedTunnel.tunnelId, clusterId: locallyHostedTunnel.clusterId, name: locallyHostedTunnel.name },
			{ tunnelId: remoteTunnel.tunnelId, clusterId: remoteTunnel.clusterId, name: remoteTunnel.name },
		]);
		tunnelService.setListed([locallyHostedTunnel, remoteTunnel]);
		const testable = contribution as unknown as { _silentStatusCheck(): Promise<void> };
		await testable._silentStatusCheck();
		await flushBackgroundConnects();
		const initialConnects = tunnelService.connectCalls.map(call => call.tunnel.tunnelId);

		tunnelHostService.setSharingInfo(undefined);
		await flushBackgroundConnects();
		const connectsAfterSharingStopped = tunnelService.connectCalls.map(call => call.tunnel.tunnelId);

		assert.deepStrictEqual(
			{ initialConnects, connectsAfterSharingStopped },
			{
				initialConnects: [remoteTunnel.tunnelId],
				connectsAfterSharingStopped: [remoteTunnel.tunnelId, locallyHostedTunnel.tunnelId, remoteTunnel.tunnelId],
			},
		);
	});

	test('a parked host stays parked; only an auth park clears when a session arrives', () => {
		const tunnelService = store.add(new StubTunnelService());
		const remoteService = store.add(new StubRemoteAgentHostService());
		const providersService = store.add(new StubSessionsProvidersService());
		const configurationService = new TestConfigurationService({ [RemoteAgentHostsEnabledSettingId]: true });
		const hostService = new StubHostService();
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ITunnelAgentHostService, tunnelService as unknown as ITunnelAgentHostService);
		instantiationService.stub(IRemoteAgentHostService, remoteService as unknown as IRemoteAgentHostService);
		instantiationService.stub(ISessionsProvidersService, providersService as unknown as ISessionsProvidersService);
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INotificationService, { notify: () => ({ close() { } }) } as unknown as INotificationService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IAuthenticationService, { onDidChangeSessions: Event.None } as unknown as IAuthenticationService);
		instantiationService.stub(ITelemetryService, { publicLog2: () => { } } as unknown as ITelemetryService);
		instantiationService.stub(IHostService, hostService);
		instantiationService.stub(ITunnelHostService, store.add(new StubTunnelHostService()));
		instantiationService.stub(IAgentHostFilterService, new StubFilterService() as unknown as IAgentHostFilterService);
		const contribution = store.add(instantiationService.createInstance(TestTunnelContribution));
		const failedAddress = `${TUNNEL_ADDRESS_PREFIX}tunnel-failed`;
		const offlineAddress = `${TUNNEL_ADDRESS_PREFIX}tunnel-offline`;
		const authAddress = `${TUNNEL_ADDRESS_PREFIX}tunnel-auth`;
		tunnelService.setCached([
			{ tunnelId: 'tunnel-failed', clusterId: 'use', name: 'Failed Tunnel' },
			{ tunnelId: 'tunnel-offline', clusterId: 'use', name: 'Offline Tunnel' },
			{ tunnelId: 'tunnel-auth', clusterId: 'use', name: 'Auth Tunnel' },
			{ tunnelId: 'tunnel-idle', clusterId: 'use', name: 'Idle Tunnel' },
		]);
		const testable = contribution as unknown as {
			_reconnectPauseReasons: Map<string, TunnelConnectFailureReason>;
			_handleSessionsChange(e: { providerId: string; label: string; event: { added?: unknown[]; removed?: unknown[] } }): void;
		};

		testable._reconnectPauseReasons.set(failedAddress, 'connectFailed');
		testable._reconnectPauseReasons.set(offlineAddress, 'hostOffline');
		testable._reconnectPauseReasons.set(authAddress, 'authExpired');

		// Window focus used to resume paused reconnects. Nothing retries in the
		// background any more, so it must leave every park exactly as it was.
		hostService.fireFocus(true);
		const afterFocus = [...testable._reconnectPauseReasons];

		// A fresh auth session is the one signal that genuinely unblocks a park:
		// the token the connect was missing now exists.
		testable._handleSessionsChange({ providerId: 'github', label: 'GitHub', event: { added: [{}] } });
		const afterSession = [...testable._reconnectPauseReasons];

		assert.deepStrictEqual(
			{ afterFocus, afterSession },
			{
				afterFocus: [[failedAddress, 'connectFailed'], [offlineAddress, 'hostOffline'], [authAddress, 'authExpired']],
				afterSession: [[failedAddress, 'connectFailed'], [offlineAddress, 'hostOffline']],
			},
		);
	});

	test('a status check clears a host-offline park once the host is back, and leaves other parks alone', async () => {
		const tunnelService = store.add(new StubTunnelService());
		const remoteService = store.add(new StubRemoteAgentHostService());
		const providersService = store.add(new StubSessionsProvidersService());
		const configurationService = new TestConfigurationService({
			[RemoteAgentHostsEnabledSettingId]: true,
			[RemoteAgentHostAutoConnectSettingId]: true,
		});
		const hostService = new StubHostService();
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ITunnelAgentHostService, tunnelService as unknown as ITunnelAgentHostService);
		instantiationService.stub(IRemoteAgentHostService, remoteService as unknown as IRemoteAgentHostService);
		instantiationService.stub(ISessionsProvidersService, providersService as unknown as ISessionsProvidersService);
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INotificationService, { notify: () => ({ close() { } }) } as unknown as INotificationService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IAuthenticationService, { onDidChangeSessions: Event.None } as unknown as IAuthenticationService);
		instantiationService.stub(ITelemetryService, { publicLog2: () => { } } as unknown as ITelemetryService);
		instantiationService.stub(IHostService, hostService);
		instantiationService.stub(ITunnelHostService, store.add(new StubTunnelHostService()));
		instantiationService.stub(IAgentHostFilterService, new StubFilterService() as unknown as IAgentHostFilterService);
		const contribution = store.add(instantiationService.createInstance(TestTunnelContribution));
		const offlineAddress = `${TUNNEL_ADDRESS_PREFIX}tunnel-offline`;
		const authAddress = `${TUNNEL_ADDRESS_PREFIX}tunnel-auth`;
		const failedAddress = `${TUNNEL_ADDRESS_PREFIX}tunnel-failed`;
		tunnelService.setCached([
			{ tunnelId: 'tunnel-offline', clusterId: 'use', name: 'Offline Tunnel' },
			{ tunnelId: 'tunnel-auth', clusterId: 'use', name: 'Auth Tunnel' },
			{ tunnelId: 'tunnel-failed', clusterId: 'use', name: 'Failed Tunnel' },
		]);
		tunnelService.setListed([
			{ tunnelId: 'tunnel-offline', clusterId: 'use', name: 'Offline Tunnel', tags: [], protocolVersion: 5, hostConnectionCount: 1 },
			{ tunnelId: 'tunnel-auth', clusterId: 'use', name: 'Auth Tunnel', tags: [], protocolVersion: 5, hostConnectionCount: 1 },
			{ tunnelId: 'tunnel-failed', clusterId: 'use', name: 'Failed Tunnel', tags: [], protocolVersion: 5, hostConnectionCount: 1 },
		]);
		const testable = contribution as unknown as {
			_reconnectPauseReasons: Map<string, TunnelConnectFailureReason>;
			_silentStatusCheck(): Promise<void>;
		};

		testable._reconnectPauseReasons.set(offlineAddress, 'hostOffline');
		testable._reconnectPauseReasons.set(authAddress, 'authExpired');
		testable._reconnectPauseReasons.set(failedAddress, 'connectFailed');
		await testable._silentStatusCheck();
		await flushBackgroundConnects();

		assert.deepStrictEqual(
			{
				paused: [...testable._reconnectPauseReasons],
				connects: tunnelService.connectCalls.map(call => call.tunnel.tunnelId),
			},
			{
				paused: [[authAddress, 'authExpired'], [failedAddress, 'connectFailed']],
				connects: ['tunnel-offline'],
			},
		);
	});

	test('a discovery that cannot enumerate leaves the host disconnected rather than stuck connecting', async () => {
		// The stuck-list bug: `listTunnels` throwing used to return early with
		// the provider still in its startup `connecting` state, so the section
		// spun forever and its rows stayed openable — and failed silently. The
		// cache is deliberately kept: `disconnected` is what puts retry and
		// forget on the header, which is the only way to get rid of the host.
		const tunnelService = store.add(new StubTunnelService());
		tunnelService.listShouldThrow = true;
		const remoteService = store.add(new StubRemoteAgentHostService());
		const providersService = store.add(new StubSessionsProvidersService());
		const configurationService = new TestConfigurationService({ [RemoteAgentHostsEnabledSettingId]: true });
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ITunnelAgentHostService, tunnelService as unknown as ITunnelAgentHostService);
		instantiationService.stub(IRemoteAgentHostService, remoteService as unknown as IRemoteAgentHostService);
		instantiationService.stub(ISessionsProvidersService, providersService as unknown as ISessionsProvidersService);
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INotificationService, { notify: () => ({ close() { } }) } as unknown as INotificationService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IAuthenticationService, { onDidChangeSessions: Event.None } as unknown as IAuthenticationService);
		instantiationService.stub(ITelemetryService, { publicLog2: () => { } } as unknown as ITelemetryService);
		instantiationService.stub(IHostService, new StubHostService());
		instantiationService.stub(ITunnelHostService, store.add(new StubTunnelHostService()));
		instantiationService.stub(IAgentHostFilterService, new StubFilterService() as unknown as IAgentHostFilterService);

		const contribution = store.add(instantiationService.createInstance(TestTunnelContribution));
		tunnelService.setCached([{ tunnelId: 'tunnel-stranded', clusterId: 'use', name: 'Stranded Tunnel' }]);
		const address = `${TUNNEL_ADDRESS_PREFIX}tunnel-stranded`;
		const provider = contribution.stubProviders.get(address)!;
		const testable = contribution as unknown as { _silentStatusCheck(): Promise<void> };

		assert.strictEqual(provider.connectionStatus.get().kind, 'connecting');
		await testable._silentStatusCheck();

		assert.deepStrictEqual(
			{ unpublished: provider.unpublishCalls, status: provider.connectionStatus.get().kind },
			{ unpublished: [], status: 'disconnected' },
		);
	});

	test('forgetting a tunnel drops it from the recent list so no provider comes back', async () => {
		const tunnelService = store.add(new StubTunnelService());
		const remoteService = store.add(new StubRemoteAgentHostService());
		const providersService = store.add(new StubSessionsProvidersService());
		const configurationService = new TestConfigurationService({ [RemoteAgentHostsEnabledSettingId]: true });
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ITunnelAgentHostService, tunnelService as unknown as ITunnelAgentHostService);
		instantiationService.stub(IRemoteAgentHostService, remoteService as unknown as IRemoteAgentHostService);
		instantiationService.stub(ISessionsProvidersService, providersService as unknown as ISessionsProvidersService);
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INotificationService, { notify: () => ({ close() { } }) } as unknown as INotificationService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IAuthenticationService, { onDidChangeSessions: Event.None } as unknown as IAuthenticationService);
		instantiationService.stub(ITelemetryService, { publicLog2: () => { } } as unknown as ITelemetryService);
		instantiationService.stub(IHostService, new StubHostService());
		instantiationService.stub(ITunnelHostService, store.add(new StubTunnelHostService()));
		instantiationService.stub(IAgentHostFilterService, new StubFilterService() as unknown as IAgentHostFilterService);

		const contribution = store.add(instantiationService.createInstance(TestTunnelContribution));
		tunnelService.setCached([{ tunnelId: 'tunnel-unwanted', clusterId: 'use', name: 'Unwanted Tunnel' }]);
		const address = `${TUNNEL_ADDRESS_PREFIX}tunnel-unwanted`;
		// `stubProviders` records every provider ever created, so the live set is
		// the one that says whether the host really went away.
		const testable = contribution as unknown as {
			_forgetTunnel(address: string): Promise<void>;
			_providerInstances: Map<string, unknown>;
		};

		assert.deepStrictEqual(
			{ cached: tunnelService.getCachedTunnels().map(t => t.tunnelId), live: [...testable._providerInstances.keys()] },
			{ cached: ['tunnel-unwanted'], live: [address] },
		);

		await testable._forgetTunnel(address);

		assert.deepStrictEqual(
			{ cached: tunnelService.getCachedTunnels().map(t => t.tunnelId), live: [...testable._providerInstances.keys()] },
			{ cached: [], live: [] },
		);
	});

	test('clears the provider connection only after a connected transport disconnects', () => {
		const tunnelService = store.add(new StubTunnelService());
		const remoteService = store.add(new StubRemoteAgentHostService());
		const providersService = store.add(new StubSessionsProvidersService());
		const configurationService = new TestConfigurationService({ [RemoteAgentHostsEnabledSettingId]: true });
		const hostService = new StubHostService();
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ITunnelAgentHostService, tunnelService as unknown as ITunnelAgentHostService);
		instantiationService.stub(IRemoteAgentHostService, remoteService as unknown as IRemoteAgentHostService);
		instantiationService.stub(ISessionsProvidersService, providersService as unknown as ISessionsProvidersService);
		instantiationService.stub(IConfigurationService, configurationService);
		instantiationService.stub(INotificationService, { notify: () => ({ close() { } }) } as unknown as INotificationService);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.stub(IAuthenticationService, { onDidChangeSessions: Event.None } as unknown as IAuthenticationService);
		instantiationService.stub(ITelemetryService, { publicLog2: () => { } } as unknown as ITelemetryService);
		instantiationService.stub(IHostService, hostService);
		instantiationService.stub(ITunnelHostService, store.add(new StubTunnelHostService()));
		instantiationService.stub(IAgentHostFilterService, new StubFilterService() as unknown as IAgentHostFilterService);
		const contribution = store.add(instantiationService.createInstance(TestTunnelContribution));
		const tunnelId = 'tunnel-disconnect';
		const address = `${TUNNEL_ADDRESS_PREFIX}${tunnelId}`;
		tunnelService.setCached([{ tunnelId, clusterId: 'use', name: 'Disconnect Tunnel' }]);
		remoteService.addConnection({ address, name: 'Disconnect Tunnel', clientId: 'client', status: RemoteAgentHostConnectionStatus.connected }, {} as IAgentConnection);
		const provider = contribution.stubProviders.get(address)!;

		remoteService.fireConnectionChange();
		const whileConnected = provider.clearConnectionCalls.length;
		remoteService.setConnectionStatus(address, RemoteAgentHostConnectionStatus.connecting);
		const whileConnecting = provider.clearConnectionCalls.length;
		remoteService.setConnectionStatus(address, RemoteAgentHostConnectionStatus.connected);
		remoteService.setConnectionStatus(address, RemoteAgentHostConnectionStatus.disconnected);
		const afterDisconnect = provider.clearConnectionCalls.length;
		remoteService.fireConnectionChange();
		const afterRepeatDisconnect = provider.clearConnectionCalls.length;

		// A transport that drops via an intermediate `connecting` state must
		// still clear: the wired-provider bookkeeping has to survive statuses
		// that are neither connected nor disconnected.
		remoteService.setConnectionStatus(address, RemoteAgentHostConnectionStatus.connected);
		remoteService.setConnectionStatus(address, RemoteAgentHostConnectionStatus.connecting);
		remoteService.setConnectionStatus(address, RemoteAgentHostConnectionStatus.disconnected);

		assert.deepStrictEqual(
			{ whileConnected, whileConnecting, afterDisconnect, afterRepeatDisconnect, afterConnectingDisconnect: provider.clearConnectionCalls.length },
			{ whileConnected: 0, whileConnecting: 0, afterDisconnect: 1, afterRepeatDisconnect: 1, afterConnectingDisconnect: 2 },
		);
	});
});
