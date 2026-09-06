/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITunnelHostService } from '../../../../../workbench/contrib/chat/common/tunnelHost.js';
import { IAuthenticationService, type AuthenticationSession } from '../../../../../workbench/services/authentication/common/authentication.js';
import { AgentSettingsRemoteHosts } from '../../../settings/browser/agentSettingsRemoteHosts.js';
import {
	hasCachedTunnelAuth,
	SharingIntentTunnelHostService,
	TUNNEL_HOST_SHARING_INTENT_KEY,
	TunnelHostRestoreSharingSettingId,
	TunnelHostSharingRestoreContribution,
} from '../../electron-browser/tunnelHostSharingRestore.js';

/** The only tunnel scope `product.json` asks for is GitHub's `read:user`. */
const TUNNEL_SCOPE = 'read:user';

function session(scopes: readonly string[]): AuthenticationSession {
	return { id: `session-${scopes.join('-')}`, accessToken: 'token', account: { id: 'account', label: 'Account' }, scopes };
}

function authenticationService(sessions: readonly AuthenticationSession[] | Error): Pick<IAuthenticationService, 'getSessions'> {
	return {
		async getSessions() {
			if (sessions instanceof Error) {
				throw sessions;
			}
			return sessions;
		},
	};
}

suite('tunnel host sharing restore', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** A tunnel host that only records what was asked of it. */
	function fakeTunnelHost(isSharing = false) {
		const onDidChangeStatus = store.add(new Emitter<void>());
		const host = {
			_serviceBrand: undefined,
			isSharing,
			isConnecting: false,
			sharingInfo: undefined,
			onDidChangeStatus: onDidChangeStatus.event,
			startSharingCalls: 0,
			stopSharingCalls: 0,
			rollPhonePairingCalls: 0,
			async startSharing() { host.startSharingCalls++; host.isSharing = true; },
			async stopSharing() { host.stopSharingCalls++; host.isSharing = false; },
			async rollPhonePairing() { host.rollPhonePairingCalls++; },
			onDidChangeClients: Event.None,
			async listClients() { return []; },
			async disconnectClient() { },
		};
		return { host, onDidChangeStatus };
	}

	function storedIntent(storageService: InMemoryStorageService): boolean | undefined {
		return storageService.getBoolean(TUNNEL_HOST_SHARING_INTENT_KEY, StorageScope.APPLICATION);
	}

	suite('hasCachedTunnelAuth', () => {
		test('accepts a cached session whose scopes cover the tunnel scopes', async () => {
			assert.strictEqual(await hasCachedTunnelAuth(authenticationService([session([TUNNEL_SCOPE, 'repo'])]), false), true);
		});

		test('rejects a session that is missing a tunnel scope', async () => {
			assert.strictEqual(await hasCachedTunnelAuth(authenticationService([session(['repo'])]), false), false);
		});

		test('reports no credential when nothing is cached, so startup never signs in', async () => {
			assert.strictEqual(await hasCachedTunnelAuth(authenticationService([]), true), false);
		});

		test('a failing provider does not throw out of the startup path', async () => {
			assert.strictEqual(await hasCachedTunnelAuth(authenticationService(new Error('provider unavailable')), false), false);
		});
	});

	suite('SharingIntentTunnelHostService', () => {

		function setup(options: { isSharing?: boolean } = {}) {
			const storageService = store.add(new InMemoryStorageService());
			const { host, onDidChangeStatus } = fakeTunnelHost(options.isSharing);
			const service = new SharingIntentTunnelHostService(host, storageService);
			return { service, storageService, host, onDidChangeStatus };
		}

		test('turning sharing on is remembered', async () => {
			const { service, storageService } = setup();

			await service.startSharing();

			assert.strictEqual(storedIntent(storageService), true);
		});

		test('turning sharing off stays off', async () => {
			const { service, storageService } = setup({ isSharing: true });

			await service.stopSharing();

			assert.strictEqual(storedIntent(storageService), false);
		});

		test('the intent is machine-scoped, so exposing this machine never syncs to another', async () => {
			const { service, storageService } = setup();

			await service.startSharing();

			assert.strictEqual(
				storageService.keys(StorageScope.APPLICATION, StorageTarget.MACHINE).includes(TUNNEL_HOST_SHARING_INTENT_KEY),
				true);
		});

		test('a tunnel that fails to come up is still an intent to share', async () => {
			const { storageService } = setup();
			const failing = {
				_serviceBrand: undefined,
				isSharing: false,
				isConnecting: false,
				sharingInfo: undefined,
				onDidChangeStatus: Event.None,
				async startSharing(): Promise<void> { throw new Error('no tunnel today'); },
				async stopSharing(): Promise<void> { },
				async rollPhonePairing(): Promise<void> { },
				onDidChangeClients: Event.None,
				async listClients(): Promise<never[]> { return []; },
				async disconnectClient(): Promise<void> { },
			};
			const service = new SharingIntentTunnelHostService(failing, storageService);

			await assert.rejects(service.startSharing());

			assert.strictEqual(storedIntent(storageService), true);
		});

		test('a tunnel that drops on its own keeps the intent', async () => {
			const { service, storageService, host, onDidChangeStatus } = setup();
			await service.startSharing();

			host.isSharing = false;
			onDidChangeStatus.fire();

			assert.strictEqual(storedIntent(storageService), true);
		});
	});

	/**
	 * The checkbox on Settings → Remote Connections, driven for real.
	 *
	 * This is the control the user actually uses, and it is the one the first
	 * version of this feature missed: it calls the tunnel host service straight
	 * out rather than running the toggle command, so a test that fires the
	 * command proves nothing about it.
	 */
	suite('the Settings checkbox', () => {

		function setup(options: { isSharing?: boolean } = {}) {
			const storageService = store.add(new InMemoryStorageService());
			const { host } = fakeTunnelHost(options.isSharing);
			const service = new SharingIntentTunnelHostService(host, storageService);
			const container = document.createElement('div');
			const page = store.add(new AgentSettingsRemoteHosts(
				// IRemoteAgentHostInventoryService
				{ onDidChange: Event.None, list: () => [] } as never,
				// IDialogService
				{ error: async () => { } } as never,
				service as never,
				// IClipboardService
				{} as never,
				// IOpenerService
				{} as never,
				// ITunnelAgentHostService
				{ onDidChangeTunnels: Event.None } as never,
				// IAuthenticationService
				{ onDidChangeDeclaredProviders: Event.None, declaredProviders: [] } as never,
				// IProductService: no tunnel scopes, so the page's account lookup
				// settles without asking anything.
				{ tunnelApplicationConfig: undefined } as never,
				// IConfigurationService
				{ getValue: () => true } as never,
				// IContextMenuService
				{ showContextMenu: () => { } } as never,
				// IQuickInputService
				{ input: async () => undefined } as never,
				// ICommandService
				{ executeCommand: async () => undefined } as never,
				// IAgentHostFilterService
				{ onDidChange: Event.None, hosts: [] } as never,
				// IRemoteAgentHostService
				{ reconnect: () => { } } as never,
				// ISSHRemoteAgentHostService
				{ listSSHConfigHosts: async () => [] } as never,
				// IWSLRemoteAgentHostService
				{ isWSLAvailable: async () => false } as never,
			));
			page.render(container);
			return { container, storageService, host };
		}

		/** The page redraws once its silent account lookup settles. */
		async function settle(): Promise<void> {
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		function clickCheckbox(container: HTMLElement): void {
			const checkbox = container.querySelector('.agent-settings-checkbox-host .monaco-custom-toggle');
			assert.ok(checkbox, 'expected the "Allow connections to this machine" checkbox');
			(checkbox as HTMLElement).click();
		}

		test('ticking it turns sharing on and records the intent', async () => {
			const { container, storageService, host } = setup();
			await settle();

			clickCheckbox(container);

			assert.strictEqual(host.startSharingCalls, 1);
			assert.strictEqual(storedIntent(storageService), true);
		});

		test('unticking it records that sharing was turned off', async () => {
			const { container, storageService, host } = setup({ isSharing: true });
			await settle();

			clickCheckbox(container);

			assert.strictEqual(host.stopSharingCalls, 1);
			assert.strictEqual(storedIntent(storageService), false);
		});
	});

	suite('TunnelHostSharingRestoreContribution', () => {

		function setup(options: { storedIntent?: boolean; isSharing?: boolean; cachedAuth?: boolean; restoreSetting?: boolean } = {}) {
			const instantiationService = store.add(new TestInstantiationService());
			const storageService = store.add(new InMemoryStorageService());
			const { host } = fakeTunnelHost(options.isSharing);

			if (options.storedIntent !== undefined) {
				storageService.store(TUNNEL_HOST_SHARING_INTENT_KEY, options.storedIntent, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}

			const configurationService = new TestConfigurationService();
			configurationService.setUserConfiguration(TunnelHostRestoreSharingSettingId, options.restoreSetting ?? true);

			instantiationService.stub(IStorageService, storageService);
			instantiationService.stub(ILogService, store.add(new NullLogService()));
			instantiationService.stub(IConfigurationService, configurationService);
			instantiationService.stub(ITunnelHostService, host);
			instantiationService.stub(IAuthenticationService, authenticationService(options.cachedAuth ? [session([TUNNEL_SCOPE])] : []));

			const contribution = store.add(instantiationService.createInstance(TunnelHostSharingRestoreContribution));
			return { contribution, storageService, tunnelHost: host };
		}

		test('restores sharing at startup when the intent is stored and a credential is cached', async () => {
			const { contribution, tunnelHost } = setup({ storedIntent: true, cachedAuth: true });

			await contribution.restored;

			assert.strictEqual(tunnelHost.startSharingCalls, 1);
		});

		test('no stored intent means no restore', async () => {
			const { contribution, tunnelHost } = setup({ cachedAuth: true });

			await contribution.restored;

			assert.strictEqual(tunnelHost.startSharingCalls, 0);
		});

		test('never signs in to restore: no cached credential leaves sharing off', async () => {
			const { contribution, storageService, tunnelHost } = setup({ storedIntent: true, cachedAuth: false });

			await contribution.restored;

			assert.strictEqual(tunnelHost.startSharingCalls, 0);
			// The intent survives so the next launch can try again.
			assert.strictEqual(storedIntent(storageService), true);
		});

		test('does not restore when the setting is off', async () => {
			const { contribution, tunnelHost } = setup({ storedIntent: true, cachedAuth: true, restoreSetting: false });

			await contribution.restored;

			assert.strictEqual(tunnelHost.startSharingCalls, 0);
		});
	});
});
