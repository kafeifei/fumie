/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import type * as http from 'http';
import * as os from 'os';
import type * as wsTypes from 'ws';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import * as path from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { IAgentHostEndpointMetadata } from '../../common/agentHostEndpointRegistry.js';
import { renderMobileWebClientPage } from '../../common/fumie/mobileWebClientPage.js';
import { desktopAgentHostSocketUrl, liveEditorSocketEndpoints, parseMobileWebTunnelRecord, resolveMobileWebTunnel, selectOwnEditorEndpoint, watchForwardedConnections, type IMobileWebTunnelClient } from '../../node/fumie/mobileWebHosting.js';
import { TunnelAccessControlEntryType, type Tunnel, type TunnelPort } from '@microsoft/dev-tunnels-contracts';
import type { TunnelRequestOptions } from '@microsoft/dev-tunnels-management';
import { readOrCreateMobileWebPairing, rollMobileWebPairing } from '../../node/fumie/mobileWebPairing.js';
import { describeMobileClient, mobileClientTransport, MobileWebServer } from '../../node/fumie/mobileWebServer.js';

const WS_PATH = '/__mobile-agent-host';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function ws(): Promise<typeof wsTypes> {
	return await import('ws');
}

async function nodeHttp(): Promise<typeof http> {
	return await import('http');
}

function editorEndpoint(overrides: Partial<IAgentHostEndpointMetadata> = {}): IAgentHostEndpointMetadata {
	return {
		schemaVersion: 2,
		type: 'editor',
		pid: 4321,
		instanceId: 'instance-a',
		protocolVersion: '1.0.0',
		connectionToken: 'token-a',
		endpoint: { type: 'socket', path: '/tmp/agent-host-a.sock' },
		...overrides,
	} as IAgentHostEndpointMetadata;
}

/** A stand-in agent host that echoes back whatever a bridged client sends. */
async function startEchoUpstream(store: Pick<DisposableStore, 'add'>): Promise<{ url: string; seenUrls: string[] }> {
	const seenUrls: string[] = [];
	const server = (await nodeHttp()).createServer();
	const wss = new (await ws()).WebSocketServer({ server });
	wss.on('connection', (socket, request) => {
		seenUrls.push(request.url ?? '');
		socket.on('message', data => socket.send(`echo:${data.toString()}`));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	store.add({
		dispose: () => {
			wss.close();
			server.close();
		}
	});
	return { url: `ws://127.0.0.1:${port}/upstream`, seenUrls };
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	const { get: httpGet } = await nodeHttp();
	return new Promise((resolve, reject) => {
		const request = httpGet(url, { headers }, response => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', chunk => body += chunk);
			response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
		});
		request.on('error', reject);
	});
}

/**
 * The undecoded response body. `get` above asks Node for utf8 text, which would
 * turn a gzipped body into replacement characters before a test could check it.
 */
async function getRaw(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
	const { get: httpGet } = await nodeHttp();
	return new Promise((resolve, reject) => {
		const request = httpGet(url, { headers }, response => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
		});
		request.on('error', reject);
	});
}

/**
 * Wait for something the server does in reaction to a socket, which lands a
 * turn or two after the socket event itself.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (condition()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail(what);
}

/** A client that has loaded the page, holding the session cookie it was issued. */
async function loadPage(info: { localUrl: string }): Promise<string> {
	const page = await get(info.localUrl);
	assert.strictEqual(page.status, 200);
	return String(page.headers['set-cookie']?.[0]).split(';')[0];
}

/** Open a bridge the way a phone that has loaded the page does. */
async function openBridge(
	store: Pick<DisposableStore, 'add'>,
	info: { port: number; capability: string },
	cookie: string,
	userAgent = IPHONE_SAFARI,
): Promise<wsTypes.WebSocket> {
	const socket = new (await ws()).WebSocket(
		`ws://127.0.0.1:${info.port}/m/${info.capability}${WS_PATH}`,
		{ headers: { cookie, 'user-agent': userAgent } });
	store.add({ dispose: () => socket.close() });
	await new Promise<void>((resolve, reject) => {
		socket.once('open', () => resolve());
		socket.once('error', reject);
	});
	return socket;
}

/**
 * A port nothing is listening on, taken by binding one and letting it go. The
 * pinned-port tests are about what the server does with a number it was given,
 * so they must not be at the mercy of whatever else this machine is running.
 */
async function freePort(): Promise<number> {
	const server = (await nodeHttp()).createServer();
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	await new Promise<void>(resolve => server.close(() => resolve()));
	return port;
}

/** Enough of a WebSocket for the page's bridge watcher to listen to. */
class FakeSocket {
	readonly readyState = 3;
	private readonly _listeners = new Map<string, ((event: any) => void)[]>();

	addEventListener(type: string, handler: (event: any) => void): void {
		const existing = this._listeners.get(type) ?? [];
		existing.push(handler);
		this._listeners.set(type, existing);
	}

	emit(type: string, event: unknown = {}): void {
		for (const handler of this._listeners.get(type) ?? []) {
			handler(event);
		}
	}
}

/**
 * Lift the page's bridge watcher out of the page it is embedded in and run it
 * against fakes. The page is a template string, so its script cannot be
 * imported; slicing it out is what lets a test drive the real code rather than
 * match its source. `showFailure`, `clearFailure`, the log and the timers are
 * handed in, so the eight-second wait costs a test nothing.
 */
function loadBridgeWatcher(page: string): {
	watchBridge: (socket: FakeSocket | wsTypes.WebSocket, url: string) => void;
	reports: string[];
	log: string[];
	cleared: string[];
	pendingTimers: () => number;
	runTimers: () => void;
} {
	const source = page.slice(page.indexOf('let booted'), page.indexOf('window.WebSocket = function'));
	assert.ok(source.includes('const watchBridge'), 'the page must still watch the bridge it opens');

	const reports: string[] = [];
	const log: string[] = [];
	const cleared: string[] = [];
	const timers = new Map<number, () => void>();
	let nextTimer = 1;
	const harness = {
		reports,
		log,
		cleared,
		pendingTimers: () => timers.size,
		runTimers: () => {
			const due = [...timers.values()];
			timers.clear();
			for (const fn of due) {
				fn();
			}
		},
		watchBridge: undefined as unknown as (socket: FakeSocket | wsTypes.WebSocket, url: string) => void,
	};
	harness.watchBridge = new Function(
		'showFailure', 'clearFailure', 'logLine', 'SENTENCE_BRIDGE', 'setTimeout', 'clearTimeout', 'WebSocket',
		`${source}\nreturn watchBridge;`,
	)(
		(sentence: string, detail: string) => reports.push(`${sentence}\n${detail}`),
		(source: string) => cleared.push(source),
		(kind: string, text: string) => log.push(`[${kind}] ${text}`),
		'SENTENCE_BRIDGE',
		(fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id; },
		(id: number) => { timers.delete(id); },
		class { },
	);
	return harness;
}

/** Enough of a DOM for the page's reporter to build its banner against. */
class FakeElement {
	readonly children: FakeElement[] = [];
	readonly style: { cssText: string } = { cssText: '' };
	private readonly _listeners = new Map<string, (() => void)[]>();
	private _parent: FakeElement | undefined;
	textContent = '';
	hidden = false;
	readOnly = false;
	value = '';

	constructor(readonly tagName: string) { }

	get isConnected(): boolean {
		return this.tagName === 'body' ? true : !!this._parent?.isConnected;
	}

	/** Every string this subtree would put in front of a reader. */
	get text(): string {
		if (this.hidden) {
			return '';
		}
		return this.children.length
			? this.children.map(child => child.text).filter(Boolean).join(' ')
			: this.textContent;
	}

	append(...nodes: FakeElement[]): void {
		for (const node of nodes) {
			node._parent = this;
			this.children.push(node);
		}
	}
	appendChild(node: FakeElement): void { this.append(node); }
	replaceChildren(...nodes: FakeElement[]): void {
		this.children.length = 0;
		this.append(...nodes);
	}
	remove(): void {
		const siblings = this._parent?.children;
		if (siblings) {
			siblings.splice(siblings.indexOf(this), 1);
		}
		this._parent = undefined;
	}
	setAttribute(): void { }
	focus(): void { }
	select(): void { }
	addEventListener(type: string, handler: () => void): void {
		const existing = this._listeners.get(type) ?? [];
		existing.push(handler);
		this._listeners.set(type, existing);
	}
	/** Find a control by its label, the way the user's thumb does. */
	button(label: string): FakeElement {
		const found = this._find(node => node.tagName === 'button' && node.textContent === label);
		assert.ok(found, `the page must offer a "${label}" control: ${this.text}`);
		return found;
	}
	click(): void {
		for (const handler of this._listeners.get('click') ?? []) {
			handler();
		}
	}
	private _find(match: (node: FakeElement) => boolean): FakeElement | undefined {
		if (match(this)) {
			return this;
		}
		for (const child of this.children) {
			const found = child._find(match);
			if (found) {
				return found;
			}
		}
		return undefined;
	}
}

/**
 * Lift the page's reporter — the log, the console tap, the banner and the log
 * panel — out of the template and run it against a fake DOM. Same reason as the
 * bridge watcher above: the rule this code follows is about *what reaches the
 * screen and what only reaches the log*, and no regex over the source can see
 * that.
 */
