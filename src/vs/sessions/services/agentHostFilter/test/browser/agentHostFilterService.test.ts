/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../../base/common/observable.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRemoteAgentHostService, RemoteAgentHostConnectionStatus } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ISessionsProvider } from '../../../sessions/common/sessionsProvider.js';
import { ISessionsProvidersChangeEvent, ISessionsProvidersService } from '../../../sessions/browser/sessionsProvidersService.js';
import { AgentHostFilterService } from '../../browser/agentHostFilterService.js';
import { AgentHostFilterConnectionStatus } from '../../common/agentHostFilter.js';

class StubRemoteProvider {
	readonly id: string;
	readonly label: string;
	readonly remoteAddress: string;
	private readonly _status;
	readonly connectionStatus: IObservable<RemoteAgentHostConnectionStatus>;

	constructor(address: string, label: string, status: RemoteAgentHostConnectionStatus = RemoteAgentHostConnectionStatus.connected) {
		this.id = `agenthost-${address}`;
		this.label = label;
		this.remoteAddress = address;
		this._status = observableValue<RemoteAgentHostConnectionStatus>('status', status);
		this.connectionStatus = this._status;
	}

	setStatus(status: RemoteAgentHostConnectionStatus): void {
		this._status.set(status, undefined);
	}
}

class StubSessionsProvidersService implements Partial<ISessionsProvidersService> {
	declare readonly _serviceBrand: undefined;

	private readonly _providers = new Map<string, ISessionsProvider>();
	private readonly _onDidChangeProviders = new Emitter<ISessionsProvidersChangeEvent>();
	readonly onDidChangeProviders = this._onDidChangeProviders.event;

	registerProvider(provider: ISessionsProvider): IDisposable {
		this._providers.set(provider.id, provider);
		this._onDidChangeProviders.fire({ added: [provider], removed: [] });
		return toDisposable(() => {
			if (this._providers.delete(provider.id)) {
				this._onDidChangeProviders.fire({ added: [], removed: [provider] });
			}
		});
	}

	getProviders(): ISessionsProvider[] {
		return Array.from(this._providers.values());
	}

	getProvider<T extends ISessionsProvider>(providerId: string): T | undefined {
		return this._providers.get(providerId) as T | undefined;
	}
}

class StubRemoteAgentHostService implements Partial<IRemoteAgentHostService> {
	declare readonly _serviceBrand: undefined;
	reconnect(_address: string): void { /* noop */ }
}

function pid(address: string): string {
	return `agenthost-${address}`;
}

