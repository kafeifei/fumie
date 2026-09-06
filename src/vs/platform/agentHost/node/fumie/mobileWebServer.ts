/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as path from '../../../../base/common/path.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { renderMobileWebClientPage } from '../../common/fumie/mobileWebClientPage.js';
import type { IMobileClientInfo } from '../../common/tunnelAgentHost.js';

const WS_PATH = '/__mobile-agent-host';
const SESSION_COOKIE = 'fumie_mobile';

/**
 * The session a cookie carries when it was issued before cookies carried one.
 *
 * Such a cookie identifies nothing on its own, so every client still holding
 * one shares this identity and is disconnected as a group. That lasts exactly
 * as long as it takes each of them to load the page once, which re-issues a
 * cookie of its own.
 */
const LEGACY_SESSION = 'legacy';

/**
 * How many clients are remembered before the ones with nothing open are let go.
 *
 * A record outlives its sockets so that a phone keeps its identity and its
 * connection time across the reconnects it makes for a living, which means
 * nothing else would ever drop it.
 */
const MAX_TRACKED_CLIENTS = 32;

/** Devices, in the order their markers have to be tested. */
const CLIENT_DEVICES: readonly (readonly [RegExp, string])[] = [
	[/iPhone/, 'iPhone'],
	[/iPad/, 'iPad'],
	[/iPod/, 'iPod'],
	[/Android/, 'Android'],
	[/CrOS/, 'Chromebook'],
	// After the mobile markers: an iPhone's User-Agent says `like Mac OS X`.
	[/Macintosh|Mac OS X/, 'Mac'],
	[/Windows/, 'Windows'],
	[/Linux/, 'Linux'],
];

/**
 * Browsers, in the order their markers have to be tested: Edge and Opera both
 * claim to be Chrome, and every browser on iOS claims to be Safari.
 */