function loadReporter(page: string, options: { clipboard?: boolean } = {}): {
	showError: (error: unknown) => void;
	setBooted: (booted: boolean) => void;
	body: FakeElement;
	startup: FakeElement;
	log: () => string[];
	/** What the console the page wrapped still received. */
	consoleOutput: string[];
	/** Log a line the way the workbench's own ConsoleLogger does. */
	emitConsole: (level: string, ...args: unknown[]) => void;
	hash: () => string;
	setHash: (hash: string) => void;
	copied: string[];
	dispatch: (type: string, event: unknown) => void;
	/** The failure banner, or undefined when nothing is on the screen. */
	banner: () => FakeElement | undefined;
	/** The log panel, which is only ever there because it was asked for. */
	logPanel: () => FakeElement | undefined;
} {
	const screen = page.slice(
		page.indexOf('// Every sentence this page can put'),
		page.indexOf('// The workbench opens the bridge itself'));
	const rule = page.slice(
		page.indexOf('// How the workbench says "never mind"'),
		page.indexOf('// The workbench measures the viewport'));
	assert.ok(screen.includes('const showFailure'), 'the page must still raise its report through one place');
	assert.ok(rule.includes('const showError'), 'the page must still classify what it is handed');

	const body = new FakeElement('body');
	const startup = new FakeElement('div');
	body.append(startup);
	const consoleLines: string[] = [];
	const copied: string[] = [];
	const windowListeners = new Map<string, ((event: unknown) => void)[]>();
	const location = { hash: '' };
	const fakeConsole: Record<string, (...args: unknown[]) => void> = {};
	for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
		fakeConsole[level] = (...args: unknown[]) => consoleLines.push(`${level} ${args.join(' ')}`);
	}
	const clipboard = options.clipboard === false
		? { writeText: () => Promise.reject(new Error('not allowed')) }
		: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } };

	const exports = new Function(
		'document', 'window', 'console', 'navigator', 'location', 'setTimeout', 'Event', 'CloseEvent', 'Element', 'startup', 'probeBridge',
		`let booted = false;\n${screen}\n${rule}\nreturn { showError, logText, setBooted: v => { booted = v; } };`,
	)(
		{ createElement: (tag: string) => new FakeElement(tag), body },
		{
			addEventListener: (type: string, handler: (event: unknown) => void) => {
				const existing = windowListeners.get(type) ?? [];
				existing.push(handler);
				windowListeners.set(type, existing);
			},
		},
		fakeConsole,
		{ clipboard },
		location,
		(fn: () => void) => { void fn; return 0; },
		class FakeEvent { },
		class FakeCloseEvent { },
		class FakeDomElement { },
		startup,
		() => Promise.resolve('probe answer'),
	);

	return {
		showError: exports.showError,
		setBooted: exports.setBooted,
		body,
		startup,
		log: () => String(exports.logText()).split('\n').filter(Boolean),
		consoleOutput: consoleLines,
		// After the slice above ran, these entries are the page's wrappers, so
		// calling one is exactly what the workbench's logger does.
		emitConsole: (level, ...args) => fakeConsole[level](...args),
		hash: () => location.hash,
		setHash: (hash: string) => {
			location.hash = hash;
			for (const handler of windowListeners.get('hashchange') ?? []) {
				handler(undefined);
			}
		},
		copied,
		dispatch: (type, event) => {
			for (const handler of windowListeners.get(type) ?? []) {
				handler(event);
			}
		},
		banner: () => body.children.find(child => child.style.cssText.includes('max-height:25vh')),
		logPanel: () => body.children.find(child => child.style.cssText.includes('max-height:70vh')),
	};
}

/** Enough of `localStorage` to be remembered by, or to refuse. */
function fakeLocalStorage(): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } {
	const values = new Map<string, string>();
	return {
		getItem: key => values.get(key) ?? null,
		setItem: (key, value) => { values.set(key, value); },
	};
}

/**
 * Lift the page's client-id reader out of the template and run it against a
 * fake browser. Same reason as the bridge watcher above: what this code has to
 * get right is *what survives a reload and what a refusing browser falls back
 * to*, and no regex over the source can see either.
 */
function loadClientIdReader(page: string): (storage: unknown, log?: string[]) => string {
	const source = page.slice(
		page.indexOf('const CLIENT_ID_KEY'),
		page.indexOf('const clientId = readClientId();'));
	assert.ok(source.includes('const readClientId'), 'the page must still read its id from the browser');

	return (storage, log = []) => new Function(
		'localStorage', 'logLine', 'describe',
		`${source}\nreturn readClientId();`,
	)(
		storage,
		(kind: string, text: string) => log.push(`[${kind}] ${text}`),
		(value: unknown) => String(value),
	);
}

