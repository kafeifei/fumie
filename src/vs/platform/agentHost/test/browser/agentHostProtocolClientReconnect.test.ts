/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../log/common/log.js';
import { NullTelemetryService } from '../../../telemetry/common/telemetryUtils.js';
import { AgentHostClientState, AgentHostProtocolClient } from '../../browser/agentHostProtocolClient.js';
import { IAgentHostResourceService } from '../../common/agentHostResourceService.js';
import { PROTOCOL_VERSION } from '../../common/state/protocol/version/registry.js';
import type { IProtocolTransport } from '../../common/state/sessionTransport.js';
import type { JsonRpcRequest, ProtocolMessage } from '../../common/state/sessionProtocol.js';

type ProtocolTransportMessage = Parameters<IProtocolTransport['send']>[0];

class RecordingTransport extends Disposable implements IProtocolTransport {
	private readonly _onMessage = this._register(new Emitter<ProtocolMessage>());
	readonly onMessage = this._onMessage.event;

	private readonly _onClose = this._register(new Emitter<void>());
	readonly onClose = this._onClose.event;

	readonly sentMessages: ProtocolTransportMessage[] = [];

	send(message: ProtocolTransportMessage): void {
		this.sentMessages.push(message);
	}

	fireMessage(message: ProtocolMessage): void {
		this._onMessage.fire(message);
	}

	/** The socket went away without a close frame, the way a relay kills one. */
	fireClose(): void {
		this._onClose.fire();
	}
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
 * The bug this guards: a phone that was locked, or a laptop whose lid was
 * closed, comes back to a socket that died while its timers were frozen. The
 * backoff the client was waiting out belongs to the network that went away, so
 * the user watched a dead client for as long as that delay had grown — up to
 * `RECONNECT_MAX_DELAY_MS`, half a minute, on a page that looks broken.
 *
 * Upstream has no equivalent: `PersistentConnection` waits out its own ladder
 * (`remoteAgentConnection.ts:668`) and the only thing that shortens it is a
 * "Reconnect Now" button a user has to find (`remote.ts:852`). A phone has no
 * such button, so the browser's own signal has to serve as one.
 */
suite('AgentHostProtocolClient - reconnecting after a wake', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => sinon.restore());

	async function createReconnectableClient(): Promise<{
		client: AgentHostProtocolClient;
		transports: RecordingTransport[];
	}> {
		const transports: RecordingTransport[] = [];
		const factory = () => {
			const transport = disposables.add(new RecordingTransport());
			transports.push(transport);
			return transport;
		};
		const client = disposables.add(new AgentHostProtocolClient(
			'test.example:1234',
			factory,
			{ hasHighLoad: () => false },
			undefined,
			undefined,
			new NullLogService(),
			createResourceServiceStub(),
			new TestConfigurationService(),
			NullTelemetryService,
		));

		const connectPromise = client.connect();
		while (transports[0].sentMessages.length === 0) {
			await Promise.resolve();
		}
		const initialize = transports[0].sentMessages[0] as JsonRpcRequest;
		transports[0].fireMessage({
			jsonrpc: '2.0',
			id: initialize.id,
			result: { protocolVersion: PROTOCOL_VERSION, serverSeq: 0, snapshots: [] },
		});
		await connectPromise;
		return { client, transports };
	}

	async function finishReconnect(client: AgentHostProtocolClient, transport: RecordingTransport): Promise<void> {
		const resume = transport.sentMessages.find((message): message is JsonRpcRequest =>
			(message as JsonRpcRequest).method === 'reconnect');
		assert.ok(resume);
		assert.strictEqual((resume.params as { clientId: string }).clientId, client.clientId);
		transport.fireMessage({ jsonrpc: '2.0', id: resume.id, result: { type: 'replay', actions: [], missing: [] } });
		for (let i = 0; i < 20 && client.connectionState !== AgentHostClientState.Connected; i++) {
			await Promise.resolve();
		}
		assert.strictEqual(client.connectionState, AgentHostClientState.Connected);
	}

	test('becoming visible resumes a closed connection immediately and completes the handshake', async () => {
		const { client, transports } = await createReconnectableClient();
		const hidden = sinon.stub(mainWindow.document, 'hidden').get(() => true);
		transports[0].fireClose();
		mainWindow.document.dispatchEvent(new Event('visibilitychange'));
		assert.strictEqual(transports.length, 1, 'a hidden page must not accelerate retries');
		hidden.get(() => false);
		mainWindow.document.dispatchEvent(new Event('visibilitychange'));
		assert.strictEqual(transports.length, 2);
		await finishReconnect(client, transports[1]);
	});

	test('a silent socket with no close event reconnects after frozen timers resume', async () => {
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const { client, transports } = await createReconnectableClient();
		const hidden = sinon.stub(mainWindow.document, 'hidden').get(() => true);
		// Move wall time without delivering timers or a socket close event.
		clock.setSystemTime(Date.now() + 120_000);
		hidden.get(() => false);
		mainWindow.document.dispatchEvent(new Event('visibilitychange'));
		assert.strictEqual(transports.length, 1, 'visibility alone is not proof that an open socket is dead');
		await clock.tickAsync(26_000);
		assert.strictEqual(transports.length, 2, 'liveness timeout plus the first retry must recover a half-open socket');
		await finishReconnect(client, transports[1]);
	});

	test('a healthy socket survives becoming visible and replying to liveness probes', async () => {
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		const { client, transports } = await createReconnectableClient();
		sinon.stub(mainWindow.document, 'hidden').get(() => false);
		mainWindow.document.dispatchEvent(new Event('visibilitychange'));
		for (let i = 0; i < 6; i++) {
			await clock.tickAsync(5_000);
			const ping = transports[0].sentMessages.filter((message): message is JsonRpcRequest =>
				(message as JsonRpcRequest).method === 'ping').at(-1);
			assert.ok(ping);
			transports[0].fireMessage({ jsonrpc: '2.0', id: ping.id, result: {} });
		}
		assert.strictEqual(transports.length, 1);
		assert.strictEqual(client.connectionState, AgentHostClientState.Connected);
	});

	test('coming back online retries at once instead of waiting out the backoff', async () => {
		const { transports } = await createReconnectableClient();

		transports[0].fireClose();
		assert.strictEqual(
			transports.length, 1,
			'the client must be waiting on its backoff, not already retrying');

		mainWindow.dispatchEvent(new Event('online'));

		assert.strictEqual(
			transports.length, 2,
			'coming back online must start a fresh attempt without waiting out the backoff');

		// And it is a real resume, not a fresh connection: the same client id
		// with the last sequence it saw, so the host replays what was missed.
		const resume = transports[1].sentMessages.find((message): message is JsonRpcRequest =>
			(message as JsonRpcRequest).method === 'reconnect');
		assert.ok(resume, 'the retry must resume the session rather than initialize a new one');
	});

	test('coming back online while connected changes nothing', async () => {
		const { transports } = await createReconnectableClient();

		mainWindow.dispatchEvent(new Event('online'));

		assert.strictEqual(
			transports.length, 1,
			'a healthy connection must not be torn down by an online event');
	});
});
