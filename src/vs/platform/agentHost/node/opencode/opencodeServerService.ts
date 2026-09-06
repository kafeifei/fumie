/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { existsSync } from 'fs';
import { createServer, type AddressInfo } from 'net';
import { request } from 'undici';
import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { delimiter, join } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { withoutModelProviderEnvironment } from '../modelProviderEnvironment.js';
import { resolveDefaultAgentsDir } from '../fumie/agentSdkManager.js';

/**
 * The `opencode serve` process, and nothing else.
 *
 * opencode ships as a Bun binary that owns its own model loop, tools and
 * transcripts; Fumie drives it the way opencode's own TUI does — over the local
 * HTTP + SSE API its `serve` command exposes. So this module's whole job is to
 * find that binary, keep exactly one server alive per workspace root, and hand
 * out an authenticated client for it. Nothing here knows what an AHP signal is.
 *
 * One server per working directory, not per chat: opencode roots a server's
 * tools at the process `cwd` (the per-request `directory` parameter does not
 * move them), so the directory is the only thing that can distinguish two
 * servers, and every chat under the same root shares one process the way every
 * TUI tab does.
 */

/** The spawned server: no stdin, and both output streams drained into the log. */
type OpencodeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Executable name looked up on `PATH`, and the directory name under the agents dir. */
const OPENCODE_BINARY = 'opencode';

/** The user half of the server's HTTP Basic credentials; opencode fixes it. */
const OPENCODE_BASIC_AUTH_USER = 'opencode';

/** Environment variable opencode reads its server password from. */
const OPENCODE_SERVER_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';

/** How long a server gets to bind its port and answer the health probe. */
const OPENCODE_START_TIMEOUT_MS = 60_000;

/** One frame of opencode's global `/event` stream. */
export interface IOpencodeEvent {
	/** Event name, e.g. `message.part.delta` or `permission.v2.asked`. */
	readonly type: string;
	readonly properties: Record<string, unknown>;
}

/**
 * A live `opencode serve` process: one HTTP client, one global event stream.
 *
 * The stream is global rather than per session, which is exactly what makes
 * subagents observable — a delegated child session's parts and tool calls
 * arrive here alongside its parent's.
 */
export interface IOpencodeServer {
	/** The directory the server process is rooted at; its tools run here. */
	readonly cwd: string;
	/** Where the server listens, for diagnostics. */
	readonly baseUrl: string;
	readonly onDidReceiveEvent: Event<IOpencodeEvent>;
	/** Fires once when the process goes away without being disposed. */
	readonly onDidClose: Event<string>;
	request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>;
	dispose(): void;
}

export const IOpencodeServerService = createDecorator<IOpencodeServerService>('opencodeServerService');

export interface IOpencodeServerService {
	readonly _serviceBrand: undefined;
	/** The running server for `cwd`, starting one if this is the first caller. */
	acquire(cwd: string): Promise<IOpencodeServer>;
	/** Stops every server this service started. */
	close(): Promise<void>;
}

export class OpencodeServerService implements IOpencodeServerService {
	declare readonly _serviceBrand: undefined;

	private readonly _servers = new Map<string, Promise<OpencodeServer>>();

	constructor(
		@ILogService private readonly _logService: ILogService,
	) { }

	async acquire(cwd: string): Promise<IOpencodeServer> {
		const existing = this._servers.get(cwd);
		if (existing) {
			try {
				const server = await existing;
				if (!server.closed) {
					return server;
				}
			} catch {
				// A failed start is not cached: the binary may have been installed
				// since, and the next send is entitled to a fresh attempt.
			}
			this._servers.delete(cwd);
		}
		const starting = OpencodeServer.start(resolveOpencodeBinary(), cwd, this._logService);
		this._servers.set(cwd, starting);
		try {
			return await starting;
		} catch (error) {
			if (this._servers.get(cwd) === starting) {
				this._servers.delete(cwd);
			}
			throw error;
		}
	}

	async close(): Promise<void> {
		const servers = [...this._servers.values()];
		this._servers.clear();
		for (const starting of servers) {
			try {
				(await starting).dispose();
			} catch {
				// A server that never started has nothing to stop.
			}
		}
	}
}

class OpencodeServer extends Disposable implements IOpencodeServer {

