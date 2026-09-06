/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type * as http from 'http';
import type { Duplex } from 'stream';
import { Disposable, type IDisposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { MobileWebServer } from '../../../platform/agentHost/node/fumie/mobileWebServer.js';
import { readOrCreateMobileWebPairing } from '../../../platform/agentHost/node/fumie/mobileWebPairing.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IServerEnvironmentService } from '../serverEnvironmentService.js';

const LOG_PREFIX = '[FumieWebShell]';

/**
 * The path segment the Fumie shell owns on the headless server's HTTP face.
 *
 * Everything under it belongs to the shell and nothing else routes there, which
 * is what lets the seam in the upstream server be a single unambiguous branch
 * rather than a fallback the workbench routes could ever reach.
 */
export const FUMIE_WEB_SHELL_PATH_PREFIX = '/fumie';

/** Whether a request path belongs to the Fumie shell rather than the workbench. */
export function isFumieWebShellPath(pathname: string): boolean {
	return pathname === FUMIE_WEB_SHELL_PATH_PREFIX || pathname.startsWith(`${FUMIE_WEB_SHELL_PATH_PREFIX}/`);
}

/**
 * How to reach an agent host over a WebSocket, in the shape the server's agent
 * host wiring already keeps its endpoint in.
 */
export interface IAgentHostEndpoint {
	readonly socketPath?: string;
	readonly host?: string;
	readonly port?: string | number;
	readonly connectionToken?: string;
}

/**
 * The URL `ws` dials that endpoint by.
 *
 * `ws+unix://<socket path>:/<request path>` is how `ws` addresses a unix socket
 * or a Windows named pipe: everything before the `:` becomes `socketPath` and
 * everything after is the request line the agent host's `verifyClient` reads the
 * `tkn` query from. A TCP endpoint is the ordinary `ws://host:port/` with the
 * same query.
 */
export function agentHostWebSocketUrl(endpoint: IAgentHostEndpoint): string {
	const query = endpoint.connectionToken ? `?tkn=${encodeURIComponent(endpoint.connectionToken)}` : '';
	if (endpoint.socketPath) {
		return `ws+unix://${endpoint.socketPath}:/${query}`;
	}
	if (endpoint.port) {
		return `ws://${endpoint.host || 'localhost'}:${endpoint.port}/${query}`;
	}
	throw new Error('The agent host endpoint has neither a socket path nor a port.');
}

export const IFumieWebShellServer = createDecorator<IFumieWebShellServer>('fumieWebShellServer');

/**
 * Serves the Fumie Agents shell — the same client the desktop `--agents` window
 * and the phone page run — from the headless server, so a browser that reaches
 * this machine gets the workbench Fumie is, not the one Code OSS ships.
 */
export interface IFumieWebShellServer extends IDisposable {
	readonly _serviceBrand: undefined;

	/**
	 * The path a browser reaches the shell at, relative to whatever address the
	 * host server answers on, or nothing when this build has no shell to serve.
	 */
	readonly urlPath: string | undefined;

	/**
	 * Answer a request under {@link FUMIE_WEB_SHELL_PATH_PREFIX}. Every such
	 * request is answered here, including the ones that are not the shell's: an
	 * address off the capability gets a 404 from this server rather than falling
	 * through to the workbench.
	 */
	handleRequest(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, urlPrefix: string): Promise<void>;

	/** Answer a WebSocket upgrade under {@link FUMIE_WEB_SHELL_PATH_PREFIX}. */
	handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, pathname: string): void;
}

/**
 * The shell as served by a build that has no client bundle in it.
 *
 * A `reh` (non-web) product has no browser client to serve at all, and a
 * `reh-web` product built before the bundle was added to its package has none
 * either. Answering the prefix with a plain 404 keeps that a legible miss
 * instead of a workbench page appearing where the shell was asked for.
 */
export class UnavailableFumieWebShellServer implements IFumieWebShellServer {
	declare readonly _serviceBrand: undefined;

	readonly urlPath = undefined;

	dispose(): void { }

	async handleRequest(_req: http.IncomingMessage, res: http.ServerResponse, _pathname: string, _urlPrefix: string): Promise<void> {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('The Fumie web shell is not part of this build.');
	}

	handleUpgrade(_req: http.IncomingMessage, socket: Duplex, _head: Buffer, _pathname: string): void {
		socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
	}
}