suite('MobileWebServer', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let bundleRoot: string;

	setup(() => {
		bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fumie-mobile-web-test-'));
	});

	teardown(() => {
		fs.rmSync(bundleRoot, { recursive: true, force: true });
	});

	/**
	 * The bug this guards: the bridge used to dial a fixed `ws://127.0.0.1:31546`.
	 * That number is a Dev Tunnels *relay* port, and nothing binds it on the
	 * desktop, so every phone that loaded the page failed to reach any agent
	 * host. The address must come from the resolver, per connection.
	 */
	test('bridges a client onto the resolved agent host address', async () => {
		const upstream = await startEchoUpstream(store);
		let resolved = 0;
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: async () => {
				resolved++;
				return upstream.url;
			},
		}));
		const info = await server.start();

		const page = await get(info.localUrl);
		assert.strictEqual(page.status, 200);
		const cookie = String(page.headers['set-cookie']?.[0]).split(';')[0];

		const client = new (await ws()).WebSocket(`ws://127.0.0.1:${info.port}/m/${info.capability}${WS_PATH}`, { headers: { cookie } });
		store.add({ dispose: () => client.close() });
		const reply = await new Promise<string>((resolve, reject) => {
			client.once('open', () => client.send('hello'));
			client.once('message', data => resolve(data.toString()));
			client.once('error', reject);
		});

		assert.strictEqual(reply, 'echo:hello');
		assert.strictEqual(resolved, 1, 'the agent host address is resolved per connection, not captured at start');
		assert.deepStrictEqual(upstream.seenUrls, ['/upstream'], 'the resolver’s own path reaches the agent host');
	});

	test('refuses the upgrade when no agent host can be resolved', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('no desktop agent host is published')),
		}));
		const info = await server.start();
		const page = await get(info.localUrl);
		const cookie = String(page.headers['set-cookie']?.[0]).split(';')[0];

		const failures: unknown[] = [];
		store.add(server.onDidFailToReachAgentHost(error => failures.push(error)));

		const client = new (await ws()).WebSocket(`ws://127.0.0.1:${info.port}/m/${info.capability}${WS_PATH}`, { headers: { cookie } });
		store.add({ dispose: () => client.close() });
		await new Promise<void>(resolve => {
			client.once('error', () => resolve());
			client.once('open', () => resolve());
		});

		assert.strictEqual(client.readyState, (await ws()).WebSocket.CLOSED);
		assert.strictEqual((failures[0] as Error).message, 'no desktop agent host is published');
	});

	/**
	 * A dropped socket reaches the browser as an `error` event with no detail and
	 * a 1006 close with no reason, which is why the page could only report
	 * "[object Event]". Answering the handshake with a status puts the reason on
	 * the wire, and the rejection event puts it in the log.
	 */
	test('a refused upgrade answers with a status and reports why', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('no desktop agent host is published')),
		}));
		const info = await server.start();
		const page = await get(info.localUrl);
		const cookie = String(page.headers['set-cookie']?.[0]).split(';')[0];

		const rejections: string[] = [];
		store.add(server.onDidRejectUpgrade(reason => rejections.push(reason)));

		const client = new (await ws()).WebSocket(`ws://127.0.0.1:${info.port}/m/${info.capability}${WS_PATH}`, { headers: { cookie } });
		store.add({ dispose: () => client.close() });
		const error = await new Promise<Error>(resolve => {
			client.once('error', resolve);
			client.once('open', () => resolve(new Error('unexpectedly opened')));
		});

		assert.ok(
			/Unexpected server response: 503/.test(error.message),
			`expected a 503 handshake response, got: ${error.message}`);
		assert.strictEqual(rejections.length, 1);
		assert.ok(
			rejections[0].startsWith('503 ') && rejections[0].includes('no desktop agent host is published'),
			`expected the reason to name the failure, got: ${rejections[0]}`);
	});

	test('a request without the session cookie is refused as forbidden, not dropped', async () => {
		const upstream = await startEchoUpstream(store);
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: async () => upstream.url,
		}));
		const info = await server.start();

		const rejections: string[] = [];
		store.add(server.onDidRejectUpgrade(reason => rejections.push(reason)));

		const client = new (await ws()).WebSocket(`ws://127.0.0.1:${info.port}/m/${info.capability}${WS_PATH}`);
		store.add({ dispose: () => client.close() });
		const error = await new Promise<Error>(resolve => {
			client.once('error', resolve);
			client.once('open', () => resolve(new Error('unexpectedly opened')));
		});

		assert.ok(
			/Unexpected server response: 403/.test(error.message),
			`expected a 403 handshake response, got: ${error.message}`);
		assert.deepStrictEqual(rejections, ['403 the request carried no valid session cookie']);
	});

	/**
	 * A phone reaches this server through a Dev Tunnel, so the page is served
	 * from `https://<tunnel host>/m/<capability>` and none of the three parts of
	 * the bridge address are the ones a loopback client sees. A `ws:` scheme is
	 * blocked outright as mixed content, another host is a different machine,
	 * and dropping the capability segment lands on a path this server 404s —
	 * each of which fails only over the tunnel, which is the expensive kind.
	 */
	test('the served page dials the bridge on the page’s own scheme, host and capability path', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();

		const { body } = await get(info.localUrl);
		assert.ok(
			body.includes(`(location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/m/${info.capability}${WS_PATH}'`),
			'the page must derive the bridge address from its own location, capability path and all');
	});

	/**
	 * The bug this guards: the client id was minted per connection and written
	 * down nowhere, so every reload reached the host as a brand-new client — and
	 * the host keys reconnect and replay off that id, so a reload could not
	 * resume the way an in-page reconnect does.
	 *
	 * The id is read in the browser rather than baked into the page on the
	 * server, and that is not an implementation detail: `renderMobileWebClientPage`
	 * is pure, which is what lets one test hold the two servers' pages against
	 * each other. A server-minted id would be a different page every load.
	 */
	test('the page keeps its client id in the browser, so a reload is the same client', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const { body } = await get(info.localUrl);

		assert.ok(
			body.includes('clientId,'),
			'the page must hand the id it read to the agent host entry it configures');

		const readClientId = loadClientIdReader(body);
		const browser = fakeLocalStorage();
		const first = readClientId(browser);
		assert.ok(first, 'a first load must have an id');
		assert.strictEqual(readClientId(browser), first, 'a reload must present the id the first load stored');

		// Two loads on two phones are two clients; the id says who, and one id
		// for everyone would be the same bug in the other direction.
		assert.notStrictEqual(readClientId(fakeLocalStorage()), first);
	});

	/**
	 * Private browsing and blocked site data make even touching `localStorage`
	 * throw. A phone that cannot remember who it is is a worse phone, not a
	 * broken one: it boots, and falls back to the fresh id per load that the
	 * workbench would have minted anyway.
	 */
	test('a browser that refuses storage still boots, just without a stable id', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const { body } = await get(info.localUrl);

		const readClientId = loadClientIdReader(body);
		const refuses = {
			getItem: () => { throw new Error('The operation is insecure.'); },
			setItem: () => { throw new Error('The operation is insecure.'); },
		};
		const logged: string[] = [];
		const first = readClientId(refuses, logged);
		assert.ok(first, 'the page must still have an id to boot with');
		assert.notStrictEqual(readClientId(refuses, logged), first, 'nothing was stored, so nothing is carried');
		assert.ok(
			logged.some(line => line.includes('one-off client')),
			`the log the phone can hand back must say why the id is not stable: ${logged.join(' | ')}`);
	});

	/**
	 * The line that must not be crossed. A stable client id identifies; it never
	 * authorizes. It is now attacker-suppliable — anyone who can load the page
	 * chooses the string — so a request that carries one and nothing else must
	 * be refused exactly as a request carrying none is. What actually lets a
	 * request in is the capability in the path and the session cookie.
	 */
	test('a stable client id buys nothing: no capability and no cookie is still refused', async () => {
		const upstream = await startEchoUpstream(store);
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: async () => upstream.url,
		}));
		const info = await server.start();

		const rejections: string[] = [];
		store.add(server.onDidRejectUpgrade(reason => rejections.push(reason)));

		const clientId = 'a-perfectly-good-looking-client-id';
		const withId = new (await ws()).WebSocket(
			`ws://127.0.0.1:${info.port}/m/${info.capability}${WS_PATH}?clientId=${clientId}`,
			{ headers: { 'x-fumie-client-id': clientId } });
		store.add({ dispose: () => withId.close() });
		const refusedWithoutCookie = await new Promise<Error>(resolve => {
			withId.once('error', resolve);
			withId.once('open', () => resolve(new Error('unexpectedly opened')));
		});
		assert.ok(
			/Unexpected server response: 403/.test(refusedWithoutCookie.message),
			`a client id must not stand in for the session cookie, got: ${refusedWithoutCookie.message}`);

		// And with the cookie but off the capability path: the id is not a way
		// in there either.
		const page = await get(info.localUrl);
		const cookie = String(page.headers['set-cookie']?.[0]).split(';')[0];
		const offPath = new (await ws()).WebSocket(
			`ws://127.0.0.1:${info.port}${WS_PATH}?clientId=${clientId}`,
			{ headers: { cookie } });
		store.add({ dispose: () => offPath.close() });
		const refusedOffPath = await new Promise<Error>(resolve => {
			offPath.once('error', resolve);
			offPath.once('open', () => resolve(new Error('unexpectedly opened')));
		});
		assert.ok(
			/Unexpected server response: 404/.test(refusedOffPath.message),
			`a client id must not stand in for the capability, got: ${refusedOffPath.message}`);

		assert.deepStrictEqual(rejections, [
			'403 the request carried no valid session cookie',
			`404 no bridge at ${WS_PATH}`,
		]);
		assert.ok(
			!rejections.join(' ').includes(clientId),
			'a refusal must not write the id the client chose into the log');
	});

	/**
	 * Nothing about a bridge that works used to reach the log, so a phone that
	 * could not reach this machine left the same evidence either way: no line at
	 * all, whether the upgrade was served or never arrived. Reporting arrival
	 * separately from the outcome is what tells those apart.
	 */
	test('reports an upgrade that arrives, and whether it was bridged or refused', async () => {
		const upstream = await startEchoUpstream(store);
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: async () => upstream.url,
		}));
		const info = await server.start();
		const page = await get(info.localUrl);
		const cookie = String(page.headers['set-cookie']?.[0]).split(';')[0];

		const arrivals: string[] = [];
		const rejections: string[] = [];
		let bridged = 0;
		store.add(server.onDidReceiveUpgrade(request => arrivals.push(request)));
		store.add(server.onDidRejectUpgrade(reason => rejections.push(reason)));
		store.add(server.onDidBridgeClient(() => bridged++));

		const bridgePath = `/m/${info.capability}${WS_PATH}`;
		const client = new (await ws()).WebSocket(`ws://127.0.0.1:${info.port}${bridgePath}`, { headers: { cookie } });
		store.add({ dispose: () => client.close() });
		await new Promise<void>((resolve, reject) => {
			client.once('open', () => resolve());
			client.once('error', reject);
		});

		// The capability is redacted out of the path before it is reported; see
		// the leak test below for why.
		assert.deepStrictEqual(arrivals, [`/m/<capability>${WS_PATH} (host 127.0.0.1:${info.port})`]);
		assert.strictEqual(bridged, 1);
		assert.deepStrictEqual(rejections, []);

		const refused = new (await ws()).WebSocket(`ws://127.0.0.1:${info.port}${bridgePath}`);
		store.add({ dispose: () => refused.close() });
		await new Promise<void>(resolve => refused.once('error', () => resolve()));

		assert.strictEqual(arrivals.length, 2, 'a refused upgrade is still reported as having arrived');
		assert.strictEqual(bridged, 1);
		assert.deepStrictEqual(rejections, ['403 the request carried no valid session cookie']);
	});

	/**
	 * The settings page cannot show "who is connected to this machine" from
	 * anything the server used to keep: sockets went into one flat set with
	 * nothing on them saying which browser they belonged to.
	 */
	test('lists a client while its bridge is open and lets it go when the socket closes', async () => {
		const upstream = await startEchoUpstream(store);
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: async () => upstream.url,
		}));
		const info = await server.start();
		const cookie = await loadPage(info);

		const announced: number[] = [];
		store.add(server.onDidChangeClients(clients => announced.push(clients.length)));
		// strictEqual on the length: deepStrictEqual against `[]` is an
		// assertion signature and would narrow `clients` to `never[]`.
		assert.strictEqual(server.clients.length, 0, 'a page that was loaded but never bridged is not a connected client');

		const before = Date.now();
		const client = await openBridge(store, info, cookie);

		assert.strictEqual(server.clients.length, 1);
		assert.strictEqual(server.clients[0].label, 'iPhone (Safari)');
		assert.strictEqual(server.clients[0].transport, 'local');
		assert.ok(server.clients[0].connectedAt >= before, 'the client must carry when it connected');

		client.close();
		await until(() => server.clients.length === 0, 'a client whose socket closed must stop being listed');
		assert.deepStrictEqual(announced, [1, 0], 'both the arrival and the departure must be announced exactly once');
	});

	/**
	 * A phone drops this socket for a living — the screen locks, the relay times
	 * a quiet socket out at ~100s — and reconnects on its own. A record that died
	 * with the socket would hand the same device a new identity and a new
	 * connection time every couple of minutes, so the list could never say how
	 * long anything had been connected.
	 */
	test('a client that reconnects is the same client, with the time it first connected', async () => {
		const upstream = await startEchoUpstream(store);
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: async () => upstream.url,
		}));
		const info = await server.start();
		const cookie = await loadPage(info);

		const first = await openBridge(store, info, cookie);
		const before = server.clients[0];
		first.close();
		await until(() => server.clients.length === 0, 'the drop must be seen before the reconnect');

		await openBridge(store, info, cookie);
		assert.deepStrictEqual(server.clients, [before], 'the same browser must come back as the same row');
	});

	/**
	 * The point of the whole list: one device can be sent away without taking
	 * the others with it. The cookie used to be the capability itself, which is
	 * the same string for everybody, so there was nothing to tell two clients
	 * apart by and nothing to revoke that did not revoke all of them.
	 */
	test('disconnects the client that was asked for and leaves the others connected', async () => {
		const upstream = await startEchoUpstream(store);
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: async () => upstream.url,
		}));
		const info = await server.start();

		const phoneCookie = await loadPage(info);
		const laptopCookie = await loadPage(info);
		assert.notStrictEqual(phoneCookie, laptopCookie, 'each load without a session must be issued one of its own');

		const phone = await openBridge(store, info, phoneCookie);
		await openBridge(store, info, laptopCookie, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

		assert.deepStrictEqual(
			server.clients.map(client => client.label).sort(),
			['Mac (Chrome)', 'iPhone (Safari)'],
			'both clients must be listed, each under its own name');

		const phoneId = server.clients.find(client => client.label === 'iPhone (Safari)')!.id;
		assert.strictEqual(server.disconnectClient(phoneId), true);

		const { WebSocket } = await ws();
		await until(() => phone.readyState === WebSocket.CLOSED, 'the disconnected client\'s socket must be closed');
		assert.deepStrictEqual(server.clients.map(client => client.label), ['Mac (Chrome)']);

		assert.strictEqual(server.disconnectClient(phoneId), false, 'a client that is already gone is not an error');
		assert.strictEqual(server.disconnectClient('client-never-issued'), false);
	});

	/**
	 * Closing the socket alone would not be a disconnect: the page reconnects
	 * its bridge by itself the moment one dies, so the device would be back
	 * before the button had finished animating. The session the cookie carries
	 * is taken back with it.
	 *
	 * What this deliberately does not do is lock the device out: the address is
	 * the credential, and a device that still has the link can load the page and
	 * be issued a session of its own. Taking the address back is what rolling
	 * the pairing is for, and the last leg here pins that boundary down.
	 */
	test('a disconnected client cannot resume on the session it was holding', async () => {
		fs.writeFileSync(path.join(bundleRoot, 'thing.js'), 'globalThis.fumie = 1;');
		const upstream = await startEchoUpstream(store);
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: async () => upstream.url,
		}));
		const info = await server.start();
		const cookie = await loadPage(info);
		await openBridge(store, info, cookie);

		server.disconnectClient(server.clients[0].id);

		const rejections: string[] = [];
		store.add(server.onDidRejectUpgrade(reason => rejections.push(reason)));
		const resumed = new (await ws()).WebSocket(
			`ws://127.0.0.1:${info.port}/m/${info.capability}${WS_PATH}`,
			{ headers: { cookie } });
		store.add({ dispose: () => resumed.close() });
		const refused = await new Promise<Error>(resolve => {
			resumed.once('error', resolve);
			resumed.once('open', () => resolve(new Error('unexpectedly opened')));
		});
		assert.ok(
			/Unexpected server response: 403/.test(refused.message),
			`the revoked session must be refused, got: ${refused.message}`);
		assert.deepStrictEqual(rejections, ['403 the request carried no valid session cookie']);
		assert.strictEqual(
			(await get(`${info.localUrl}/bundle/thing.js`, { cookie })).status, 403,
			'the revoked session must not be good for the bundle either');

		const reissued = await loadPage(info);
		assert.notStrictEqual(reissued, cookie, 'loading the page again must issue a session of its own');
		await openBridge(store, info, reissued);
		assert.strictEqual(server.clients.length, 1, 'a device that still has the link is not banned, only signed out');
	});

	/**
	 * A cookie issued before cookies carried a session is still a cookie this
	 * capability answers to. Refusing it would take every phone with a live page
	 * off the machine on the first launch after an update, and the page reports
	 * a refused bridge as a failure banner.
	 */
	test('a cookie from before sessions existed is still honoured', async () => {
		const upstream = await startEchoUpstream(store);
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: async () => upstream.url,
		}));
		const info = await server.start();

		await openBridge(store, info, `fumie_mobile=${info.capability}`);
		assert.strictEqual(server.clients.length, 1, 'the older cookie must still reach the bridge');
	});

	test('names a client from what its browser says it is', () => {
		assert.deepStrictEqual([
			describeMobileClient(IPHONE_SAFARI),
			describeMobileClient('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/126.0 Mobile/15E148 Safari/605.1.15'),
			describeMobileClient('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'),
			describeMobileClient('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'),
			describeMobileClient('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0'),
			describeMobileClient('curl/8.4.0'),
			describeMobileClient(undefined),
		], [
			// Every browser on iOS claims to be Safari and both Edge and Opera
			// claim to be Chrome, which is what the marker order is for.
			'iPhone (Safari)',
			'iPad (Firefox)',
			'Android (Chrome)',
			'Mac (Chrome)',
			'Windows (Edge)',
			'Unknown device',
			'Unknown device',
		]);
	});

	/**
	 * Every socket arrives from 127.0.0.1 because the server binds loopback, so
	 * the peer address cannot tell a phone on the far side of the relay from a
	 * browser on this machine. The Host header survives the forwarding.
	 */
	test('tells a tunnelled client from one on this machine', () => {
		assert.deepStrictEqual([
			mobileClientTransport('127.0.0.1:39001'),
			mobileClientTransport('localhost:39001'),
			mobileClientTransport('[::1]:39001'),
			mobileClientTransport(undefined),
			mobileClientTransport('fumie-mobile-39001.usw3.devtunnels.ms'),
		], ['local', 'local', 'local', 'local', 'tunnel']);
	});

	test('serves the entry page only at its own capability path', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();

		assert.strictEqual((await get(`http://127.0.0.1:${info.port}/`)).status, 404);
		assert.strictEqual((await get(`http://127.0.0.1:${info.port}/m/not-the-capability`)).status, 404);
		assert.strictEqual((await get(info.localUrl)).status, 200);
		assert.strictEqual((await get(`${info.localUrl}/`)).status, 200);
	});

	/**
	 * The bug this guards: the client bundle is ~20MB of JavaScript and the
	 * server used to pipe it verbatim. Over a tunnel that is roughly 45 seconds
	 * of blank screen — long enough that every reader called it a hang and went
	 * looking for a deadlock. It compresses to about a quarter of that.
	 */
	test('compresses the client bundle rather than sending it verbatim', async () => {
		const { gunzipSync } = await import('zlib');
		const bundleDir = path.join(bundleRoot, 'vs', 'sessions');
		fs.mkdirSync(bundleDir, { recursive: true });
		const contents = 'globalThis.fumie = "x";\n'.repeat(4000);
		fs.writeFileSync(path.join(bundleDir, 'sessions.web.main.internal.js'), contents);

		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const cookie = String((await get(info.localUrl)).headers['set-cookie']?.[0]).split(';')[0];

		const compressed = await getRaw(
			`${info.localUrl}/bundle/vs/sessions/sessions.web.main.internal.js`,
			{ cookie, 'accept-encoding': 'gzip, deflate, br' });

		assert.strictEqual(compressed.status, 200);
		assert.strictEqual(compressed.headers['content-encoding'], 'gzip');
		assert.strictEqual(compressed.headers['vary'], 'Accept-Encoding');
		assert.ok(
			compressed.body.length < Buffer.byteLength(contents) / 2,
			`a compressed bundle must be markedly smaller, got ${compressed.body.length} of ${Buffer.byteLength(contents)}`);
		assert.strictEqual(gunzipSync(compressed.body).toString('utf8'), contents);
	});

	test('sends a file verbatim to a client that does not accept gzip', async () => {
		const bundleDir = path.join(bundleRoot, 'vs', 'sessions');
		fs.mkdirSync(bundleDir, { recursive: true });
		const contents = 'globalThis.fumie = "x";\n'.repeat(4000);
		fs.writeFileSync(path.join(bundleDir, 'sessions.web.main.internal.js'), contents);

		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const cookie = String((await get(info.localUrl)).headers['set-cookie']?.[0]).split(';')[0];

		const plain = await getRaw(
			`${info.localUrl}/bundle/vs/sessions/sessions.web.main.internal.js`,
			{ cookie, 'accept-encoding': 'identity' });

		assert.strictEqual(plain.status, 200);
		assert.strictEqual(plain.headers['content-encoding'], undefined);
		assert.strictEqual(plain.headers['content-length'], String(Buffer.byteLength(contents)));
		assert.strictEqual(plain.body.toString('utf8'), contents);
	});

	/**
	 * The bug this guards: the workbench resolves lazily-loaded node modules
	 * against `_VSCODE_FILE_ROOT` as `vs/../../node_modules/...`, which a browser
	 * normalises to a sibling of `bundle/` before sending. The server only ever
	 * routed `bundle/`, so xterm and katex 404ed on every phone.
	 */
	test('serves the node modules the workbench loads beside the bundle', async () => {
		const xtermDir = path.join(bundleRoot, 'node_modules', '@xterm', 'xterm', 'lib');
		fs.mkdirSync(xtermDir, { recursive: true });
		fs.writeFileSync(path.join(xtermDir, 'xterm.js'), 'exports.Terminal = 1;');

		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const cookie = String((await get(info.localUrl)).headers['set-cookie']?.[0]).split(';')[0];

		const served = await get(`${info.localUrl}/node_modules/@xterm/xterm/lib/xterm.js`, { cookie });
		assert.strictEqual(served.status, 200);
		assert.strictEqual(served.body, 'exports.Terminal = 1;');

		const outsideBundle = await get(`${info.localUrl}/node_modules/../../../etc/hosts`, { cookie });
		assert.strictEqual(outsideBundle.status, 404, 'the node module route must not escape the bundle root');
	});

	/**
	 * The bug this guards: the wait for a real viewport retried on
	 * `requestAnimationFrame`. A hidden tab never paints, so its animation frames
	 * never run — the one case the wait exists for was the one case it could not
	 * finish, and the page sat on the startup text forever. Timers still fire in
	 * a hidden tab, merely throttled.
	 */
	test('waits for a viewport on a timer, so a tab that is not painting still boots', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();

		const { body } = await get(info.localUrl);
		const wait = body.slice(body.indexOf('const waitForViewport'), body.indexOf('const { create }'));
		assert.ok(wait.length > 0, 'the page must still wait for a viewport before booting');
		assert.ok(
			!wait.includes('requestAnimationFrame'),
			'the viewport wait must not retry on requestAnimationFrame, which never fires in a hidden tab');
		assert.ok(
			wait.includes('setInterval'),
			'the viewport wait must retry on a timer');
	});

	/**
	 * The bug this guards: the post-boot banner had no height of its own, and
	 * what lands in it is whatever stack the workbench threw. One failed
	 * text-model resolve — a binary file in a changeset is enough — measured
	 * 699px of banner at a 390px width, 83% of a 844px phone; a deeper stack
	 * grows past the top of the screen, where a fixed element is clipped, so the
	 * client is covered and the message cannot be read either.
	 *
	 * The same banner also carried cancellations — switching session before a
	 * model resolves reaches the page as an unhandled rejection — so nothing had
	 * broken, yet the report covered the bottom of the screen, which is where
	 * the workbench docks the panel: the terminal was on screen and unreachable
	 * underneath it.
	 */
	test('bounds the post-boot banner and does not raise it for a cancellation', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();

		const { body } = await get(info.localUrl);
		const style = body.slice(body.indexOf('banner.style.cssText'), body.indexOf('bannerSentence = document'));
		assert.ok(style.length > 0, 'the page must still style the banner');
		assert.ok(/max-height:\s*\d+vh/.test(style), 'the banner must cap its height against the viewport');
		assert.ok(/overflow:\s*auto/.test(style), 'a capped banner must scroll, or the message is unreadable');
		assert.ok(
			body.includes(`value.name === 'Canceled' && value.message === 'Canceled'`),
			'the page must recognise a cancellation the way isCancellationError does');

		const page = loadReporter(body);
		page.setBooted(true);
		const cancelled = { name: 'Canceled', message: 'Canceled' };
		page.showError(cancelled);
		assert.strictEqual(page.banner(), undefined, 'a cancellation must not put anything on the screen');
		assert.ok(
			page.log().some(line => line.includes('[cancelled] Canceled')),
			`a cancellation must still be written down: ${page.log().join(' | ')}`);
	});

	/**
	 * The bug this guards: the banner was only ever taken down by a bridge that
	 * reconnected, so one raised by anything else stayed for the life of the
	 * page — pinned to the bottom at the maximum z-index, as tall as the stack
	 * trace it carried, swallowing the clicks meant for the panel beneath it.
	 * A phone has no console and no way to close it.
	 */
	test('the failure banner is dismissible and cannot grow over the panel', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();

		const { body } = await get(info.localUrl);
		const banner = body.slice(body.indexOf('const buildBanner'), body.indexOf('const showFailure'));
		assert.ok(banner.length > 0, 'the page must still be able to raise a banner');
		assert.ok(
			banner.includes('max-height:25vh') && banner.includes('overflow:auto'),
			'the banner must cap its height and scroll, so a long report cannot take the panel with it');

		const page = loadReporter(body);
		page.setBooted(true);
		page.showError(new Error('boom'));
		const raised = page.banner();
		assert.ok(raised, 'a real failure must reach the screen');
		raised.button('×').click();
		assert.strictEqual(page.banner(), undefined, 'the banner must carry a control that takes it back down');
	});

	/**
	 * The rule the user asked for, in the case that started it: a wall of
	 * `dispose`/`cancel` frames filled the whole screen because the banner
	 * carried the raw stack, and a failed text-model resolve cascades. What he
	 * gets now is one sentence in his own language, with the stack folded
	 * behind it — deleting the stack is not on the table, it is what found the
	 * real bug twice.
	 */
	test('a real failure is one plain sentence with its stack folded away', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const { body } = await get(info.localUrl);

		const page = loadReporter(body);
		page.setBooted(true);
		const failure = new Error('Unable to resolve text model for resource agent-host://this-mac/logo.png');
		failure.stack = `${failure.message}\n    at dispose\n    at cancel\n    at dispose\n    at cancel`;
		page.showError(failure);

		const banner = page.banner();
		assert.ok(banner, 'a real failure must be shown, not swallowed');
		// allow-any-unicode-next-line
		assert.strictEqual(banner.text.replace(/\s+/g, ' ').trim(), '刚才那一步没成功 详情 日志 ×',
			'what is on screen must be one sentence and its controls, with no stack in it');
		assert.ok(!banner.text.includes('at dispose'), 'the stack must not be the default view');

		// allow-any-unicode-next-line
		banner.button('详情').click();
		assert.ok(
			banner.text.includes('at dispose') && banner.text.includes('agent-host://this-mac/logo.png'),
			`the detail must reveal the whole report: ${banner.text}`);
	});

	/**
	 * The other half of the same rule: a cascade must not become a column of
	 * banners, and dismissing one must not silence a different fault. The first
	 * cut of this fix keyed the quiet-after-dismissal window on the sentence —
	 * and every client failure shares one sentence, because the page cannot
	 * know which step the user was on — so one dismissal muted everything that
	 * followed it for five seconds.
	 */
	test('a cascade counts on one line, and a different failure still comes up', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const { body } = await get(info.localUrl);

		const page = loadReporter(body);
		page.setBooted(true);
		const sameFailure = () => {
			const error = new Error('Unable to resolve text model');
			error.stack = 'Unable to resolve text model\n    at resolve';
			return error;
		};
		for (let i = 0; i < 5; i++) {
			page.showError(sameFailure());
		}
		assert.strictEqual(
			page.body.children.filter(child => child.style.cssText.includes('max-height:25vh')).length, 1,
			'five failures must produce one banner, not five');
		// allow-any-unicode-next-line
		assert.ok(page.banner()!.text.includes('（共 5 次）'), `the repeat must be counted: ${page.banner()!.text}`);

		page.banner()!.button('×').click();
		page.showError(sameFailure());
		assert.strictEqual(page.banner(), undefined, 'the failure just dismissed must not spring straight back up');
		assert.ok(
			page.log().some(line => line.includes('held back')),
			'a report held back must say so in the log, or the evidence is gone');

		page.showError(new TypeError('something else entirely'));
		assert.ok(page.banner(), 'a different failure must still be reported at once');
	});

	/**
	 * The requirement that outranks the quiet screen: everything goes in the
	 * log — what was shown, what was deliberately not, and the workbench's own
	 * stream, which is where the eight "[RemoteAgentHostProtocol] Request N
	 * failed" warnings behind opening one session live. A phone cannot open a
	 * console, so a line that only reaches one does not exist.
	 */
	test('the log holds what the screen was spared, and can be taken off the phone', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const { body } = await get(info.localUrl);

		const page = loadReporter(body);
		page.setBooted(true);
		page.showError({ name: 'Canceled', message: 'Canceled' });
		page.showError(new Error('a real one'));
		page.dispatch('error', { error: new Error('from the window') });

		const log = page.log().join('\n');
		assert.ok(log.includes('[cancelled] Canceled'), 'a cancellation kept off the screen must be in the log');
		assert.ok(log.includes('[failure]') && log.includes('a real one'), 'a shown failure must be in the log too');
		assert.ok(log.includes('from the window'), 'the window error hook must feed the same log');

		// The only way off the device: open it and copy it.
		page.setHash('#log');
		const panel = page.logPanel();
		assert.ok(panel, 'adding #log to the address must open the log without reloading the client');
		// allow-any-unicode-next-line
		panel.button('复制').click();
		assert.strictEqual(page.copied.length, 1, 'the log panel must copy the log');
		assert.ok(page.copied[0].includes('a real one'), 'what is copied must be the log itself');
	});

	/**
	 * The console tap, on its own: the workbench logs through `console`, and
	 * `ConsoleLogger` prefixes every line with a '%cLEVEL' marker and the CSS
	 * to paint it. Both halves matter — the line has to be captured, and it has
	 * to stay readable as text.
	 */
	test('the workbench log stream lands in the log the phone can hand back', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const { body } = await get(info.localUrl);

		const page = loadReporter(body);
		page.emitConsole('warn', '%c WARN', 'color: #993', '[RemoteAgentHostProtocol] Request 41 failed: NotFound');

		const captured = page.log().find(line => line.includes('Request 41 failed'));
		assert.ok(captured, `a workbench warning must reach the page log: ${page.log().join(' | ')}`);
		assert.ok(!captured.includes('color: #993'), `the console styling must not survive into the log: ${captured}`);
		assert.ok(captured.includes('WARN'), `the level must survive into the log: ${captured}`);
		assert.strictEqual(page.consoleOutput.length, 1, 'the tap must forward to the console it wrapped, not replace it');
	});

	/**
	 * Silencing a boot failure would be worse than any amount of noise: there
	 * is no client behind the message and nothing to do but read it. It takes
	 * the whole screen, at once, with the same fold underneath.
	 */
	test('a first load that fails reports at once, on the whole screen', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const { body } = await get(info.localUrl);

		const page = loadReporter(body);
		page.showError(new TypeError('Failed to fetch dynamically imported module: /m/cap/bundle/workbench.js'));

		assert.strictEqual(page.banner(), undefined, 'a boot failure is not a banner over a client that is not there');
		// allow-any-unicode-next-line
		assert.ok(page.startup.text.includes('Fumie 手机端启动失败'), `the boot failure must say so: ${page.startup.text}`);
		assert.ok(!page.startup.text.includes('Failed to fetch'), 'the technical half starts folded here too');
		// allow-any-unicode-next-line
		page.startup.button('详情').click();
		assert.ok(
			page.startup.text.includes('Failed to fetch dynamically imported module'),
			`the detail must be one tap away: ${page.startup.text}`);
	});

	/**
	 * The bug this guards: the page reported every close of the bridge, and a
	 * phone drops that socket for a living — the screen locks and the tab is
	 * frozen, the network hands over, the tunnel relay times a quiet socket out
	 * (measured at ~100s of silence, closing with 1006 and no close frame). The
	 * client reconnects on its own and resumes the same session, so what the
	 * user got for a connection that was working was "Fumie 连不上这台电脑"
	 * across the bottom of the screen every time they picked the phone up.
	 *
	 * Runs the page's own watcher rather than asserting on its source: the bug
	 * is in *when* it reports, which a regex cannot see.
	 */
	test('a bridge that drops and comes back reports nothing', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const { body } = await get(info.localUrl);

		const watch = loadBridgeWatcher(body);

		// A socket that opens, then dies the way the relay kills a quiet one.
		const first = new FakeSocket();
		watch.watchBridge(first, 'wss://example/__mobile-agent-host');
		first.emit('open');
		first.emit('close', { code: 1006, reason: '' });
		assert.strictEqual(watch.reports.length, 0, 'a drop must not be reported before the client has had a chance to reconnect');

		// The reconnect attempt that fails to open is part of the same outage,
		// not a new one to report.
		const failed = new FakeSocket();
		watch.watchBridge(failed, 'wss://example/__mobile-agent-host');
		failed.emit('close', { code: 1006, reason: '' });
		assert.strictEqual(watch.reports.length, 0, 'a reconnect attempt that fails must not be reported either');

		// The attempt that lands ends the outage silently.
		const second = new FakeSocket();
		watch.watchBridge(second, 'wss://example/__mobile-agent-host');
		second.emit('open');
		assert.strictEqual(watch.reports.length, 0, 'a recovered bridge must never have reported');
		assert.strictEqual(watch.pendingTimers(), 0, 'the pending report must be cancelled, not left to fire');
		assert.ok(
			watch.cleared.length > 0 && watch.cleared.every(source => source === 'bridge'),
			`a reconnected bridge must take down the report it left behind, and only that one: ${watch.cleared.join(',')}`);
		assert.ok(
			watch.log.some(line => line.includes('waiting out the reconnect')),
			`a drop kept off the screen must still be written down: ${watch.log.join(' | ')}`);
	});

	/**
	 * The other half of the same change: silence that outlasts the reconnect is
	 * still worth a banner, and a bridge that never opened at all is reported at
	 * once — the page is dead until someone acts on it, and the refusal detail
	 * the server sends is the only thing that says why.
	 */
	test('a bridge that stays down is still reported, and one that never opened is reported at once', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
		}));
		const info = await server.start();
		const { body } = await get(info.localUrl);

		const stayed = loadBridgeWatcher(body);
		const dropped = new FakeSocket();
		stayed.watchBridge(dropped, 'wss://example/__mobile-agent-host');
		dropped.emit('open');
		dropped.emit('close', { code: 1006, reason: '' });
		assert.strictEqual(stayed.reports.length, 0);
		stayed.runTimers();
		assert.strictEqual(stayed.reports.length, 1, 'a bridge that does not come back must be reported');
		assert.ok(
			stayed.reports[0].includes('the bridge was open and then closed') && stayed.reports[0].includes('code=1006'),
			`the report must still carry how far the socket got and why it ended: ${stayed.reports[0]}`);

		const never = loadBridgeWatcher(body);
		const refused = new FakeSocket();
		never.watchBridge(refused, 'wss://example/__mobile-agent-host');
		refused.emit('close', { code: 1006, reason: '' });
		assert.strictEqual(never.reports.length, 1, 'a bridge that never opened must be reported without a wait');
		assert.ok(
			never.reports[0].includes('the bridge never opened'),
			`the report must say the socket never got up: ${never.reports[0]}`);
	});

	/**
	 * The branch above, against a real one. "The first socket never opens" was
	 * the one path that had never been seen happen: it needs a page served
	 * while its bridge is already dead, which no fake socket can prove. Here
	 * the server really is up and really has no agent host to reach, so the
	 * upgrade is really refused, and the page's own watcher sees the real
	 * close event — no wait, and the refusal detail carried with it.
	 */
	test('a page served while its bridge is already dead says so immediately', async () => {
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('no agent host on this machine')),
		}));
		const info = await server.start();
		const page = await get(info.localUrl);
		const cookie = String(page.headers['set-cookie']?.[0]).split(';')[0];

		const watch = loadBridgeWatcher(page.body);
		const url = `ws://127.0.0.1:${info.port}/m/${info.capability}${WS_PATH}`;
		const socket = new (await ws()).WebSocket(url, { headers: { cookie } });
		store.add({ dispose: () => socket.close() });
		// `ws` sends an 'error' for a refused upgrade before the 'close' the
		// watcher listens for; without a listener Node would raise it.
		socket.on('error', () => { });
		watch.watchBridge(socket, url);

		await new Promise<void>(resolve => socket.on('close', () => setTimeout(resolve, 0)));
		assert.strictEqual(watch.reports.length, 1, 'a bridge that was never going to open must be reported at once');
		assert.ok(
			watch.reports[0].includes('the bridge never opened'),
			`the report must say the socket never got up: ${watch.reports[0]}`);
		assert.strictEqual(watch.pendingTimers(), 0, 'a first socket must not wait out a reconnect that is not coming');
	});

	/**
	 * The bug this guards: the capability was 16 fresh random bytes per process
	 * and the port came from `listen(0)`, so every restart of the app produced a
	 * different address and the user had to copy a new URL onto the phone. Given
	 * a pairing, two runs answer at the same one.
	 */
	test('two runs of one pairing answer at the same address', async () => {
		const pairing = { capability: 'a-capability-that-outlives-the-process', port: await freePort() };

		const first = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
			...pairing,
		}));
		const firstInfo = await first.start();
		first.dispose();

		const second = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
			...pairing,
		}));
		const secondInfo = await second.start();

		assert.strictEqual(secondInfo.localUrl, firstInfo.localUrl);
		assert.strictEqual(secondInfo.port, pairing.port, 'the pinned port must be the one that was asked for');
		assert.ok(firstInfo.localUrl.endsWith(`/m/${pairing.capability}`));
		assert.strictEqual((await get(secondInfo.localUrl)).status, 200, 'the address the first run handed out must still be served');
	});

	/**
	 * The other half of persisting the capability: it has to be revocable, or a
	 * secret that survives restarts is strictly worse than one that does not.
	 * Rolling it must take down every URL and every cookie issued before it.
	 */
	test('a rolled pairing kills the address the previous one issued', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fumie-mobile-web-roll-test-'));
		try {
			fs.writeFileSync(path.join(bundleRoot, 'thing.js'), 'globalThis.fumie = 1;');
			const before = await readOrCreateMobileWebPairing(directory);

			const first = store.add(new MobileWebServer({
				webBundleRoot: bundleRoot,
				resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
				capability: before.secret,
				port: await freePort(),
			}));
			const firstInfo = await first.start();
			const staleCookie = String((await get(firstInfo.localUrl)).headers['set-cookie']?.[0]).split(';')[0];
			first.dispose();

			const { pairing: after } = await rollMobileWebPairing(directory);
			const second = store.add(new MobileWebServer({
				webBundleRoot: bundleRoot,
				resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
				capability: after.secret,
				port: firstInfo.port,
			}));
			const secondInfo = await second.start();

			assert.strictEqual((await get(firstInfo.localUrl)).status, 404, 'the old capability path must be gone');
			assert.strictEqual(
				(await get(`${secondInfo.localUrl}/bundle/thing.js`, { cookie: staleCookie })).status, 403,
				'a phone still holding the old cookie must be turned away');
			const freshCookie = String((await get(secondInfo.localUrl)).headers['set-cookie']?.[0]).split(';')[0];
			assert.strictEqual(
				(await get(`${secondInfo.localUrl}/bundle/thing.js`, { cookie: freshCookie })).status, 200,
				'the new address must work in its place');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	/**
	 * A pinned port is a promise about an address, and something else on this
	 * machine can take it. Coming up on another port anyway is the right call —
	 * the local address still works — but doing it quietly would recreate the
	 * exact failure pinning exists to remove, with nothing to read afterwards.
	 */
	test('a pinned port that is taken is fallen back from out loud', async () => {
		const blocker = (await nodeHttp()).createServer();
		await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
		const { port } = blocker.address() as { port: number };
		store.add({ dispose: () => blocker.close() });

		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: () => Promise.reject(new Error('unused')),
			capability: 'a-capability',
			port,
		}));
		const fallbacks: string[] = [];
		store.add(server.onDidFallBackFromPinnedPort(reason => fallbacks.push(reason)));

		const info = await server.start();

		assert.notStrictEqual(info.port, port, 'a taken port must not stop the local address working');
		assert.strictEqual(fallbacks.length, 1, 'the address moving must be reported, not absorbed');
		assert.ok(fallbacks[0].includes(String(port)), `the report must name the port that was lost: ${fallbacks[0]}`);
		assert.strictEqual((await get(info.localUrl)).status, 200);
	});

	/**
	 * The bug this guards: every event this server reports carried the request
	 * path, and every path a working client asks for begins `/m/<the
	 * capability>` — so a phone connecting wrote the secret into the log, once
	 * per connection. Survivable while the capability died with the process;
	 * not survivable now that one is kept on disk and reused.
	 *
	 * Everything the server hands its owner is collected here, because the
	 * failure mode is somebody adding a convenient report later, not this one
	 * line coming back.
	 */
	test('nothing the server reports contains the capability', async () => {
		const upstream = await startEchoUpstream(store);
		const capability = 'a-capability-that-must-not-be-logged';
		const server = store.add(new MobileWebServer({
			webBundleRoot: bundleRoot,
			resolveAgentHostUrl: async () => upstream.url,
			capability,
		}));
		const info = await server.start();

		const reported: string[] = [];
		store.add(server.onDidReceiveUpgrade(request => reported.push(request)));
		store.add(server.onDidRejectUpgrade(reason => reported.push(reason)));
		store.add(server.onDidFallBackFromPinnedPort(reason => reported.push(reason)));
		store.add(server.onDidFailToReachAgentHost(error => reported.push(String(error))));

		// A bridge that is served, one turned away for want of a cookie, and one
		// that misses the route — the three paths that reach the report.
		const cookie = String((await get(info.localUrl)).headers['set-cookie']?.[0]).split(';')[0];
		const bridged = new (await ws()).WebSocket(`ws://127.0.0.1:${info.port}/m/${capability}${WS_PATH}`, { headers: { cookie } });
		store.add({ dispose: () => bridged.close() });
		await new Promise<void>((resolve, reject) => {
			bridged.once('open', () => resolve());
			bridged.once('error', reject);
		});

		for (const path of [`/m/${capability}${WS_PATH}`, `/m/${capability}/not-the-bridge`]) {
			const refused = new (await ws()).WebSocket(`ws://127.0.0.1:${info.port}${path}`);
			store.add({ dispose: () => refused.close() });
			await new Promise<void>(resolve => refused.once('error', () => resolve()));
		}

		assert.ok(reported.length >= 4, `the reports must still be made: ${reported.join(' | ')}`);
		for (const line of reported) {
			assert.ok(!line.includes(capability), `a report leaked the capability: ${line}`);
		}
		assert.ok(
			reported.some(line => line.includes(`/m/<capability>${WS_PATH}`)),
			`the route asked for must survive the redaction: ${reported.join(' | ')}`);
	});

	/**
	 * The other half of the same rule, one layer up. `mobileWebHosting.ts`
	 * writes to a log file that is kept, copied into bug reports and read over
	 * shoulders, and it holds the one place a whole public URL exists — so no
	 * log line there may name a URL or the capability. This reads the source
	 * because the leak is a line somebody adds, not a branch a test can drive:
	 * the hosting service needs a real Dev Tunnel to reach that code at all.
	 */
	test('no log line in mobile web hosting names a URL or the capability', () => {
		const hosting = path.join(process.cwd(), 'src', 'vs', 'platform', 'agentHost', 'node', 'fumie', 'mobileWebHosting.ts');
		const logLines = fs.readFileSync(hosting, 'utf8')
			.split('\n')
			.filter(line => /_logService\.(trace|debug|info|warn|error)\(/.test(line));

		assert.ok(logLines.length > 0, 'the hosting service must still say what it is doing');
		for (const line of logLines) {
			for (const forbidden of ['capability', 'publicUrl', 'localUrl']) {
				assert.ok(
					!line.includes(forbidden),
					`a log line names '${forbidden}', which carries the persisted secret: ${line.trim()}`);
			}
		}
	});

	/**
	 * The bug this guards: the dev tunnel used to carry a
	 * `mobile-<first ten characters of the capability>` label, publishing a
	 * tenth of the secret into tunnel metadata. Cheap while the capability died
	 * with the process; not cheap now that it survives restarts.
	 */
	test('the dev tunnel carries no part of the capability in its metadata', () => {
		const hosting = path.join(process.cwd(), 'src', 'vs', 'platform', 'agentHost', 'node', 'fumie', 'mobileWebHosting.ts');
		const source = fs.readFileSync(hosting, 'utf8');
		const start = source.indexOf('labels: [');
		assert.ok(start > 0, 'the tunnel must still be labelled');
		const labels = source.slice(start, source.indexOf(']', start) + 1);
		assert.ok(
			!labels.includes('capability'),
			`no part of the capability may reach tunnel metadata: ${labels}`);
	});

	/**
	 * The bug this guards: the phone client and the preview harness each carried
	 * their own copy of this page, and the copies drifted — the preview never
	 * received the post-boot error banner, and shipped a stale bundle. They now
	 * render from one module, and this fails if a second copy reappears.
	 */
	/**
	 * The bug this guards: the phone server bound every interface, so anyone on
	 * the same network who had the URL reached the whole agent host with no
	 * sign-in at all — the dev tunnel's GitHub gate only covers the tunnel. The
	 * one address that may skip a sign-in is this machine's own.
	 */
	test('the phone server is bound to loopback, not to every interface', () => {
		const hosting = path.join(process.cwd(), 'src', 'vs', 'platform', 'agentHost', 'node', 'fumie', 'mobileWebHosting.ts');
		const source = fs.readFileSync(hosting, 'utf8');
		assert.ok(
			source.includes(`host: '127.0.0.1'`),
			'mobile web hosting must bind loopback');
		assert.ok(
			!source.includes(`host: '0.0.0.0'`),
			'binding every interface hands the agent host to the local network without a sign-in');
	});

	/**
	 * Purity is what lets the test above hold the two servers' pages against
	 * each other, and the client id is the first thing that was ever tempted to
	 * break it: minting one per render would make every load a different page.
	 */
	test('the same options still render the same bytes, client id and all', () => {
		const options = {
			fileRootPath: '/m/x/bundle',
			stylesheetPath: '/m/x/bundle/style.css',
			modulePath: '/m/x/bundle/main.js',
			agentHostPath: `/m/x${WS_PATH}`,
			nameShort: 'Fumie',
			nameLong: 'Fumie Mobile',
		};
		const page = renderMobileWebClientPage(options);
		assert.strictEqual(page, renderMobileWebClientPage(options));
		assert.ok(page.includes('clientId,'), 'the entry must carry the id the page read');
		assert.ok(
			!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(page),
			'an id baked into the page would be a different page every load');
	});

	test('the preview harness renders the same client page, not a copy of its own', () => {
		const previewServer = path.join(process.cwd(), 'scripts', 'mobile-agent-preview', 'server.ts');
		const source = fs.readFileSync(previewServer, 'utf8');
		assert.ok(
			source.includes('mobileWebClientPage'),
			'the preview harness must render the shared client page module');
		assert.ok(
			!source.includes('fumie-mobile-startup'),
			'the preview harness must not carry its own copy of the client page');
	});
});