	/**
	 * Starts one server and waits until it can actually be talked to.
	 *
	 * Readiness is the `server.connected` frame on the event stream rather than
	 * a probe of some health route: it proves the very channel every turn depends
	 * on is open, which a `200` on another path would not.
	 */
	static async start(binary: string, cwd: string, logService: ILogService): Promise<OpencodeServer> {
		const port = await findFreePort();
		const password = generateUuid();
		const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
		let child: OpencodeChildProcess;
		try {
			child = spawn(binary, args, {
				cwd,
				// Ambient provider configuration is never a configuration source for a
				// harness Fumie launches; opencode signs in through its own
				// `auth.json`, so nothing here is lost by scrubbing.
				env: { ...withoutModelProviderEnvironment(process.env), [OPENCODE_SERVER_PASSWORD_ENV]: password },
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				// Node refuses to execute `.cmd` / `.bat` without a shell, and on
				// Windows a user-installed `opencode` normally arrives as one.
				shell: isWindows,
			});
		} catch (error) {
			throw new Error(startFailureMessage(binary, error));
		}
		const server = new OpencodeServer(child, `http://127.0.0.1:${String(port)}`, password, cwd, logService);
		try {
			await server._waitUntilConnected();
			return server;
		} catch (error) {
			server.dispose();
			throw error;
		}
	}

	private readonly _onDidReceiveEvent = this._register(new Emitter<IOpencodeEvent>());
	readonly onDidReceiveEvent = this._onDidReceiveEvent.event;

	private readonly _onDidClose = this._register(new Emitter<string>());
	readonly onDidClose = this._onDidClose.event;

	private readonly _authorization: string;
	private readonly _connected = new DeferredPromise<void>();
	private readonly _streamAbort = new AbortController();
	private _exitReason: string | undefined;
	private _disposed = false;

	private constructor(
		private readonly _child: OpencodeChildProcess,
		private readonly _baseUrl: string,
		password: string,
		readonly cwd: string,
		private readonly _logService: ILogService,
	) {
		super();
		this._authorization = `Basic ${Buffer.from(`${OPENCODE_BASIC_AUTH_USER}:${password}`).toString('base64')}`;
		this._child.stdout.setEncoding('utf8');
		this._child.stdout.on('data', (chunk: string) => this._logService.trace(`[opencode] ${chunk.trimEnd()}`));
		this._child.stderr.setEncoding('utf8');
		this._child.stderr.on('data', (chunk: string) => this._logService.trace(`[opencode] ${chunk.trimEnd()}`));
		this._child.once('exit', (code, signal) => this._reportExit(exitDescription(code, signal)));
		this._child.once('error', error => this._reportExit(errorText(error)));
		this._register(toDisposable(() => {
			this._disposed = true;
			this._streamAbort.abort();
			if (this._child.exitCode === null && this._child.signalCode === null) {
				this._child.kill();
			}
		}));
	}

	get baseUrl(): string {
		return this._baseUrl;
	}

	/** Whether the process has gone away, so the next caller starts a new one. */
	get closed(): boolean {
		return this._disposed || this._exitReason !== undefined;
	}

	async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
		return requestOpencode<T>(this._baseUrl, this._authorization, method, path, body, this._streamAbort.signal);
	}

	private async _waitUntilConnected(): Promise<void> {
		void this._consumeEventStream();
		const settled = await raceTimeout(
			Promise.race([this._connected.p, this._whenExited()]),
			OPENCODE_START_TIMEOUT_MS,
		);
		if (settled === undefined && !this._connected.isSettled) {
			throw new Error(`opencode did not start within ${String(OPENCODE_START_TIMEOUT_MS / 1000)}s.`);
		}
		if (this._exitReason) {
			throw new Error(`opencode stopped before it was ready: ${this._exitReason}`);
		}
	}

	/**
	 * Reads the global event stream for the life of the process.
	 *
	 * The connect is retried while the server is still binding its port — the
	 * process is up long before the listener is — and the loop ends when the
	 * stream ends, which for a live server only happens on exit or disposal.
	 */
	private async _consumeEventStream(): Promise<void> {
		while (!this.closed) {
			try {
				const response = await fetch(`${this._baseUrl}/event`, {
					headers: { authorization: this._authorization, accept: 'text/event-stream' },
					signal: this._streamAbort.signal,
				});
				if (!response.ok || !response.body) {
					throw new Error(`opencode event stream answered ${String(response.status)}.`);
				}
				await this._readEventStream(response.body);
				return;
			} catch (error) {
				if (this.closed || this._connected.isSettled) {
					return;
				}
				this._logService.trace(`[opencode] Event stream not ready yet: ${errorText(error)}`);
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}
	}

	private async _readEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		const reader = body.getReader();
		let buffer = '';
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			buffer += decoder.decode(value, { stream: true });
			// Server-sent events are separated by a blank line; a frame that has not
			// arrived whole stays in the buffer until it has.
			let boundary = buffer.indexOf('\n\n');
			while (boundary >= 0) {
				this._dispatchFrame(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf('\n\n');
			}
		}
	}

	private _dispatchFrame(frame: string): void {
		for (const line of frame.split('\n')) {
			if (!line.startsWith('data:')) {
				continue;
			}
			const event = parseOpencodeEvent(line.slice(5).trim());
			if (!event) {
				continue;
			}
			if (event.type === 'server.connected') {
				this._connected.complete();
			}
			this._onDidReceiveEvent.fire(event);
		}
	}

	private _whenExited(): Promise<void> {
		return new Promise(resolve => {
			if (this._exitReason !== undefined) {
				resolve();
				return;
			}
			this._register(this.onDidClose(() => resolve()));
		});
	}

	private _reportExit(reason: string): void {
		if (this._exitReason !== undefined) {
			return;
		}
		this._exitReason = reason;
		if (!this._disposed) {
			this._onDidClose.fire(reason);
		}
	}
}

