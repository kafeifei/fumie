/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRemoteAgentHostLocationPreferenceService } from '../../../../../platform/agentHost/common/remoteAgentHostLocationPreference.js';
import {
	IRemoteAgentHostConnectionInfo,
	IRemoteAgentHostEntry,
	IRemoteAgentHostService,
	RemoteAgentHostConnectionStatus,
	RemoteAgentHostEntryType,
} from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ICachedTunnel, ITunnelAgentHostService } from '../../../../../platform/agentHost/common/tunnelAgentHost.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ISessionsProvidersChangeEvent, ISessionsProvidersService } from '../../../sessions/browser/sessionsProvidersService.js';
import { ISessionsProvider } from '../../../sessions/common/sessionsProvider.js';
import { RemoteAgentHostInventoryService } from '../../browser/remoteAgentHostInventoryService.js';
import {
	cachedSessionsStorageKey,
	DISPLAY_NAMES_STORAGE_KEY,
	LAST_CONNECTED_STORAGE_KEY,
} from '../../common/remoteAgentHostInventory.js';

class StubRemoteAgentHostService implements Partial<IRemoteAgentHostService> {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnections = new Emitter<void>();
	readonly onDidChangeConnections = this._onDidChangeConnections.event;

	connections: readonly IRemoteAgentHostConnectionInfo[] = [];
	configuredEntries: readonly IRemoteAgentHostEntry[] = [];
	readonly removed: string[] = [];

	async removeRemoteAgentHost(address: string): Promise<void> {
		this.removed.push(address);
	}

	setConnections(connections: readonly IRemoteAgentHostConnectionInfo[]): void {
		this.connections = connections;
		this._onDidChangeConnections.fire();
	}

	dispose(): void {
		this._onDidChangeConnections.dispose();
	}
}

class StubTunnelAgentHostService implements Partial<ITunnelAgentHostService> {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTunnels = new Emitter<void>();
	readonly onDidChangeTunnels = this._onDidChangeTunnels.event;

	tunnels: ICachedTunnel[] = [];

	getCachedTunnels(): ICachedTunnel[] {
		return this.tunnels;
	}

	isAutoConnectSuppressed(): boolean {
		return false;
	}

	dispose(): void {
		this._onDidChangeTunnels.dispose();
	}
}

class StubSessionsProvidersService implements Partial<ISessionsProvidersService> {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProviders = new Emitter<ISessionsProvidersChangeEvent>();
	readonly onDidChangeProviders = this._onDidChangeProviders.event;

	getProviders(): ISessionsProvider[] {
		return [];
	}

	dispose(): void {
		this._onDidChangeProviders.dispose();
	}
}

class StubLocationPreferenceService implements Partial<IRemoteAgentHostLocationPreferenceService> {
	declare readonly _serviceBrand: undefined;

	readonly cleared: string[] = [];

	clearPreference(hostKey: string): void {
		this.cleared.push(hostKey);
	}
}

/**
 * The two stores this inventory adds on top of what the host services already
 * keep: the user's own name for a host and when this machine last reached it.
 * Both are keyed by the host's address, which is the only identity a settings
 * entry, a cached tunnel and a live provider all agree on.
 */
