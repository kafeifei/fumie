/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullTelemetryService } from '../../../telemetry/common/telemetryUtils.js';
import { AgentHostProtocolClient } from '../../browser/agentHostProtocolClient.js';
import { IAgentHostResourceService } from '../../common/agentHostResourceService.js';
import { PROTOCOL_VERSION } from '../../common/state/protocol/version/registry.js';
import type { CreateSessionParams } from '../../common/state/protocol/channels-session/commands.js';
import type { IProtocolTransport } from '../../common/state/sessionTransport.js';
import type { JsonRpcRequest, ProtocolMessage } from '../../common/state/sessionProtocol.js';
import { hasKey } from '../../../../base/common/types.js';

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
}

/**
 * The protocol client only needs the resource service to exist for these
 * tests: `createSession` without active-client customizations never reaches
 * a permission gate.
 */
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
 * A remote client must hand the host the model the user picked.
 *
 * The model is not cosmetic on this path: the provider derives the session's
 * transport from it, so a dropped selection makes the host fall back to a
 * default it may hold no credentials for. The Electron client escapes this by
 * rerouting model-carrying configs through a Management IPC channel that only
 * exists in `electron-browser`; every remote client (web, `--agent-host-tunnel`,
 * Remote Control) speaks AHP and has no such escape.
 */
suite('AgentHostProtocolClient - createSession model', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function createConnectedClient(): Promise<{ client: AgentHostProtocolClient; transport: RecordingTransport }> {
		const transport = disposables.add(new RecordingTransport());
		const client = disposables.add(new AgentHostProtocolClient(
			'test.example:1234',
			transport,
			undefined,
			undefined,
			undefined,
			new NullLogService(),
			createResourceServiceStub(),
			new TestConfigurationService(),
			NullTelemetryService,
		));
		const connectPromise = client.connect();
		while (transport.sentMessages.length === 0) {
			await Promise.resolve();
		}
		const initialize = transport.sentMessages[0] as JsonRpcRequest;
		transport.fireMessage({
			jsonrpc: '2.0',
			id: initialize.id,
			result: { protocolVersion: PROTOCOL_VERSION, serverSeq: 0, snapshots: [] },
		});
		await connectPromise;
		return { client, transport };
	}

	function findCreateSession(transport: RecordingTransport): JsonRpcRequest {
		const request = transport.sentMessages.find((message): message is JsonRpcRequest =>
			hasKey(message, { method: true }) && message.method === 'createSession');
		assert.ok(request, 'Expected a createSession request on the wire');
		return request;
	}

	test('forwards the selected model and its config to the host', async () => {
		const { client, transport } = await createConnectedClient();
		const session = URI.parse('ahp-session:/claude-remote');

		const creation = client.createSession({
			provider: 'claude',
			session,
			model: { id: 'customendpoint/Example/claude-fable-5', config: { thinkingLevel: 'high' } },
		});

		const request = findCreateSession(transport);
		const params = request.params as CreateSessionParams;
		assert.deepStrictEqual(params.model, {
			id: 'customendpoint/Example/claude-fable-5',
			config: { thinkingLevel: 'high' },
		});

		transport.fireMessage({ jsonrpc: '2.0', id: request.id, result: null });
		assert.strictEqual(await creation, session);
	});

	test('omits the model when the caller made no selection', async () => {
		const { client, transport } = await createConnectedClient();
		const session = URI.parse('ahp-session:/claude-default');

		const creation = client.createSession({ provider: 'claude', session });

		const request = findCreateSession(transport);
		assert.strictEqual((request.params as CreateSessionParams).model, undefined);

		transport.fireMessage({ jsonrpc: '2.0', id: request.id, result: null });
		assert.strictEqual(await creation, session);
	});
});