export class ServerFumieWebShellServer extends Disposable implements IFumieWebShellServer {
	declare readonly _serviceBrand: undefined;

	private readonly _server: MobileWebServer;

	/**
	 * Settled once the bridge's WebSocket machinery exists. Requests that arrive
	 * before it does are still served — the page and its bundle need nothing
	 * from it — and an upgrade that beats it is refused with a status rather
	 * than being handed on to the remote agent connection, which would read it
	 * as a protocol fault.
	 */
	readonly ready: Promise<void>;

	constructor(
		capability: string,
		webBundleRoot: string,
		resolveAgentHostUrl: () => Promise<string>,
		private readonly _logService: ILogService,
	) {
		super();
		this._server = this._register(new MobileWebServer({
			webBundleRoot,
			resolveAgentHostUrl,
			capability,
			pathPrefix: FUMIE_WEB_SHELL_PATH_PREFIX,
		}));
		this._register(this._server.onDidFailToReachAgentHost(error =>
			this._logService.warn(`${LOG_PREFIX} A client reached the page but this server's agent host could not be resolved`, error)));
		this._register(this._server.onDidRejectUpgrade(reason =>
			this._logService.warn(`${LOG_PREFIX} Refused a client's agent host bridge: ${reason}`)));
		this._register(this._server.onDidReceiveUpgrade(request =>
			this._logService.info(`${LOG_PREFIX} A client asked for an agent host bridge: ${request}`)));
		this._register(this._server.onDidBridgeClient(() =>
			this._logService.info(`${LOG_PREFIX} Bridged a client onto this server's agent host`)));

		this.ready = this._server.mount();
		this.ready.catch(error => this._logService.error(`${LOG_PREFIX} Failed to ready the agent host bridge`, error));
	}

	/**
	 * The path a browser reaches the shell at, relative to whatever address this
	 * server answers on.
	 *
	 * It carries the capability, which is the whole of the shell's access
	 * control, so this is only for the one log line that tells the operator the
	 * address at all — the same log the connection token's URL is already
	 * printed into by `serve-web`, and a headless server nobody can find the
	 * address of is a server nobody can use.
	 */
	get urlPath(): string {
		return `${this._server.mountPath}/`;
	}

	async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, urlPrefix: string): Promise<void> {
		if (this._server.tryHandleRequest(req, res, pathname, urlPrefix)) {
			return;
		}
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not found');
	}

	handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, pathname: string): void {
		if (this._server.tryHandleUpgrade(req, socket, head, pathname)) {
			return;
		}
		socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
	}
}

/**
 * Locate the client bundle this product ships, if it ships one.
 *
 * The bundle is packaged into the product root beside `out/`, which is what
 * `appRoot` resolves to for a built server; a source checkout keeps the same
 * name at the repo root, so the two layouts need no separate knowledge here.
 */
export function resolveServerWebBundleRoot(appRoot: string, logService: ILogService): string | undefined {
	const candidate = path.join(appRoot, 'web-bundle');
	try {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	} catch {
		// An unreadable candidate is simply not one.
	}
	logService.info(`${LOG_PREFIX} No web bundle at ${candidate}; the Fumie web shell is unavailable`);
	return undefined;
}

/**
 * Build the shell this server serves, or the unavailable stand-in when it has
 * no bundle to serve.
 *
 * The capability is remembered in this server's data folder rather than drawn
 * afresh per process, so the address that was copied out of the log once keeps
 * working across restarts. Only the pairing's secret is used: its port belongs
 * to the phone's standalone server, and the shell here has no port of its own.
 */
export async function createServerFumieWebShell(
	environmentService: IServerEnvironmentService,
	logService: ILogService,
	resolveAgentHostUrl: () => Promise<string>,
): Promise<IFumieWebShellServer> {
	const webBundleRoot = resolveServerWebBundleRoot(environmentService.appRoot, logService);
	if (!webBundleRoot) {
		return new UnavailableFumieWebShellServer();
	}

	const pairing = await readOrCreateMobileWebPairing(environmentService.userDataPath);
	const shell = new ServerFumieWebShellServer(pairing.secret, webBundleRoot, resolveAgentHostUrl, logService);
	logService.info(`${LOG_PREFIX} Serving the Fumie web shell from ${webBundleRoot} at ${shell.urlPath}`);
	return shell;
}