suite('desktop agent host selection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('addresses the agent host socket the way ws parses an IPC url', () => {
		const url = desktopAgentHostSocketUrl(editorEndpoint({ connectionToken: 'a/b+c' }) as never);
		assert.strictEqual(url, 'ws+unix:///tmp/agent-host-a.sock:/?tkn=a%2Fb%2Bc');

		// `ws` splits the request path on ':' to recover the socket path.
		const [socketPath, requestPath] = new URL(url).pathname.concat(new URL(url).search).split(':');
		assert.strictEqual(socketPath, '/tmp/agent-host-a.sock');
		assert.strictEqual(requestPath, '/?tkn=a%2Fb%2Bc');
	});

	test('ignores standalone and TCP entries', () => {
		const socketPath = path.join(os.tmpdir(), `fumie-endpoint-test-${process.pid}.sock`);
		fs.writeFileSync(socketPath, '');
		try {
			const live = liveEditorSocketEndpoints([
				editorEndpoint({ type: 'standalone', endpoint: { type: 'socket', path: socketPath } }),
				editorEndpoint({ endpoint: { type: 'tcp', host: '127.0.0.1', port: 1234 } }),
				editorEndpoint({ endpoint: { type: 'socket', path: socketPath } }),
			]);
			assert.deepStrictEqual(live.map(entry => entry.endpoint.path), [socketPath]);
		} finally {
			fs.rmSync(socketPath, { force: true });
		}
	});

	test('drops an editor entry whose socket file is gone', () => {
		if (process.platform === 'win32') {
			return;
		}
		assert.deepStrictEqual(liveEditorSocketEndpoints([editorEndpoint()]), []);
	});

	test('picks this app’s own agent host when several desktops publish one', async () => {
		const mine = editorEndpoint({ pid: 11, instanceId: 'mine' }) as never;
		const theirs = editorEndpoint({ pid: 22, instanceId: 'theirs' }) as never;
		const parents = new Map([[11, 100], [22, 200]]);
		const chosen = await selectOwnEditorEndpoint(
			[theirs, mine],
			pid => Promise.resolve(parents.get(pid)),
			100,
			new NullLogService(),
		);
		assert.strictEqual(chosen?.instanceId, 'mine');
	});

	test('does not fork a lookup when there is only one agent host', async () => {
		const only = editorEndpoint() as never;
		const chosen = await selectOwnEditorEndpoint(
			[only],
			() => Promise.reject(new Error('the parent pid must not be looked up')),
			100,
			new NullLogService(),
		);
		assert.strictEqual(chosen, only);
	});

	test('has nothing to pick when no desktop publishes an agent host', async () => {
		assert.strictEqual(
			await selectOwnEditorEndpoint([], () => Promise.resolve(undefined), 100, new NullLogService()),
			undefined,
		);
	});
});