/** A prompt response waits for the whole turn; its HTTP wait is not a turn deadline. */
export async function requestOpencode<T>(baseUrl: string, authorization: string, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	const waitsForTurn = method === 'POST' && /^\/session\/[^/]+\/message$/.test(path);
	const response = await request(`${baseUrl}${path}`, {
		method,
		headers: {
			authorization,
			...(body !== undefined ? { 'content-type': 'application/json' } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		// fetch's five-minute header/body timeout can fail Fumie while opencode
		// and its subagents continue working. Only the synchronous prompt RPC
		// waits without that timeout; cancellation/server disposal still aborts it.
		...(waitsForTurn ? { headersTimeout: 0, bodyTimeout: 0 } : {}),
		signal,
	});
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`opencode ${method} ${path} failed with ${String(response.statusCode)}: ${(await response.body.text()).slice(0, 500)}`);
	}
	if (response.statusCode === 204 || response.headers['content-length'] === '0') {
		await response.body.dump();
		return undefined as T;
	}
	return await response.body.json() as T;
}

/** Parses one `data:` payload; a frame that is not an opencode event is dropped. */
export function parseOpencodeEvent(payload: string): IOpencodeEvent | undefined {
	if (!payload) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(payload) as { type?: unknown; properties?: unknown };
		if (typeof parsed.type !== 'string') {
			return undefined;
		}
		const properties = parsed.properties;
		return {
			type: parsed.type,
			properties: properties && typeof properties === 'object' && !Array.isArray(properties) ? properties as Record<string, unknown> : {},
		};
	} catch {
		return undefined;
	}
}

/**
 * The `opencode` executable to run.
 *
 * `PATH` first, because v1 asks the user to install opencode themselves and
 * that is where their install is; the agents directory is the second place to
 * look so a build that does ship the binary needs no code change. Failing both,
 * the error names the remedy rather than leaving a spawn to fail with `ENOENT`
 * halfway into a turn.
 */
export function resolveOpencodeBinary(): string {
	const fromPath = findOnPath(OPENCODE_BINARY);
	if (fromPath) {
		return fromPath;
	}
	const agentsDir = resolveDefaultAgentsDir();
	const bundled = agentsDir ? firstExisting([
		join(agentsDir, OPENCODE_BINARY, binaryFileName(OPENCODE_BINARY)),
		join(agentsDir, OPENCODE_BINARY, 'bin', binaryFileName(OPENCODE_BINARY)),
	]) : undefined;
	if (bundled) {
		return bundled;
	}
	throw new Error('opencode was not found on PATH. Install it (https://opencode.ai) and make sure `opencode` runs from a terminal.');
}

function binaryFileName(name: string): string {
	return isWindows ? `${name}.exe` : name;
}

function findOnPath(name: string): string | undefined {
	const candidates: string[] = [];
	for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
		if (!dir) {
			continue;
		}
		// On Windows an installed CLI is as likely to be a `.cmd` shim as an
		// executable, and `spawn` runs it through a shell either way.
		for (const suffix of isWindows ? ['.exe', '.cmd', '.bat', ''] : ['']) {
			candidates.push(join(dir, `${name}${suffix}`));
		}
	}
	return firstExisting(candidates);
}

function firstExisting(candidates: readonly string[]): string | undefined {
	return candidates.find(candidate => existsSync(candidate));
}

/**
 * A port nothing is listening on right now.
 *
 * Inherently a hint rather than a reservation — the port is free when it is
 * read and could be taken before opencode binds it — which is why the caller's
 * readiness check is what actually decides whether the server came up.
 */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const port = (probe.address() as AddressInfo).port;
			probe.close(error => error ? reject(error) : resolve(port));
		});
	});
}

function startFailureMessage(binary: string, error: unknown): string {
	if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
		return `The opencode executable '${binary}' could not be run. Install opencode and make sure it runs from a terminal.`;
	}
	return `Could not start '${binary} serve': ${errorText(error)}`;
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
	return signal ? `opencode serve was terminated by ${signal}.` : `opencode serve exited with code ${String(code ?? 0)}.`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
