/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ILogService } from '../../../log/common/log.js';

/**
 * The ACP wire, and nothing else.
 *
 * This module owns exactly two things: turning a launch command into a
 * bidirectional JSON-RPC transport, and wrapping the official
 * `@agentclientprotocol/sdk` client app around it. It never inspects which
 * agent is on the other end — every agent-specific fact (command, args, env)
 * arrives as data in {@link IAcpLaunchSpec}, and every agent-specific
 * behaviour is negotiated through the protocol's own capability handshake.
 * A branch on an agent's name in this file would be an architecture failure.
 */

/** How to start an ACP agent subprocess. Supplied by the agent catalog. */
export interface IAcpLaunchSpec {
	/** Executable resolved from `PATH` (or an absolute path). */
	readonly command: string;
	readonly args: readonly string[];
	/** Extra environment entries layered over the agent host's own environment. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Working directory for the subprocess. */
	readonly cwd: string;
}

/**
 * A live bidirectional ACP byte channel. Produced by
 * {@link spawnAcpTransport} in production and by an in-process pair in tests,
 * which is why the connection never spawns anything itself.
 */
export interface IAcpTransport extends IDisposable {
	readonly stream: acp.Stream;
	/** Human-readable identity of the far end, for error messages and logs. */
	readonly description: string;
	/** Fires once when the far end goes away (process exit, stream close). */
	readonly onDidClose: Event<string | undefined>;
}

export type AcpTransportFactory = (spec: IAcpLaunchSpec) => Promise<IAcpTransport>;

/** Client-side handlers the owning agent supplies for the lifetime of a connection. */
export interface IAcpConnectionHandlers {
	/** Streamed progress for a session (`session/update`). */
	readonly onSessionUpdate: (notification: acp.SessionNotification) => void;
	/** Interactive permission ask (`session/request_permission`). */
	readonly onRequestPermission: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
	/** The agent process went away without being disposed. */
	readonly onUnexpectedClose?: (reason: string | undefined) => void;
}

export interface IAcpConnectionOptions {
	readonly launch: IAcpLaunchSpec;
	readonly handlers: IAcpConnectionHandlers;
	/** Overridden by tests to connect an in-process agent instead of spawning one. */
	readonly transportFactory?: AcpTransportFactory;
	/** Reported to the agent in `initialize` so agents can log who is driving them. */
	readonly clientName: string;
	readonly clientVersion: string;
}

/**
 * Capabilities the client half of this connector actually implements.
 *
 * Declared honestly and centrally: Fumie's ACP client does not proxy the
 * filesystem (agents run locally with direct disk access and Fumie's own
 * changeset watcher observes the result), does not host ACP terminals, and does
 * not implement the elicitation or NES extensions. Advertising any of these
 * would invite requests this connector would then have to fail.
 */
const CLIENT_CAPABILITIES: acp.ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	terminal: false,
};

/**
 * A connected ACP agent: one subprocess, one JSON-RPC peer, zero or more
 * protocol sessions.
 */
export class AcpConnection extends Disposable {

	/**
	 * Spawns (or attaches to) an agent and completes the `initialize`
	 * handshake. Rejects if the agent cannot be started or speaks a protocol
	 * version this connector does not implement.
	 */
	static async connect(options: IAcpConnectionOptions, logService: ILogService): Promise<AcpConnection> {
		const factory = options.transportFactory ?? (spec => spawnAcpTransport(spec, logService));
		const transport = await factory(options.launch);
		let connection: AcpConnection | undefined;
		try {
			connection = new AcpConnection(transport, options, logService);
			await connection._initialize();
			return connection;
		} catch (error) {
			// Disposing the connection also disposes the transport it adopted; if
			// construction itself failed, the transport is still ours to close.
			if (connection) {
				connection.dispose();
			} else {
				transport.dispose();
			}
			throw error;
		}
	}

	private readonly _connection: acp.ClientConnection;
	private _initializeResponse: acp.InitializeResponse | undefined;
	private _closeReason: string | undefined;
	private _disposed = false;

	private constructor(
		private readonly _transport: IAcpTransport,
		private readonly _options: IAcpConnectionOptions,
		private readonly _logService: ILogService,
	) {
		super();
		const app = acp.client({ name: _options.clientName })
			.onNotification(acp.methods.client.session.update, ctx => {
				_options.handlers.onSessionUpdate(ctx.params);
			})
			.onRequest(acp.methods.client.session.requestPermission, ctx => _options.handlers.onRequestPermission(ctx.params));
		this._connection = app.connect(_transport.stream);
		this._register(_transport.onDidClose(reason => {
			this._closeReason = reason;
			if (!this._disposed) {
				this._options.handlers.onUnexpectedClose?.(reason);
			}
		}));
		this._register(toDisposable(() => {
			this._disposed = true;
			this._connection.close();
			_transport.dispose();
		}));
	}