suite('mobile web tunnel record', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads back the tunnel a run recorded, so a crashed run stops costing an allowance', () => {
		assert.deepStrictEqual(
			parseMobileWebTunnelRecord(JSON.stringify({ tunnelId: 'abc', clusterId: 'use' })),
			{ tunnelId: 'abc', clusterId: 'use' },
		);
	});

	test('refuses anything that is not a whole record rather than aiming a delete at a guess', () => {
		for (const raw of ['', 'not json', '[]', 'null', '"abc"', '{}', '{"tunnelId":"abc"}', '{"clusterId":"use"}', '{"tunnelId":"","clusterId":"use"}', '{"tunnelId":1,"clusterId":"use"}']) {
			assert.strictEqual(parseMobileWebTunnelRecord(raw), undefined, raw);
		}
	});
});

suite('mobile web tunnel reuse', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const PORT: TunnelPort = { portNumber: 43001, protocol: 'http', isDefault: true };
	const OPTIONS: TunnelRequestOptions = { includePorts: true };
	const REMEMBERED = { tunnelId: 'abc', clusterId: 'usw3' };

	/** A management client that records what was asked of it and answers from a script. */
	function fakeClient(script: {
		getTunnel?: (tunnel: Tunnel) => Promise<Tunnel | null>;
		createTunnel?: (tunnel: Tunnel) => Promise<Tunnel>;
		createOrUpdateTunnelPort?: (tunnel: Tunnel, port: TunnelPort) => Promise<TunnelPort>;
		deleteTunnelPort?: (tunnel: Tunnel, portNumber: number) => Promise<boolean>;
	}) {
		const calls: string[] = [];
		const client: IMobileWebTunnelClient = {
			getTunnel: async tunnel => {
				calls.push(`getTunnel ${tunnel.tunnelId}`);
				return script.getTunnel ? script.getTunnel(tunnel) : null;
			},
			createTunnel: async tunnel => {
				calls.push(`createTunnel ${JSON.stringify(tunnel.labels)}`);
				return script.createTunnel
					? script.createTunnel(tunnel)
					: { tunnelId: 'fresh', clusterId: 'usw3', ...tunnel };
			},
			createOrUpdateTunnelPort: async (_tunnel, port) => {
				calls.push(`createOrUpdateTunnelPort ${port.portNumber} deny=${port.accessControl?.entries?.length ?? 0}`);
				return script.createOrUpdateTunnelPort ? script.createOrUpdateTunnelPort(_tunnel, port) : port;
			},
			deleteTunnelPort: async (_tunnel, portNumber) => {
				calls.push(`deleteTunnelPort ${portNumber}`);
				return script.deleteTunnelPort ? script.deleteTunnelPort(_tunnel, portNumber) : true;
			},
		};
		return { client, calls };
	}

	/**
	 * The bug this guards: every start deleted the previous tunnel and created
	 * a new one, so the service handed out a new random hostname each time and
	 * the user had to re-copy the URL. A fixed name is not the fix — a personal
	 * GitHub account is refused one outright — so the tunnel itself has to be
	 * the thing that persists.
	 */
	test('reconnects to the tunnel the pairing points at instead of creating another', async () => {
		const { client, calls } = fakeClient({
			getTunnel: async () => ({ ...REMEMBERED, ports: [{ portNumber: 43001 }] }),
		});

		const resolved = await resolveMobileWebTunnel(client, REMEMBERED, PORT, OPTIONS, () => assert.fail('a reuse that worked must report nothing'));

		assert.strictEqual(resolved.reused, true);
		assert.strictEqual(resolved.tunnel.tunnelId, 'abc');
		assert.ok(!calls.some(call => call.startsWith('createTunnel')), `nothing may be created on the reuse path: ${calls.join(' | ')}`);
	});

	test('keeps the remembered tunnel across a temporary lookup failure and recovery', async () => {
		let lookups = 0;
		const { client, calls } = fakeClient({
			getTunnel: async () => {
				if (++lookups === 1) {
					throw Object.assign(new Error('Temporary service outage'), { response: { status: 503 } });
				}
				return { ...REMEMBERED, ports: [{ portNumber: PORT.portNumber }] };
			},
		});

		// A transient outage may fail this attempt or be retried internally.
		// Either way it must not replace the address of an existing tunnel.
		await resolveMobileWebTunnel(client, REMEMBERED, PORT, OPTIONS, () => undefined).catch(() => undefined);
		const recovered = await resolveMobileWebTunnel(client, REMEMBERED, PORT, OPTIONS, () => undefined);

		assert.strictEqual(recovered.reused, true);
		assert.strictEqual(recovered.tunnel.tunnelId, REMEMBERED.tunnelId);
		assert.ok(!calls.some(call => call.startsWith('createTunnel')), `a temporary lookup failure must not replace the phone address: ${calls.join(' | ')}`);
	});

	/**
	 * A reused tunnel comes back carrying whatever access control it was last
	 * left with, and the single deny-anonymous entry is the only thing between
	 * this address and the open internet. Restating it is not optional.
	 */
	test('restates the port and its deny-anonymous rule on a tunnel it did not just create', async () => {
		const { client, calls } = fakeClient({
			getTunnel: async () => ({ ...REMEMBERED, ports: [{ portNumber: 39999 }, { portNumber: 43001 }] }),
		});
		const denied: TunnelPort = {
			...PORT,
			accessControl: { entries: [{ type: TunnelAccessControlEntryType.Anonymous, isDeny: true, isInherited: false, isInverse: false, subjects: [], scopes: ['connect'] }] },
		};

		await resolveMobileWebTunnel(client, REMEMBERED, denied, OPTIONS, () => undefined);

		assert.ok(calls.includes('createOrUpdateTunnelPort 43001 deny=1'), `the port and its rule must be restated: ${calls.join(' | ')}`);
		assert.ok(calls.includes('deleteTunnelPort 39999'), `a port this run no longer serves must stop being forwarded: ${calls.join(' | ')}`);
		assert.ok(!calls.includes('deleteTunnelPort 43001'), `the port in use must survive: ${calls.join(' | ')}`);
	});

	/**
	 * The reset path, one step later: `rollMobileWebPairing` has already
	 * cleared the reference, so the next start has nothing to reconnect to and
	 * must take a fresh tunnel rather than fail for want of one.
	 */
	test('creates a tunnel when the pairing points at none, which is what a reset leaves behind', async () => {
		const { client, calls } = fakeClient({});

		const resolved = await resolveMobileWebTunnel(client, undefined, PORT, OPTIONS, () => assert.fail('a first start has nothing to warn about'));

		assert.strictEqual(resolved.reused, false);
		assert.strictEqual(resolved.tunnel.tunnelId, 'fresh');
		assert.deepStrictEqual(calls, [`createTunnel ["fumie-mobile-web"]`]);
	});

	test('creates a replacement only when the remembered tunnel is confirmed missing', async () => {
		for (const [label, script] of [
			['gone', { getTunnel: async () => null }],
			['404', { getTunnel: async () => { throw Object.assign(new Error('Not found'), { response: { status: 404 } }); } }],
		] as const) {
			const { client, calls } = fakeClient(script);
			const reported: string[] = [];

			const resolved = await resolveMobileWebTunnel(client, REMEMBERED, PORT, OPTIONS, message => reported.push(message));

			assert.strictEqual(resolved.reused, false, label);
			assert.strictEqual(resolved.tunnel.tunnelId, 'fresh', label);
			assert.strictEqual(reported.length, 1, `${label}: ${reported.join(' | ')}`);
			assert.ok(reported[0].includes('the phone address moves'), `${label}: the report must say what it costs: ${reported[0]}`);
			assert.ok(reported[0].includes('abc'), `${label}: the report must name the tunnel: ${reported[0]}`);
			assert.ok(calls.some(call => call.startsWith('createTunnel')), `${label}: ${calls.join(' | ')}`);
		}
	});

	test('preserves the tunnel when lookup fails without proving it is missing', async () => {
		for (const status of [undefined, 401, 403, 503]) {
			const failure = Object.assign(new Error('Tunnel lookup failed'), { response: status === undefined ? undefined : { status } });
			const { client, calls } = fakeClient({ getTunnel: async () => { throw failure; } });
			await assert.rejects(resolveMobileWebTunnel(client, REMEMBERED, PORT, OPTIONS, () => assert.fail('the address must not move')), error => {
				assert.ok(error instanceof Error);
				assert.ok(error.message.includes('address is preserved'));
				assert.strictEqual(error.cause, failure);
				return true;
			});
			assert.deepStrictEqual(calls, ['getTunnel abc']);
		}
	});

	test('preserves the tunnel when configuring an existing port fails even with a 404', async () => {
		for (const operation of ['createOrUpdateTunnelPort', 'deleteTunnelPort'] as const) {
			const failure = Object.assign(new Error('Port request failed'), { response: { status: 404 } });
			const { client, calls } = fakeClient({
				getTunnel: async () => ({ ...REMEMBERED, ports: [{ portNumber: 39999 }] }),
				[operation]: async () => { throw failure; },
			});
			await assert.rejects(resolveMobileWebTunnel(client, REMEMBERED, PORT, OPTIONS, () => assert.fail('the address must not move')), error => {
				assert.ok(error instanceof Error);
				assert.ok(error.message.includes('Could not configure'));
				assert.strictEqual(error.cause, failure);
				return true;
			});
			assert.ok(!calls.some(call => call.startsWith('createTunnel')), calls.join(' | '));
		}
	});

	test('real management SDK preserves a 503 address and replaces only a confirmed 404', async () => {
		const { TunnelManagementHttpClient, ManagementApiVersions } = await import('@microsoft/dev-tunnels-management');
		const { default: axios } = await import('axios');
		const http = await nodeHttp();
		let lookupStatus = 503;
		let tunnelCreates = 0;
		const server = http.createServer((request, response) => {
			const pathname = new URL(request.url!, 'http://localhost').pathname;
			response.setHeader('Content-Type', 'application/json');
			if (request.method === 'GET' && pathname === '/tunnels/abc') {
				response.statusCode = lookupStatus;
				response.end(JSON.stringify(lookupStatus === 200 ? { ...REMEMBERED, ports: [PORT] } : { message: 'Injected tunnel lookup failure' }));
			} else if (request.method === 'GET' && pathname.includes('recommendations')) {
				response.end(JSON.stringify({ recommendedClusterId: REMEMBERED.clusterId }));
			} else if (request.method === 'PUT' && pathname.includes('/ports/')) {
				response.end(JSON.stringify(PORT));
			} else if (request.method === 'PUT' && pathname.startsWith('/tunnels/')) {
				tunnelCreates++;
				response.end(JSON.stringify({ tunnelId: 'replacement', clusterId: REMEMBERED.clusterId, ports: [PORT] }));
			} else {
				response.statusCode = 500;
				response.end(JSON.stringify({ message: `Unexpected request: ${request.method} ${pathname}` }));
			}
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		const httpAdapter = axios.getAdapter('http');
		// Keep SDK request creation, Axios status handling and SDK error rewriting;
		// redirect only the HTTP destination so no account or tunnel is contacted.
		const client = new TunnelManagementHttpClient('Fumie-test', ManagementApiVersions.Version20230927preview,
			undefined, undefined, undefined, config => {
				const url = new URL(config.url!);
				return httpAdapter({ ...config, url: origin + url.pathname + url.search, proxy: false });
			});
		try {
			await assert.rejects(resolveMobileWebTunnel(client, REMEMBERED, PORT, { ...OPTIONS }, () => undefined), error => {
				assert.ok(error instanceof Error);
				assert.ok(error.message.includes('address is preserved'));
				assert.strictEqual((error.cause as { response?: { status?: number } }).response?.status, 503);
				return true;
			});
			assert.strictEqual(tunnelCreates, 0);
			lookupStatus = 200;
			const recovered = await resolveMobileWebTunnel(client, REMEMBERED, PORT, { ...OPTIONS }, () => undefined);
			assert.strictEqual(recovered.reused, true);
			assert.strictEqual(recovered.tunnel.tunnelId, REMEMBERED.tunnelId);
			assert.strictEqual(tunnelCreates, 0);
			lookupStatus = 404;
			const replacement = await resolveMobileWebTunnel(client, REMEMBERED, PORT, { ...OPTIONS }, () => undefined);
			assert.strictEqual(replacement.reused, false);
			assert.strictEqual(tunnelCreates, 1);
		} finally {
			await client.dispose();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});

suite('mobile web forwarded connections', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * The regression: Dev Tunnels pipes each forwarded connection into an
	 * `SshStream` with no `error` handler, so a relay channel that goes away
	 * under an in-flight write took the shared process's uncaught-exception
	 * handler instead of the connection's own log.
	 */
	test('a forwarded connection that dies mid-write is logged rather than thrown at the process', async () => {
		const { Duplex } = await import('stream');
		const stream = new Duplex({ read() { }, write(_chunk, _encoding, callback) { callback(new Error('SshChannel disposed.')); } });

		const logged: string[] = [];
		watchForwardedConnections(
			{ forwardedPortConnecting: listener => listener({ stream }) },
			message => logged.push(message),
		);

		// Without the listener this write is what reaches `uncaughtException`.
		stream.write('anything');
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(logged, ['A forwarded connection ended early: SshChannel disposed.']);
		stream.destroy();
	});

	test('a host that forwards nothing is left alone', () => {
		const logged: string[] = [];
		watchForwardedConnections({ forwardedPortConnecting: () => undefined }, message => logged.push(message));
		assert.deepStrictEqual(logged, []);
	});
});
