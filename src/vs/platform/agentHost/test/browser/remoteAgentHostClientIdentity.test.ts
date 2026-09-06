/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, type DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import type { IEnvironmentService } from '../../../environment/common/environment.js';
import type { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import type { ILabelService } from '../../../label/common/label.js';
import { NullLogService } from '../../../log/common/log.js';
import { InMemoryStorageService } from '../../../storage/common/storage.js';
import { NullTelemetryService } from '../../../telemetry/common/telemetryUtils.js';
import { AgentHostProtocolClient } from '../../browser/agentHostProtocolClient.js';
import { RemoteAgentHostService } from '../../browser/remoteAgentHostServiceImpl.js';
import { IAgentHostResourceService } from '../../common/agentHostResourceService.js';
import { RemoteAgentHostsEnabledSettingId, RemoteAgentHostsSettingId, type IRawRemoteAgentHostEntry } from '../../common/remoteAgentHostService.js';
import type { ProtocolMessage } from '../../common/state/sessionProtocol.js';
import type { IProtocolTransport } from '../../common/state/sessionTransport.js';

class InertTransport extends Disposable implements IProtocolTransport {
	private readonly _onMessage = this._register(new Emitter<ProtocolMessage>());
	readonly onMessage = this._onMessage.event;

	private readonly _onClose = this._register(new Emitter<void>());
	readonly onClose = this._onClose.event;

	send(): void { }
}

function createResourceServiceStub(): IAgentHostResourceService {
	const empty = observableValue<readonly never[]>('test', []);
	const notImplemented = async () => { throw new Error('Not implemented in stub'); };
	return {
		_serviceBrand: undefined,
		check: async () => true,
		list: async () => ({ entries: [] }),
		read: notImplemented,
		write: async () => { },
		del: async () => { },
		move: async () => { },
		copy: async () => { },
		resolve: notImplemented,
		mkdir: async () => { },
		request: async () => undefined,
		pendingFor: () => empty,
		allPending: empty,
		findPending: () => undefined,
		grantImplicitRead: () => Disposable.None,
		connectionClosed: () => { },
	};
}

/**
 * A stand-in for the protocol client, so a test of what the service *hands* the
 * client does not have to open a socket to find out. The service only ever asks
 * a client to close, to report its state, and to connect.
 */
class FakeProtocolClient extends Disposable {
	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;

	private readonly _onDidChangeConnectionState = this._register(new Emitter<never>());
	readonly onDidChangeConnectionState = this._onDidChangeConnectionState.event;

	async connect(): Promise<void> { }
}

/**
 * The whole point of this harness: record the argument list the service passes
 * to `createInstance`, because the client id is the fourth of them and nothing
 * observable downstream would tell a fresh uuid from a carried one.
 */
function createRecordingServices(store: Pick<DisposableStore, 'add'>, entries: readonly IRawRemoteAgentHostEntry[]): (string | undefined)[] {
	const clientIds: (string | undefined)[] = [];
	const instantiationService = {
		createInstance: (_ctor: unknown, ..._args: unknown[]) => {
			// `(identity, transportOrFactory, loadEstimator, clientId, clientInfo)`.
			clientIds.push(_args[3] as string | undefined);
			return new FakeProtocolClient();
		},
	} as unknown as IInstantiationService;
	const configurationService = new TestConfigurationService({
		[RemoteAgentHostsEnabledSettingId]: true,
		[RemoteAgentHostsSettingId]: entries,
	});
	const labelService = { registerFormatter: (): IDisposable => Disposable.None } as unknown as ILabelService;
	const environmentService = { logsHome: URI.parse('file:///logs') } as unknown as IEnvironmentService;
	store.add(new RemoteAgentHostService(
		configurationService,
		instantiationService,
		new NullLogService(),
		labelService,
		environmentService,
		store.add(new InMemoryStorageService()),
	));
	return clientIds;
}

/**
 * The bug this guards: the client id was minted per connection and written
 * down nowhere, so every reload of the phone's page arrived at the host as a
 * brand-new client. The host keys reconnect and replay off that id, so a reload
 * could not resume the way an in-page reconnect does.
 *
 * The fix carries an id from the browser through the `chat.remoteAgentHosts`
 * entry. It is an identity and never a credential — a stable string anyone who
 * can load the page can choose — so the desktop half of these tests matters as
 * much as the phone half: an entry with no id must keep minting one.
 */
suite('remote agent host client identity', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createClient(clientId: string | undefined): AgentHostProtocolClient {
		return disposables.add(new AgentHostProtocolClient(
			'test.example:1234',
			disposables.add(new InertTransport()),
			undefined,
			clientId,
			undefined,
			new NullLogService(),
			createResourceServiceStub(),
			new TestConfigurationService(),
			NullTelemetryService,
		));
	}

	test('a client handed an id presents that id, not one of its own', () => {
		assert.strictEqual(createClient('phone-abc').clientId, 'phone-abc');
	});

	test('a client handed no id mints a fresh one for every connection', () => {
		const first = createClient(undefined).clientId;
		const second = createClient(undefined).clientId;
		assert.ok(first, 'a client with no id given must still have one');
		assert.notStrictEqual(first, second, 'two connections with no id given must not collide');
	});

	test('the id on the entry is the id the connection presents', () => {
		const clientIds = createRecordingServices(disposables, [
			{ address: 'phone.example:31546', name: 'This Mac', clientId: 'stored-in-the-browser' },
		]);
		assert.deepStrictEqual(clientIds, ['stored-in-the-browser']);
	});

	test('a reload presenting the same stored id is the same client to the host', () => {
		// Two runs of the page, one stored id: the second load must not look
		// like a stranger, which is the whole reason the id is persisted.
		const entries = [{ address: 'phone.example:31546', name: 'This Mac', clientId: 'stored-in-the-browser' }];
		const first = createRecordingServices(disposables, entries);
		const second = createRecordingServices(disposables, entries);
		assert.deepStrictEqual(second, first);
		assert.ok(first[0], 'two loads that both present nothing would agree for the wrong reason');
	});

	/**
	 * The regression that matters most. This service is registered in every
	 * Agents window on the desktop, and a shared id would make two windows one
	 * client with two transports on the host — most recent wins. Desktop entries
	 * carry no id, so nothing about them may change.
	 */
	test('an entry with no id leaves the desktop minting one per connection', () => {
		const clientIds = createRecordingServices(disposables, [
			{ address: 'desktop.example:31546', name: 'A Desktop' },
		]);
		assert.deepStrictEqual(clientIds, [undefined], 'the desktop must still get the per-connection uuid');
	});

	test('an id that is not a string is ignored rather than presented', () => {
		// The setting is user-editable text, and the entry validator is what
		// stands between a hand-typed file and the connection path.
		const clientIds = createRecordingServices(disposables, [
			{ address: 'desktop.example:31546', name: 'A Desktop', clientId: 42 as unknown as string },
		]);
		assert.deepStrictEqual(clientIds, [], 'a malformed entry must not connect at all');
	});
});