suite('RemoteAgentHostInventoryService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function entry(name: string, address: string): IRemoteAgentHostEntry {
		return { name, connection: { type: RemoteAgentHostEntryType.WebSocket, address } };
	}

	function connection(address: string, status = RemoteAgentHostConnectionStatus.connected): IRemoteAgentHostConnectionInfo {
		return { address, name: address, clientId: 'client', status };
	}

	function createService() {
		const storage = store.add(new InMemoryStorageService());
		const hostService = store.add(new StubRemoteAgentHostService());
		const tunnelService = store.add(new StubTunnelAgentHostService());
		const providersService = store.add(new StubSessionsProvidersService());
		const preferenceService = new StubLocationPreferenceService();

		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IStorageService, storage);
		instantiationService.stub(IRemoteAgentHostService, hostService as unknown as IRemoteAgentHostService);
		instantiationService.stub(ITunnelAgentHostService, tunnelService as unknown as ITunnelAgentHostService);
		instantiationService.stub(IRemoteAgentHostLocationPreferenceService, preferenceService as unknown as IRemoteAgentHostLocationPreferenceService);
		instantiationService.stub(ISessionsProvidersService, providersService as unknown as ISessionsProvidersService);

		const create = () => store.add(instantiationService.createInstance(RemoteAgentHostInventoryService));
		return { storage, hostService, tunnelService, preferenceService, create, service: create() };
	}

	test('a renamed host is listed under the name the user gave it', () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];

		assert.strictEqual(harness.service.list()[0].label, 'localhost:4321');

		harness.service.rename(harness.service.list()[0], 'Build box');
		assert.strictEqual(harness.service.list()[0].label, 'Build box');
		assert.strictEqual(harness.service.displayNameFor('localhost:4321'), 'Build box');
	});

	test('the name survives the host moving to another store, and outlives a restart', () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];
		harness.service.rename(harness.service.list()[0], 'Build box');

		// Same address, reported by the host service under a different name:
		// the override is keyed by address, not by whatever the store calls it.
		harness.hostService.configuredEntries = [entry('renamed-upstream', 'localhost:4321')];
		assert.strictEqual(harness.service.list()[0].label, 'Build box');

		const restarted = harness.create();
		assert.strictEqual(restarted.list()[0].label, 'Build box');
	});

	test('clearing the name falls back to what the store calls the host', () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];
		harness.service.rename(harness.service.list()[0], 'Build box');

		harness.service.rename(harness.service.list()[0], undefined);
		assert.strictEqual(harness.service.list()[0].label, 'localhost:4321');
		assert.strictEqual(harness.service.displayNameFor('localhost:4321'), undefined);
		assert.strictEqual(harness.storage.get(DISPLAY_NAMES_STORAGE_KEY, StorageScope.PROFILE), undefined);
	});

	test('a blank name is a clear, not a host called nothing', () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];
		harness.service.rename(harness.service.list()[0], 'Build box');

		harness.service.rename(harness.service.list()[0], '   ');
		assert.strictEqual(harness.service.list()[0].label, 'localhost:4321');
	});

	test('an orphaned host, which has no address left, can still be renamed', () => {
		const harness = createService();
		harness.storage.store(cachedSessionsStorageKey('ghost'), JSON.stringify([{ id: 's1' }]), StorageScope.APPLICATION, StorageTarget.USER);

		const orphan = harness.service.list()[0];
		assert.strictEqual(orphan.address, undefined);
		harness.service.rename(orphan, 'Old laptop');
		assert.strictEqual(harness.service.list()[0].label, 'Old laptop');
	});

	test('renaming fires a change so every surface reading the name redraws', () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];
		let changes = 0;
		store.add(harness.service.onDidChange(() => changes++));

		harness.service.rename(harness.service.list()[0], 'Build box');
		assert.strictEqual(changes, 1);
		// Renaming to the name it already has changes nothing.
		harness.service.rename(harness.service.list()[0], 'Build box');
		assert.strictEqual(changes, 1);
	});

	test('a host that has never connected reports no last-connected time', () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];

		assert.strictEqual(harness.service.list()[0].lastConnectedAt, undefined);
	});

	test('connecting stamps the time, and staying connected does not push it forward', () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];

		const before = Date.now();
		harness.hostService.setConnections([connection('localhost:4321')]);
		const stamped = harness.service.list()[0].lastConnectedAt;
		assert.ok(stamped !== undefined && stamped >= before, `expected a stamp, got ${stamped}`);

		// Rewritten to a sentinel: a second event for a host that never left
		// must not overwrite the moment it arrived.
		harness.storage.store(LAST_CONNECTED_STORAGE_KEY, JSON.stringify({ 'localhost:4321': 1 }), StorageScope.PROFILE, StorageTarget.MACHINE);
		harness.hostService.setConnections([connection('localhost:4321')]);
		assert.strictEqual(harness.service.list()[0].lastConnectedAt, 1);
	});

	test('a host that reconnects after dropping is stamped again', () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];

		harness.hostService.setConnections([connection('localhost:4321')]);
		harness.storage.store(LAST_CONNECTED_STORAGE_KEY, JSON.stringify({ 'localhost:4321': 1 }), StorageScope.PROFILE, StorageTarget.MACHINE);

		harness.hostService.setConnections([]);
		harness.hostService.setConnections([connection('localhost:4321')]);
		assert.ok((harness.service.list()[0].lastConnectedAt ?? 0) > 1);
	});

	test('a connection that is still handshaking is not a connection', () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];

		harness.hostService.setConnections([connection('localhost:4321', RemoteAgentHostConnectionStatus.connecting)]);
		assert.strictEqual(harness.service.list()[0].lastConnectedAt, undefined);
	});

	test('a host already connected when the service starts still has a time', () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];
		harness.hostService.connections = [connection('localhost:4321')];

		assert.ok(harness.create().list()[0].lastConnectedAt !== undefined);
	});

	test('forgetting a host takes its name and its last-connected time with it', async () => {
		const harness = createService();
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];
		harness.hostService.setConnections([connection('localhost:4321')]);
		harness.service.rename(harness.service.list()[0], 'Build box');

		await harness.service.forget(harness.service.list()[0]);

		assert.strictEqual(harness.service.displayNameFor('localhost:4321'), undefined);
		assert.strictEqual(harness.storage.get(LAST_CONNECTED_STORAGE_KEY, StorageScope.PROFILE), undefined);
		assert.deepStrictEqual(harness.hostService.removed, ['localhost:4321']);

		// A host that comes back is a new host, not the one that was removed
		// still wearing its old name.
		assert.strictEqual(harness.service.list()[0].label, 'localhost:4321');
	});

	test('an unreadable name store is ignored rather than fatal', () => {
		const harness = createService();
		harness.storage.store(DISPLAY_NAMES_STORAGE_KEY, 'not json', StorageScope.PROFILE, StorageTarget.USER);
		harness.hostService.configuredEntries = [entry('localhost:4321', 'localhost:4321')];

		assert.strictEqual(harness.service.list()[0].label, 'localhost:4321');
	});
});