	/** Capabilities the agent advertised during `initialize`. */
	get agentCapabilities(): acp.AgentCapabilities | undefined {
		return this._initializeResponse?.agentCapabilities;
	}

	/** Authentication methods the agent offers, when it requires sign-in. */
	get authMethods(): readonly acp.AuthMethod[] {
		return this._initializeResponse?.authMethods ?? [];
	}

	/** Name and version the agent reported, when it reported one. */
	get agentInfo(): acp.Implementation | undefined {
		return this._initializeResponse?.agentInfo ?? undefined;
	}

	get description(): string {
		return this._transport.description;
	}

	/** Whether the agent supports resuming a session (`session/load`). */
	get supportsLoadSession(): boolean {
		return this.agentCapabilities?.loadSession === true;
	}

	/** Creates a protocol session rooted at `cwd`. */
	async newSession(cwd: string, additionalDirectories: readonly string[] = []): Promise<acp.NewSessionResponse> {
		return this._connection.agent.request(acp.methods.agent.session.new, {
			cwd,
			mcpServers: [],
			...(additionalDirectories.length ? { additionalDirectories: [...additionalDirectories] } : {}),
		});
	}

	/**
	 * Re-attaches to an existing session, replaying its transcript.
	 *
	 * The agent streams the entire prior conversation back as ordinary
	 * `session/update` notifications — the same shapes live streaming uses —
	 * and only then answers this request. So by the time the returned promise
	 * settles, every replayed update has already been handed to
	 * {@link IAcpConnectionHandlers.onSessionUpdate}; the caller decides there
	 * whether a given update is history or news.
	 *
	 * Only legal when {@link supportsLoadSession} is true; an agent that never
	 * advertised the capability is entitled to reject the call.
	 */
	async loadSession(sessionId: string, cwd: string, additionalDirectories: readonly string[] = []): Promise<acp.LoadSessionResponse> {
		// The spec lets an agent answer `session/load` with no body at all, so a
		// missing response means "loaded, nothing further to report" rather than
		// a protocol violation.
		const response: acp.LoadSessionResponse | undefined = await this._connection.agent.request(acp.methods.agent.session.load, {
			sessionId,
			cwd,
			mcpServers: [],
			...(additionalDirectories.length ? { additionalDirectories: [...additionalDirectories] } : {}),
		});
		return response ?? {};
	}

	/**
	 * Sets one session configuration option, answering with the agent's full
	 * refreshed option set.
	 *
	 * The wire call and nothing more: which options exist, what they mean and
	 * which values are legal are all the agent's to declare and the caller's to
	 * read off that declaration.
	 */
	async setConfigOption(sessionId: string, configId: string, value: string): Promise<acp.SetSessionConfigOptionResponse> {
		return this._connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
	}

	/**
	 * Runs one prompt turn. Resolves with the agent's stop reason once the turn
	 * ends — including when it ends because {@link cancel} was called.
	 */
	async prompt(sessionId: string, prompt: readonly acp.ContentBlock[]): Promise<acp.PromptResponse> {
		return this._connection.agent.request(acp.methods.agent.session.prompt, {
			sessionId,
			prompt: [...prompt],
		});
	}

	/**
	 * Asks the agent to stop the current turn.
	 *
	 * `session/cancel` is a notification, so this returns as soon as it is
	 * queued; the authoritative end-of-turn is the pending `session/prompt`
	 * settling with `stopReason: "cancelled"`.
	 */
	async cancel(sessionId: string): Promise<void> {
		if (this._disposed) {
			return;
		}
		try {
			await this._connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
		} catch (error) {
			this._logService.warn(`[ACP] Failed to cancel ${sessionId} on ${this.description}`, error);
		}
	}

	/** Forwards a credential to an agent that advertised an auth method. */
	async authenticate(methodId: string): Promise<void> {
		await this._connection.agent.request(acp.methods.agent.authenticate, { methodId });
	}

	private async _initialize(): Promise<void> {
		const response = await this._connection.agent.request(acp.methods.agent.initialize, {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: CLIENT_CAPABILITIES,
			clientInfo: { name: this._options.clientName, version: this._options.clientVersion },
		});
		// The agent answers with the version it will actually speak. A newer
		// agent that cannot fall back to v1 is unusable rather than
		// half-working, so refuse it here instead of misreading its frames.
		if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
			throw new Error(`${this.description} speaks ACP protocol version ${String(response.protocolVersion)}; this connector implements version ${String(acp.PROTOCOL_VERSION)}.`);
		}
		this._initializeResponse = response;
		this._logService.trace(`[ACP] Connected to ${this.description} (agent=${response.agentInfo?.name ?? 'unknown'})`);
	}

	/** Reason the transport reported for an unexpected close, when it closed. */
	get closeReason(): string | undefined {
		return this._closeReason;
	}
}