suite('AgentHostFilterService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(providers: StubSessionsProvidersService, storage = store.add(new InMemoryStorageService())) {
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ISessionsProvidersService, providers as unknown as ISessionsProvidersService);
		instantiationService.stub(IRemoteAgentHostService, new StubRemoteAgentHostService() as unknown as IRemoteAgentHostService);
		instantiationService.stub(IStorageService, storage);
		return store.add(instantiationService.createInstance(AgentHostFilterService));
	}

	test('defaults to undefined when no selection persisted and no hosts', () => {
		const providers = new StubSessionsProvidersService();
		const service = createService(providers);
		assert.strictEqual(service.selectedProviderId, undefined);
		assert.deepStrictEqual([...service.hosts], []);
	});

	test('defaults based on platform when none persisted', () => {
		const providers = new StubSessionsProvidersService();
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:9999', 'Host B') as unknown as ISessionsProvider));
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A', RemoteAgentHostConnectionStatus.disconnected) as unknown as ISessionsProvider));
		const service = createService(providers);
		assert.strictEqual(service.selectedProviderId, isWeb ? pid('localhost:4321') : undefined);
	});

	test('surfaces registered remote providers with their connection status', () => {
		const providers = new StubSessionsProvidersService();
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A') as unknown as ISessionsProvider));
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:9999', 'Host B', RemoteAgentHostConnectionStatus.disconnected) as unknown as ISessionsProvider));
		const service = createService(providers);

		const hosts = [...service.hosts].map(h => ({ label: h.label, status: h.status, providerId: h.providerId }));
		assert.deepStrictEqual(hosts, [
			{ label: 'Host A', status: AgentHostFilterConnectionStatus.Connected, providerId: pid('localhost:4321') },
			{ label: 'Host B', status: AgentHostFilterConnectionStatus.Disconnected, providerId: pid('localhost:9999') },
		]);
	});

	test('updates when a provider status changes', () => {
		const providers = new StubSessionsProvidersService();
		const hostA = new StubRemoteProvider('localhost:4321', 'Host A');
		store.add(providers.registerProvider(hostA as unknown as ISessionsProvider));
		const service = createService(providers);

		let events = 0;
		store.add(service.onDidChange(() => events++));

		hostA.setStatus(RemoteAgentHostConnectionStatus.disconnected);
		assert.strictEqual(service.hosts[0].status, AgentHostFilterConnectionStatus.Disconnected);
		assert.strictEqual(events, 1);
	});

	test('setSelectedProviderId fires change and restores on every platform', () => {
		const providers = new StubSessionsProvidersService();
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A') as unknown as ISessionsProvider));
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:9999', 'Host B') as unknown as ISessionsProvider));
		const storage = store.add(new InMemoryStorageService());
		const service = createService(providers, storage);

		let events = 0;
		store.add(service.onDidChange(() => events++));

		service.setSelectedProviderId(pid('localhost:9999'));
		assert.strictEqual(service.selectedProviderId, pid('localhost:9999'));
		assert.deepStrictEqual(service.scope, { kind: 'host', providerId: pid('localhost:9999') });
		assert.strictEqual(events, 1);

		// Recreate service with same storage — a host scope restores everywhere.
		const service2 = createService(providers, storage);
		assert.strictEqual(service2.selectedProviderId, pid('localhost:9999'));
	});

	test('fallback selection depends on platform when selected host disappears', () => {
		const providers = new StubSessionsProvidersService();
		const hostA = new StubRemoteProvider('localhost:4321', 'Host A');
		const hostB = new StubRemoteProvider('localhost:9999', 'Host B');
		store.add(providers.registerProvider(hostA as unknown as ISessionsProvider));
		const hostBReg = providers.registerProvider(hostB as unknown as ISessionsProvider);
		const service = createService(providers);

		service.setSelectedProviderId(pid('localhost:9999'));
		assert.strictEqual(service.selectedProviderId, pid('localhost:9999'));

		// Remove Host B — selection falls back only on web.
		hostBReg.dispose();
		assert.strictEqual(service.selectedProviderId, isWeb ? pid('localhost:4321') : undefined);
	});

	test('setSelectedProviderId ignores unknown hosts', () => {
		const providers = new StubSessionsProvidersService();
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A') as unknown as ISessionsProvider));
		const service = createService(providers);
		service.setSelectedProviderId(pid('localhost:4321'));
		assert.strictEqual(service.selectedProviderId, pid('localhost:4321'));
		service.setSelectedProviderId('agenthost-nonexistent');
		assert.strictEqual(service.selectedProviderId, pid('localhost:4321'));
	});

	test('scope defaults to all and setScope host is ignored for unknown hosts', () => {
		const providers = new StubSessionsProvidersService();
		const service = createService(providers);
		assert.deepStrictEqual(service.scope, { kind: 'all' });
		service.setScope({ kind: 'host', providerId: 'agenthost-nonexistent' });
		assert.deepStrictEqual(service.scope, { kind: 'all' });
	});

	test('local scope persists on desktop and normalizes to a host on web', () => {
		const providers = new StubSessionsProvidersService();
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A') as unknown as ISessionsProvider));
		const storage = store.add(new InMemoryStorageService());
		const service = createService(providers, storage);

		service.setScope({ kind: 'local' });
		assert.deepStrictEqual(service.scope, { kind: 'local' });
		assert.strictEqual(service.selectedProviderId, undefined);

		// A fresh service revalidates against the host list: web insists on a
		// concrete host, desktop keeps the local scope.
		const service2 = createService(providers, storage);
		assert.deepStrictEqual(service2.scope, isWeb ? { kind: 'host', providerId: pid('localhost:4321') } : { kind: 'local' });
	});

	test('legacy selectedProviderId storage migrates to a host scope', () => {
		const providers = new StubSessionsProvidersService();
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A') as unknown as ISessionsProvider));
		const storage = store.add(new InMemoryStorageService());
		storage.store('sessions.agentHostFilter.selectedProviderId', pid('localhost:4321'), StorageScope.PROFILE, StorageTarget.USER);

		const service = createService(providers, storage);
		assert.deepStrictEqual(service.scope, { kind: 'host', providerId: pid('localhost:4321') });
		assert.strictEqual(service.selectedProviderId, pid('localhost:4321'));
	});

	test('desktop keeps a persisted host scope while no providers have registered yet', function () {
		if (isWeb) {
			this.skip(); // web normalizes to the first host / all immediately
		}
		const providers = new StubSessionsProvidersService();
		const storage = store.add(new InMemoryStorageService());
		storage.store('sessions.agentHostFilter.scope', JSON.stringify({ kind: 'host', providerId: pid('localhost:4321') }), StorageScope.PROFILE, StorageTarget.USER);

		// No hosts known at construction: the scope must survive the startup
		// window instead of resetting before the provider registers.
		const service = createService(providers, storage);
		assert.deepStrictEqual(service.scope, { kind: 'host', providerId: pid('localhost:4321') });

		// The provider arrives — scope still stands...
		const registration = providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A') as unknown as ISessionsProvider);
		assert.deepStrictEqual(service.scope, { kind: 'host', providerId: pid('localhost:4321') });

		// ...and once a host the service has seen goes away, it resets to all.
		registration.dispose();
		assert.deepStrictEqual(service.scope, { kind: 'all' });
	});

	test('scope resets when the scoped host disappears but others remain', () => {
		const providers = new StubSessionsProvidersService();
		const hostA = new StubRemoteProvider('localhost:4321', 'Host A');
		const hostB = new StubRemoteProvider('localhost:9999', 'Host B');
		store.add(providers.registerProvider(hostA as unknown as ISessionsProvider));
		const hostBReg = providers.registerProvider(hostB as unknown as ISessionsProvider);
		const service = createService(providers);

		service.setScope({ kind: 'host', providerId: pid('localhost:9999') });
		hostBReg.dispose();
		assert.deepStrictEqual(service.scope, isWeb ? { kind: 'host', providerId: pid('localhost:4321') } : { kind: 'all' });
	});

	test('an explicitly picked all scope survives new hosts and a reload', () => {
		const providers = new StubSessionsProvidersService();
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A') as unknown as ISessionsProvider));
		const storage = store.add(new InMemoryStorageService());
		const service = createService(providers, storage);

		service.setScope({ kind: 'all' });
		assert.deepStrictEqual(service.scope, { kind: 'all' });
		assert.strictEqual(service.selectedProviderId, undefined);

		// A host registering afterwards must not steal the union scope.
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:9999', 'Host B') as unknown as ISessionsProvider));
		assert.deepStrictEqual(service.scope, { kind: 'all' });

		const service2 = createService(providers, storage);
		assert.deepStrictEqual(service2.scope, { kind: 'all' });
	});

	test('a persisted all scope is honored instead of the first host', () => {
		const providers = new StubSessionsProvidersService();
		store.add(providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A') as unknown as ISessionsProvider));
		const storage = store.add(new InMemoryStorageService());
		storage.store('sessions.agentHostFilter.scope', JSON.stringify({ kind: 'all' }), StorageScope.PROFILE, StorageTarget.USER);

		const service = createService(providers, storage);
		assert.deepStrictEqual(service.scope, { kind: 'all' });
		assert.strictEqual(service.selectedProviderId, undefined);
	});

	test('web resolves the default scope to the first host once one registers', function () {
		if (!isWeb) {
			this.skip(); // desktop stays on `all` — see the desktop startup test above
		}
		const providers = new StubSessionsProvidersService();
		const service = createService(providers);

		// Nothing known yet: `all` is a placeholder here, not a pick.
		assert.deepStrictEqual(service.scope, { kind: 'all' });

		store.add(providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A') as unknown as ISessionsProvider));
		assert.deepStrictEqual(service.scope, { kind: 'host', providerId: pid('localhost:4321') });
	});

	test('web keeps falling back to a host after the last one disappeared', function () {
		if (!isWeb) {
			this.skip(); // desktop falls back to `all` and stays there
		}
		const providers = new StubSessionsProvidersService();
		const hostAReg = providers.registerProvider(new StubRemoteProvider('localhost:4321', 'Host A') as unknown as ISessionsProvider);
		const hostBReg = providers.registerProvider(new StubRemoteProvider('localhost:9999', 'Host B') as unknown as ISessionsProvider);
		const service = createService(providers);

		service.setScope({ kind: 'host', providerId: pid('localhost:9999') });
		hostBReg.dispose();
		assert.deepStrictEqual(service.scope, { kind: 'host', providerId: pid('localhost:4321') });

		hostAReg.dispose();
		// Nothing left to scope to — but this `all` is not a pick, so the
		// next host that registers wins over it.
		assert.deepStrictEqual(service.scope, { kind: 'all' });

		store.add(providers.registerProvider(new StubRemoteProvider('localhost:5555', 'Host C') as unknown as ISessionsProvider));
		assert.deepStrictEqual(service.scope, { kind: 'host', providerId: pid('localhost:5555') });
	});
});