const CLIENT_BROWSERS: readonly (readonly [RegExp, string])[] = [
	[/Edg[A-Za-z]*\//, 'Edge'],
	[/OPR\/|Opera/, 'Opera'],
	[/FxiOS\/|Firefox\//, 'Firefox'],
	[/CriOS\/|Chrome\//, 'Chrome'],
	[/Safari\//, 'Safari'],
];

/**
 * What to call a client in the desktop's device list, from the only thing it
 * says about itself.
 *
 * A User-Agent is a claim rather than a fact — anything can send anything — so
 * this only ever produces a label. Nothing is decided on the strength of it.
 */
export function describeMobileClient(userAgent: string | undefined): string {
	const agent = userAgent ?? '';
	const device = CLIENT_DEVICES.find(([marker]) => marker.test(agent))?.[1];
	const browser = CLIENT_BROWSERS.find(([marker]) => marker.test(agent))?.[1];
	if (device && browser) {
		return `${device} (${browser})`;
	}
	return device ?? browser ?? localize('mobileClient.unknown', "Unknown device");
}

/**
 * Which way a client came in.
 *
 * The server binds loopback only, so every socket arrives from 127.0.0.1 and
 * the peer address says nothing at all. The Host header survives the dev
 * tunnel's forwarding intact, and it is the one thing that separates a phone on
 * the far side of the relay from a browser on this machine.
 */
export function mobileClientTransport(host: string | undefined): 'local' | 'tunnel' {
	if (!host) {
		return 'local';
	}
	const name = (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]).toLowerCase();
	return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' ? 'local' : 'tunnel';
}

/** A client the server is tracking, and the sockets that make it connected. */
interface IMobileClientRecord {
	readonly id: string;
	readonly label: string;
	readonly transport: 'local' | 'tunnel';
	readonly connectedAt: number;
	readonly sockets: Set<import('ws').WebSocket>;
}

/**
 * A sentence for anything thrown at us. `ws` reports connection faults as
 * `Error`s carrying a `code`, and everything else arrives as whatever the
 * thrower chose, so plain string coercion is not enough to keep the log
 * readable.
 */
function describeError(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code ? `${error.message} (${code})` : error.message;
	}
	return String(error);
}

export interface IMobileWebServerOptions {
	readonly webBundleRoot: string;
	/**
	 * The agent host WebSocket address to bridge a client onto, resolved once
	 * per connection.
	 *
	 * Resolving late matters: the desktop agent host is a separate process that
	 * can be restarted while sharing stays on, and its address and connection
	 * token change when it is. A value captured at start time would go stale.
	 */
	readonly resolveAgentHostUrl: () => Promise<string>;
	readonly host?: string;
	/**
	 * The port to bind. Given one, a failure to take it is reported rather than
	 * papered over — see {@link MobileWebServer.onDidFallBackFromPinnedPort}.
	 *
	 * Ignored by a server that is mounted inside another one, which never binds
	 * anything of its own.
	 */
	readonly port?: number;
	/**
	 * A path segment every route of this server hangs off, for a server mounted
	 * inside a host server that owns the rest of the address space — the headless
	 * server serves the Fumie shell under `/fumie` beside the workbench it already
	 * answers `/` with. Must start with a slash and must not end with one.
	 *
	 * Empty by default, which is the standalone shape the phone uses: the server
	 * owns its port outright and `/m/<capability>` is the whole address.
	 */
	readonly pathPrefix?: string;
	/**
	 * The capability in `/m/<capability>` and in the session cookie, when the
	 * caller has one to keep the address stable across restarts.
	 *
	 * Without one a fresh 16 random bytes are used, which is what the preview
	 * harness and the tests get: an address that is only good for this process
	 * is the right default for a server nobody has been handed the URL of.
	 */
	readonly capability?: string;
}

export interface IMobileWebServerInfo {
	readonly port: number;
	readonly localUrl: string;
	readonly capability: string;
}

export class MobileWebServer extends Disposable {

	private _server: http.Server | undefined;
	private readonly _capability: string;
	/**
	 * The path every route of this server hangs off — `/m/<capability>` on its
	 * own port, or the same under a host server's prefix.
	 */
	private readonly _mountPath: string;
	private readonly _openSockets = new Set<import('ws').WebSocket>();
	private _wss: import('ws').WebSocketServer | undefined;
	private _port = 0;

	/** Clients seen since this server started, keyed by the session their cookie carries. */
	private readonly _clients = new Map<string, IMobileClientRecord>();
	/** Sessions {@link disconnectClient} took back, refused from here on. */
	private readonly _revokedSessions = new Set<string>();
	private _clientSequence = 0;

	private readonly _onDidStart = this._register(new Emitter<IMobileWebServerInfo>());
	readonly onDidStart: Event<IMobileWebServerInfo> = this._onDidStart.event;

	/**
	 * A client reached the page but no agent host could be resolved for it. The
	 * page itself is still served, so this is the only place the failure is
	 * visible.
	 */
	private readonly _onDidFailToReachAgentHost = this._register(new Emitter<unknown>());
	readonly onDidFailToReachAgentHost: Event<unknown> = this._onDidFailToReachAgentHost.event;

	/**
	 * A client's WebSocket upgrade was turned away. Every refusal here reaches the
	 * browser as a socket that simply goes away, which is indistinguishable from a
	 * network fault at the other end, so the only durable record of why is this
	 * event and the log line behind it.
	 */
	private readonly _onDidRejectUpgrade = this._register(new Emitter<string>());
	readonly onDidRejectUpgrade: Event<string> = this._onDidRejectUpgrade.event;

	/**
	 * A client's WebSocket upgrade reached this server, before anything is
	 * decided about it.
	 *
	 * A bridge that works is otherwise silent, so the absence of a refusal
	 * cannot tell an upgrade that was served from one that never arrived — and
	 * that is the first thing worth knowing when a phone that loads the page
	 * over a tunnel still cannot reach this machine. The Host the client used
	 * comes along because it is what separates a tunnelled client from one on
	 * the local network.
	 */
	private readonly _onDidReceiveUpgrade = this._register(new Emitter<string>());
	readonly onDidReceiveUpgrade: Event<string> = this._onDidReceiveUpgrade.event;

	/** A client's upgrade was answered and its bridge onto the agent host is open. */
	private readonly _onDidBridgeClient = this._register(new Emitter<void>());
	readonly onDidBridgeClient: Event<void> = this._onDidBridgeClient.event;

	/**
	 * The set of connected clients changed. Carries the whole list rather than
	 * the difference: it is short, it is what a caller renders, and reading it
	 * back over IPC per change would cost a round trip to learn the same thing.
	 */
	private readonly _onDidChangeClients = this._register(new Emitter<readonly IMobileClientInfo[]>());
	readonly onDidChangeClients: Event<readonly IMobileClientInfo[]> = this._onDidChangeClients.event;

	/**
	 * The pinned port was taken, so this run is on whatever port was free.
	 *
	 * The whole point of a pinned port is that the address the user copied onto
	 * a phone last week still reaches this machine. When it cannot be had, the
	 * server keeps working on another port and the address quietly stops being
	 * the one that was handed out — which is exactly the failure this change
	 * exists to remove, so it is reported rather than absorbed.
	 */
	private readonly _onDidFallBackFromPinnedPort = this._register(new Emitter<string>());
	readonly onDidFallBackFromPinnedPort: Event<string> = this._onDidFallBackFromPinnedPort.event;

	constructor(private readonly _options: IMobileWebServerOptions) {
		super();
		this._capability = this._options.capability ?? crypto.randomBytes(16).toString('base64url');
		this._mountPath = `${this._options.pathPrefix ?? ''}/m/${this._capability}`;
		this._register({ dispose: () => this._close() });
	}

	/** The clients with a bridge open right now, oldest first. */
	get clients(): readonly IMobileClientInfo[] {
		const connected: IMobileClientInfo[] = [];
		for (const record of this._clients.values()) {
			if (record.sockets.size > 0) {
				connected.push({
					id: record.id,
					label: record.label,
					connectedAt: record.connectedAt,
					transport: record.transport,
				});
			}
		}
		return connected;
	}

	/**
	 * Close one client's bridge and refuse the session cookie it holds, so the
	 * reconnect its page attempts the moment the socket dies is turned away
	 * rather than raced.
	 *
	 * Answers whether the id matched anything. It is not a ban: the address is
	 * the credential, and a device that still has the link can load the page
	 * again and be issued a session of its own — rolling the pairing is what
	 * takes the address itself back.
	 */
	disconnectClient(id: string): boolean {
		for (const [session, record] of this._clients) {
			if (record.id !== id) {
				continue;
			}
			this._clients.delete(session);
			this._revokedSessions.add(session);
			for (const socket of record.sockets) {
				this._openSockets.delete(socket);
				socket.close();
			}
			record.sockets.clear();
			this._onDidChangeClients.fire(this.clients);
			return true;
		}
		return false;
	}

	get info(): IMobileWebServerInfo | undefined {
		if (this._port === 0) {
			return undefined;
		}
		return {
			port: this._port,
			localUrl: `http://127.0.0.1:${this._port}${this._mountPath}`,
			capability: this._capability,
		};
	}

	/**
	 * The path a client asks for, relative to whatever address the host server
	 * answers on. Only meaningful for a mounted server; a standalone one hands
	 * out a whole URL through {@link info} instead.
	 */
	get mountPath(): string {
		return this._mountPath;
	}

	/**
	 * Ready this server to answer through a host server's HTTP face, without
	 * binding an address of its own.
	 *
	 * The headless server has one port, one connection token and one reverse
	 * proxy in front of it; a second listener beside it would be reachable from
	 * the machine it runs on and from nowhere else, which for a server whose
	 * whole point is being remote is the same as not existing. So the shell is
	 * mounted on the address the host already publishes and
	 * {@link tryHandleRequest} / {@link tryHandleUpgrade} are what the host calls.
	 */
	async mount(): Promise<void> {
		await this._ensureWebSocketServer();
	}

	private async _ensureWebSocketServer(): Promise<void> {
		if (this._wss) {
			return;
		}
		const { WebSocketServer } = await import('ws');
		this._wss = new WebSocketServer({ noServer: true });
	}

	async start(): Promise<IMobileWebServerInfo> {
		await this._ensureWebSocketServer();

		const { createServer } = await import('http');
		const server = this._server = createServer((req, res) => this._handleRequest(req, res));

		server.on('upgrade', (req, socket, head) => {
			const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
			if (this.tryHandleUpgrade(req, socket, head, pathname)) {
				return;
			}
			this._onDidReceiveUpgrade.fire(`${this._redact(pathname)} (host ${req.headers.host ?? 'unknown'})`);
			this._refuseUpgrade(socket, 404, `no bridge at ${this._redact(pathname)}`);
		});

		const pinnedPort = this._options.port;
		try {
			await this._listen(server, pinnedPort ?? 0);
		} catch (error) {
			if (pinnedPort === undefined || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
				throw error;
			}
			this._onDidFallBackFromPinnedPort.fire(
				`port ${pinnedPort} is already taken, so this run answers on a port of the OS's choosing and the address handed out before now no longer reaches it`);
			await this._listen(server, 0);
		}

		const address = server.address() as AddressInfo;
		this._port = address.port;
		const info: IMobileWebServerInfo = {
			port: this._port,
			localUrl: `http://127.0.0.1:${this._port}${this._mountPath}`,
			capability: this._capability,
		};
		this._onDidStart.fire(info);
		return info;
	}

	/**
	 * One attempt at a port. The `error` listener is taken back off on success
	 * because a second attempt follows a failed one, and a listener left behind
	 * would settle the wrong promise.
	 */
	private _listen(server: http.Server, port: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const onError = (error: unknown) => reject(error);
			server.once('error', onError);
			server.listen(port, this._options.host ?? '127.0.0.1', () => {
				server.removeListener('error', onError);
				resolve();
			});
		});
	}

	setPublicOrigin(_origin: string): void {
		// Reserved for future use when the server is behind a tunnel and needs
		// to validate the Host header of incoming requests.
	}

	private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			this._respond(res, 405, 'Method not allowed');
			return;
		}

		const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
		if (!this.tryHandleRequest(req, res, pathname)) {
			this._respond(res, 404, 'Not found');
		}
	}

	/**
	 * Answer a request that belongs to this server, or say that none of its
	 * routes match so a host server can carry on with its own.
	 *
	 * `pathname` is the request path with whatever prefix the host server has
	 * already consumed taken off, and `urlPrefix` is exactly that prefix: the
	 * served page addresses its own assets through it, so a host answering under
	 * a base path still hands the browser URLs that come back to it. Both come
	 * from the host's own configuration, never from the request.
	 */
	tryHandleRequest(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, urlPrefix: string = ''): boolean {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			return false;
		}

		const basePath = this._mountPath;

		// Entry point — set cookie and serve HTML
		if (pathname === basePath || pathname === `${basePath}/`) {
			this._serveHtml(req, res, urlPrefix);
			return true;
		}

		// Static bundle files
		const bundlePrefix = `${basePath}/bundle/`;
		if (pathname.startsWith(bundlePrefix)) {
			this._serveStatic(req, res, pathname.slice(bundlePrefix.length));
			return true;
		}

		// Lazily-loaded node modules — xterm, katex and the rest. The workbench
		// resolves these against `_VSCODE_FILE_ROOT` as `vs/../../node_modules`,
		// which a browser normalises to a sibling of `bundle/` before the
		// request is ever sent, so they never reach the route above. They are
		// shipped into the bundle root under this name.
		const nodeModulesPrefix = `${basePath}/node_modules/`;
		if (pathname.startsWith(nodeModulesPrefix)) {
			this._serveStatic(req, res, `node_modules/${pathname.slice(nodeModulesPrefix.length)}`);
			return true;
		}

		return false;
	}

	/**
	 * Take over a WebSocket upgrade addressed to this server's bridge, or say it
	 * was not, leaving the host server's own upgrades — the remote agent
	 * connection above all — untouched.
	 */
	tryHandleUpgrade(req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer, pathname: string): boolean {
		if (pathname !== `${this._mountPath}${WS_PATH}`) {
			return false;
		}
		this._onDidReceiveUpgrade.fire(`${this._redact(pathname)} (host ${req.headers.host ?? 'unknown'})`);
		if (!this._wss) {
			this._refuseUpgrade(socket, 503, 'this bridge has not been readied yet');
			return true;
		}
		const session = this._readSession(req);
		if (!session) {
			this._refuseUpgrade(socket, 403, 'the request carried no valid session cookie');
			return true;
		}
		this._connectUpstream(req, socket, head, session);
		return true;
	}

	private _serveHtml(req: http.IncomingMessage, res: http.ServerResponse, urlPrefix: string): void {
		const basePath = `${this._safeUrlPrefix(urlPrefix)}${this._mountPath}`;

		const headers: Record<string, string> = {
			...this._securityHeaders('text/html; charset=utf-8'),
		};
		if (!this._readSession(req)) {
			// A session of this client's own, so one client can be disconnected
			// without taking the others with it. Minted here and written down
			// nowhere until the client actually opens a bridge: a page load that
			// goes no further must not cost this process an entry.
			headers['Set-Cookie'] = `${SESSION_COOKIE}=${this._capability}.${crypto.randomBytes(12).toString('base64url')}; HttpOnly; SameSite=Strict; Path=/`;
		}

		const html = this._generateHtml(basePath);
		res.writeHead(200, headers);
		if (req.method === 'HEAD') {
			res.end();
		} else {
			res.end(html);
		}
	}

	private _serveStatic(req: http.IncomingMessage, res: http.ServerResponse, relativePath: string): void {
		if (!this._readSession(req)) {
			this._respond(res, 403, 'Forbidden');
			return;
		}

		let decoded: string;
		try {
			decoded = decodeURIComponent(relativePath);
		} catch {
			this._respond(res, 404, 'Not found');
			return;
		}

		if (!decoded || decoded.includes('..') || decoded.endsWith('.map')) {
			this._respond(res, 404, 'Not found');
			return;
		}

		const filePath = path.resolve(this._options.webBundleRoot, decoded);
		if (!filePath.startsWith(this._options.webBundleRoot + path.sep)) {
			this._respond(res, 404, 'Not found');
			return;
		}

		fs.stat(filePath, (err, stat) => {
			if (err || !stat.isFile()) {
				this._respond(res, 404, 'Not found');
				return;
			}
			const contentType = this._contentType(filePath);
			const headers = this._securityHeaders(contentType);
			const compressible = this._isCompressible(contentType);
			if (compressible) {
				headers['Vary'] = 'Accept-Encoding';
			}
			const gzip = compressible && this._acceptsGzip(req);
			if (gzip) {
				headers['Content-Encoding'] = 'gzip';
			} else {
				headers['Content-Length'] = String(stat.size);
			}
			res.writeHead(200, headers);
			if (req.method === 'HEAD') {
				res.end();
				return;
			}
			const file = fs.createReadStream(filePath);
			if (gzip) {
				file.pipe(zlib.createGzip()).pipe(res);
			} else {
				file.pipe(res);
			}
		});
	}

	/**
	 * Whether the client will take a gzipped body.
	 *
	 * This is the difference between a phone that shows the workbench and one
	 * that appears to hang. The client bundle is ~20MB of JavaScript and ~1.6MB
	 * of CSS, and a tunnelled connection carries it at a few hundred KB/s: sent
	 * as-is that is the better part of a minute of blank screen, which reads as
	 * a dead page long before it finishes. Both files are text and compress to
	 * roughly a quarter of their size.
	 */
	private _acceptsGzip(req: http.IncomingMessage): boolean {
		const accepted = req.headers['accept-encoding'];
		const header = Array.isArray(accepted) ? accepted.join(',') : accepted;
		return !!header && header.split(',').some(part => part.trim().split(';')[0] === 'gzip');
	}

	/**
	 * Compressing an already-compressed body spends CPU to make it slightly
	 * larger, so only the text types are worth it. Fonts and images in the
	 * bundle are already packed.
	 */
	private _isCompressible(contentType: string): boolean {
		return /^(text\/|application\/(javascript|json)|image\/svg)/.test(contentType);
	}

	private async _connectUpstream(req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer, session: string): Promise<void> {
		const { WebSocket } = await import('ws');

		let upstreamUrl: string;
		try {
			upstreamUrl = await this._options.resolveAgentHostUrl();
		} catch (error) {
			this._onDidFailToReachAgentHost.fire(error);
			this._refuseUpgrade(
				socket,
				503,
				`this machine's agent host could not be resolved: ${describeError(error)}`);
			return;
		}
		if (socket.destroyed) {
			this._onDidRejectUpgrade.fire('the client gave up before this machine\'s agent host was resolved');
			return;
		}

		const upstream = new WebSocket(upstreamUrl);

		let opened = false;
		upstream.once('open', () => {
			opened = true;
			this._wss!.handleUpgrade(req, socket, head, (downstream) => {
				this._openSockets.add(downstream);
				this._openSockets.add(upstream);
				this._trackClient(session, req, downstream, upstream);
				this._bridge(downstream, upstream, session);
				this._onDidBridgeClient.fire();
			});
		});
		upstream.once('error', (error: unknown) => {
			if (!opened) {
				this._refuseUpgrade(
					socket,
					502,
					`the bridge to this machine's agent host failed: ${describeError(error)}`);
			}
		});
	}

	/**
	 * Turn a client away with an HTTP status rather than by dropping the socket.
	 *
	 * A destroyed socket reaches the browser as a bare `error` event carrying no
	 * detail at all, and the close that follows it is code 1006 with an empty
	 * reason — the same thing a pulled network cable looks like. Completing the
	 * handshake with a status and a sentence means the page can say what was
	 * refused, and the reason is on the wire rather than only in this process.
	 */
	private _refuseUpgrade(socket: import('stream').Duplex, status: number, reason: string): void {
		this._onDidRejectUpgrade.fire(`${status} ${reason}`);
		if (socket.destroyed) {
			return;
		}
		const body = `Fumie mobile bridge refused the connection: ${reason}`;
		const statusText = status === 403 ? 'Forbidden'
			: status === 404 ? 'Not Found'
				: status === 502 ? 'Bad Gateway'
					: 'Service Unavailable';
		socket.end(
			`HTTP/1.1 ${status} ${statusText}\r\n` +
			'Connection: close\r\n' +
			'Content-Type: text/plain; charset=utf-8\r\n' +
			`Content-Length: ${Buffer.byteLength(body)}\r\n` +
			'\r\n' +
			body,
		);
	}

	/**
	 * `ws` carries the ready-state constants on every socket, which is the only
	 * way to read them here: this module is bundled as ESM, where `require` does
	 * not exist and the bundler's shim throws rather than resolving one. Reading
	 * `OPEN` off the sockets kept that failure out of the one code path a phone
	 * always takes.
	 */
	private _bridge(downstream: import('ws').WebSocket, upstream: import('ws').WebSocket, session: string): void {
		const isOpen = (socket: import('ws').WebSocket) => socket.readyState === socket.OPEN;
		downstream.on('message', (data: Buffer, isBinary: boolean) => {
			if (isOpen(upstream)) {
				upstream.send(data, { binary: isBinary });
			}
		});
		upstream.on('message', (data: Buffer, isBinary: boolean) => {
			if (isOpen(downstream)) {
				downstream.send(data, { binary: isBinary });
			}
		});
		const close = () => {
			this._openSockets.delete(downstream);
			this._openSockets.delete(upstream);
			this._untrackClient(session, downstream, upstream);
			if (isOpen(downstream)) { downstream.close(); }
			if (isOpen(upstream)) { upstream.close(); }
		};
		downstream.once('close', close);
		upstream.once('close', close);
		downstream.once('error', close);
		upstream.once('error', close);
	}

	private _generateHtml(basePath: string): string {
		return renderMobileWebClientPage({
			fileRootPath: `${basePath}/bundle`,
			stylesheetPath: `${basePath}/bundle/vs/sessions/sessions.web.main.internal.css`,
			modulePath: `${basePath}/bundle/vs/sessions/sessions.web.main.internal.js`,
			agentHostPath: `${basePath}${WS_PATH}`,
			nameShort: 'Fumie',
			nameLong: 'Fumie Mobile',
		});
	}

	/**
	 * A request path with the capability taken out of it.
	 *
	 * Every event this server reports carries the path the client asked for,
	 * and every path a working client asks for starts `/m/<the capability>` —
	 * so the events, and the log lines behind them, were writing the secret
	 * down on each connection. That was survivable while the capability died
	 * with the process; it is not now that one is kept on disk and reused. What
	 * the reports are actually for — which route was asked for, and from what
	 * Host — survives the substitution intact.
	 */
	/**
	 * The host server's prefix, or nothing at all if it is not something that
	 * can safely be written into the page's asset URLs.
	 *
	 * The prefix is host configuration rather than request data, so this should
	 * never fire; it is here because the value ends up inside an HTML attribute
	 * and a page that quietly loses its base path is a far better failure than
	 * one that carries whatever was put there.
	 */
	private _safeUrlPrefix(urlPrefix: string): string {
		return /^(\/[A-Za-z0-9._~-]+)*$/.test(urlPrefix) ? urlPrefix : '';
	}

	private _redact(pathname: string): string {
		return pathname.split(this._capability).join('<capability>');
	}

	/**
	 * The session a request carries, or `undefined` when it carries nothing this
	 * server will answer to.
	 *
	 * The cookie is `<capability>.<session>`: the capability half is what
	 * authorises the request, exactly as the whole cookie used to, and the
	 * session half is only an identity — it says which client is asking, so one
	 * can be disconnected without taking the rest with it. The capability is
	 * base64url and so cannot contain a `.`, which is what makes the split
	 * unambiguous. A cookie issued before sessions existed is still honoured,
	 * under {@link LEGACY_SESSION}.
	 */
	private _readSession(req: http.IncomingMessage): string | undefined {
		const cookies = req.headers.cookie?.split(';') ?? [];
		for (const cookie of cookies) {
			const trimmed = cookie.trim();
			if (!trimmed.startsWith(`${SESSION_COOKIE}=`)) {
				continue;
			}
			const carried = trimmed.slice(SESSION_COOKIE.length + 1);
			const separator = carried.lastIndexOf('.');
			if ((separator === -1 ? carried : carried.slice(0, separator)) !== this._capability) {
				continue;
			}
			const session = separator === -1 ? LEGACY_SESSION : carried.slice(separator + 1);
			if (session && !this._revokedSessions.has(session)) {
				return session;
			}
		}
		return undefined;
	}

	/**
	 * Note that a client is connected, creating its record on the first bridge
	 * it opens and reusing it on every one after that — a phone drops the socket
	 * whenever the relay times a quiet one out, and a record that died with the
	 * socket would hand the same device a new identity and a new connection time
	 * every couple of minutes.
	 */
	private _trackClient(session: string, req: http.IncomingMessage, downstream: import('ws').WebSocket, upstream: import('ws').WebSocket): void {
		let record = this._clients.get(session);
		if (!record) {
			this._forgetIdleClients();
			record = {
				id: `client-${++this._clientSequence}`,
				label: describeMobileClient(req.headers['user-agent']),
				transport: mobileClientTransport(req.headers.host),
				connectedAt: Date.now(),
				sockets: new Set(),
			};
			this._clients.set(session, record);
		}
		record.sockets.add(downstream);
		record.sockets.add(upstream);
		this._onDidChangeClients.fire(this.clients);
	}

	/** Both halves of one bridge are gone; the client is connected only while it has another. */
	private _untrackClient(session: string, downstream: import('ws').WebSocket, upstream: import('ws').WebSocket): void {
		const record = this._clients.get(session);
		if (!record) {
			return;
		}
		// Both halves report the close, so the second call has nothing left to
		// take away and must not announce the same departure twice.
		const removedDownstream = record.sockets.delete(downstream);
		const removedUpstream = record.sockets.delete(upstream);
		if ((removedDownstream || removedUpstream) && record.sockets.size === 0) {
			this._onDidChangeClients.fire(this.clients);
		}
	}

	/**
	 * Let go of the longest-idle records once there are more of them than any
	 * one machine could plausibly be lending itself to. Only records with
	 * nothing open are candidates; a connected client is never forgotten out
	 * from under the list it is on.
	 */
	private _forgetIdleClients(): void {
		if (this._clients.size < MAX_TRACKED_CLIENTS) {
			return;
		}
		for (const [session, record] of this._clients) {
			if (record.sockets.size === 0) {
				this._clients.delete(session);
				if (this._clients.size < MAX_TRACKED_CLIENTS) {
					return;
				}
			}
		}
	}

	private _respond(res: http.ServerResponse, status: number, message: string): void {
		res.writeHead(status, this._securityHeaders('text/plain; charset=utf-8'));
		res.end(message);
	}

	private _securityHeaders(contentType: string): Record<string, string> {
		return {
			'Cache-Control': 'no-store',
			// eslint-disable-next-line local/code-no-unexternalized-strings -- a CSP header, not display text
			'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline' data:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src 'self';",
			'Content-Type': contentType,
			'Cross-Origin-Resource-Policy': 'same-origin',
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
			'X-Frame-Options': 'DENY',
		};
	}

	private _contentType(filePath: string): string {
		const types: Record<string, string> = {
			'.css': 'text/css; charset=utf-8',
			'.html': 'text/html; charset=utf-8',
			'.js': 'application/javascript; charset=utf-8',
			'.json': 'application/json; charset=utf-8',
			'.png': 'image/png',
			'.svg': 'image/svg+xml',
			'.ttf': 'font/ttf',
			'.wasm': 'application/wasm',
			'.woff': 'font/woff',
			'.woff2': 'font/woff2',
		};
		return types[path.extname(filePath)] ?? 'application/octet-stream';
	}

	private _close(): void {
		for (const socket of this._openSockets) {
			socket.close();
		}
		this._openSockets.clear();
		this._clients.clear();
		this._wss?.close();
		this._server?.close();
	}
}