/**
 * Starts an agent subprocess and exposes its stdio as an ACP transport.
 *
 * `stderr` is drained into the log rather than the protocol stream: ACP frames
 * travel on stdout only, and an agent that writes a banner or a stack trace to
 * stderr must not corrupt the JSON-RPC channel.
 */
export async function spawnAcpTransport(spec: IAcpLaunchSpec, logService: ILogService): Promise<IAcpTransport> {
	const description = [spec.command, ...spec.args].join(' ');
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(spec.command, [...spec.args], {
			cwd: spec.cwd,
			env: { ...process.env, ...spec.env },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			// Node refuses to execute `.cmd` / `.bat` without a shell (the
			// CVE-2024-27980 hardening), and on Windows every one of these agents
			// is exactly that: `npx` and the agent CLIs users install themselves all
			// arrive as batch shims. Generic to the launcher, not to any agent.
			shell: isWindows,
		});
	} catch (error) {
		throw new Error(`Could not start the ACP agent '${description}': ${errorMessage(error)}`);
	}

	const started = new DeferredPromise<void>();
	const onceStarted = () => started.complete();
	const onceFailed = (error: Error) => started.error(new Error(spawnFailureMessage(spec.command, error)));
	child.once('spawn', onceStarted);
	child.once('error', onceFailed);
	try {
		await started.p;
	} finally {
		child.off('spawn', onceStarted);
		child.off('error', onceFailed);
	}

	const onDidClose = new Emitter<string | undefined>();
	let closed = false;
	const reportClose = (reason: string | undefined) => {
		if (!closed) {
			closed = true;
			onDidClose.fire(reason);
		}
	};
	child.once('exit', (code, signal) => reportClose(exitDescription(description, code, signal)));
	child.once('error', error => reportClose(errorMessage(error)));
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => logService.trace(`[ACP] ${description} stderr: ${chunk.trimEnd()}`));

	return {
		description,
		stream: acp.ndJsonStream(writableFromChildStdin(child), readableFromChildStdout(child)),
		onDidClose: onDidClose.event,
		dispose: () => {
			onDidClose.dispose();
			if (child.exitCode === null && child.signalCode === null) {
				child.kill();
			}
		},
	};
}

/**
 * Bridges the process's `stdout` into a web `ReadableStream`.
 *
 * Written by hand rather than via `Readable.toWeb` so the stream carries the
 * DOM `ReadableStream` type the ACP SDK expects, without a cast across the
 * Node/DOM stream-type boundary.
 */
function readableFromChildStdout(child: ChildProcessWithoutNullStreams): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			child.stdout.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
			child.stdout.once('end', () => safeClose(controller));
			child.stdout.once('error', error => safeError(controller, error));
			child.once('exit', () => safeClose(controller));
		},
		cancel() {
			child.stdout.destroy();
		},
	});
}

/** Bridges a web `WritableStream` into the process's `stdin`. */
function writableFromChildStdin(child: ChildProcessWithoutNullStreams): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise<void>((resolve, reject) => {
				// A dead pipe is a closed connection, not a crash: the transport's
				// `onDidClose` already reported the exit, so drop the frame.
				if (child.stdin.destroyed || child.stdin.writableEnded) {
					resolve();
					return;
				}
				child.stdin.write(chunk, error => error ? reject(error) : resolve());
			});
		},
		close() {
			if (!child.stdin.destroyed) {
				child.stdin.end();
			}
		},
		abort() {
			child.stdin.destroy();
		},
	});
}

function safeClose(controller: ReadableStreamDefaultController<Uint8Array>): void {
	try {
		controller.close();
	} catch {
		// Already closed or errored — the first terminal signal wins.
	}
}

function safeError(controller: ReadableStreamDefaultController<Uint8Array>, error: unknown): void {
	try {
		controller.error(error);
	} catch {
		// Already closed or errored — the first terminal signal wins.
	}
}

function spawnFailureMessage(command: string, error: Error): string {
	if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
		return `The ACP agent '${command}' was not found on PATH. Install it and make sure '${command}' is runnable from a terminal.`;
	}
	return `Could not start the ACP agent '${command}': ${error.message}`;
}

function exitDescription(description: string, code: number | null, signal: NodeJS.Signals | null): string {
	if (signal) {
		return `${description} was terminated by ${signal}.`;
	}
	return `${description} exited with code ${String(code ?? 0)}.`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
