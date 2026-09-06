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
import { AbstractLogger, ILogService, LogLevel } from '../../../log/common/log.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { NullTelemetryService } from '../../../telemetry/common/telemetryUtils.js';
import { AgentHostProtocolClient } from '../../browser/agentHostProtocolClient.js';
import { IAgentHostResourceService } from '../../common/agentHostResourceService.js';
import { AhpErrorCodes } from '../../common/state/protocol/errors.js';
import { PROTOCOL_VERSION } from '../../common/state/protocol/version/registry.js';
import { ROOT_STATE_URI } from '../../common/state/sessionState.js';
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
 * Records the rendered log line only. A logger is free to drop the extra
 * arguments of `warn(message, ...args)` — and the console renders an object
 * argument as `Object` — so anything a reader needs has to be in the message.
 */
class RecordingLogService extends AbstractLogger implements ILogService {
	declare readonly _serviceBrand: undefined;
	readonly warnings: string[] = [];
	readonly traces: string[] = [];

	constructor() {
		super();
		this.setLevel(LogLevel.Trace);
	}

	log(_level: LogLevel, _message: string): void { }
	trace(message: string): void { this.traces.push(message); }
	debug(_message: string): void { }
	info(_message: string): void { }
	warn(message: string): void { this.warnings.push(message); }
	error(_message: string): void { }
	flush(): void { }
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
 * Opening a session probes the workspace root for optional agent config
 * files that most repositories do not have. Those misses must not read as
 * failed requests, and the failures that remain must say what went wrong.
 */
suite('AgentHostProtocolClient - failed request logging', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function createConnectedClient(): Promise<{ client: AgentHostProtocolClient; transport: RecordingTransport; logService: RecordingLogService }> {
		const transport = disposables.add(new RecordingTransport());
		const logService = disposables.add(new RecordingLogService());
		const client = disposables.add(new AgentHostProtocolClient(
			'test.example:1234',
			transport,
			undefined,
			undefined,
			undefined,
			logService,
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
		logService.warnings.length = 0;
		return { client, transport, logService };
	}

	function lastRequest(transport: RecordingTransport, method: string): JsonRpcRequest {
		const request = [...transport.sentMessages].reverse().find((message): message is JsonRpcRequest =>
			hasKey(message, { method: true }) && message.method === method);
		assert.ok(request, `Expected a ${method} request on the wire`);
		return request;
	}

	/** Answer `request` the way the host answers a path that is not there. */
	function replyNotFound(transport: RecordingTransport, request: JsonRpcRequest, message: string): void {
		transport.fireMessage({
			jsonrpc: '2.0',
			id: request.id,
			error: { code: AhpErrorCodes.NotFound, message },
		});
	}

	/** Keep the rejection off the unhandled path until the test inspects it. */
	function settled(pending: Promise<unknown>): Promise<unknown> {
		return pending.then(() => undefined, error => error);
	}

	const absentSettings = URI.file('/workspace/.claude/settings.json');
	const absentUri = absentSettings.toString();

	test('an absent optional file is not reported as a failed request', async () => {
		const { client, transport, logService } = await createConnectedClient();

		const read = settled(client.resourceRead(absentSettings));
		const resolve = settled(client.resourceResolve({ channel: ROOT_STATE_URI, uri: absentUri }));
		const watch = settled(client.createResourceWatch({ channel: ROOT_STATE_URI, uri: absentUri, recursive: false }));

		replyNotFound(transport, lastRequest(transport, 'resourceRead'), `Content not found: ${absentUri}`);
		replyNotFound(transport, lastRequest(transport, 'resourceResolve'), `Resource not found: ${absentUri}`);
		replyNotFound(transport, lastRequest(transport, 'createResourceWatch'), `Resource not found: ${absentUri}`);

		// The caller still learns the file is absent — only the warning is spared.
		for (const pending of [read, resolve, watch]) {
			assert.match(String(await pending), /not found/);
		}
		assert.deepStrictEqual(logService.warnings, []);

		// Not a warning is not the same as not recorded. These used to be
		// dropped outright, and the moment a phone with no console has to be
		// debugged from a log it copied out, a line nobody kept is a line
		// nobody can find.
		const recorded = logService.traces.filter(line => line.includes(absentUri));
		assert.strictEqual(recorded.length, 3,
			`each absence must still be written down: ${logService.traces.join(' | ')}`);
	});

	test('a resource the caller asserted exists still surfaces', async () => {
		const { client, transport, logService } = await createConnectedClient();

		const del = settled(client.resourceDelete({ channel: ROOT_STATE_URI, uri: absentUri }));
		replyNotFound(transport, lastRequest(transport, 'resourceDelete'), `Resource not found: ${absentUri}`);

		assert.match(String(await del), /not found/);
		assert.strictEqual(logService.warnings.length, 1);
	});

	test('the warning carries the code and the message', async () => {
		const { client, transport, logService } = await createConnectedClient();

		const del = settled(client.resourceDelete({ channel: ROOT_STATE_URI, uri: absentUri }));
		replyNotFound(transport, lastRequest(transport, 'resourceDelete'), `Resource not found: ${absentUri}`);
		await del;

		const [warning] = logService.warnings;
		assert.match(warning, /-32008/);
		assert.match(warning, new RegExp(`Resource not found: ${absentUri}`));
	});

	test('the warning carries the error data a code alone cannot explain', async () => {
		const { client, transport, logService } = await createConnectedClient();

		const authenticate = settled(client.resourceDelete({ channel: ROOT_STATE_URI, uri: absentUri }));
		const request = lastRequest(transport, 'resourceDelete');
		transport.fireMessage({
			jsonrpc: '2.0',
			id: request.id,
			error: {
				code: AhpErrorCodes.AuthRequired,
				message: 'Authentication required',
				data: { resources: [{ resource: 'https://api.github.com' }] },
			},
		});
		await authenticate;

		assert.match(logService.warnings[0], /https:\/\/api\.github\.com/);
	});
});
