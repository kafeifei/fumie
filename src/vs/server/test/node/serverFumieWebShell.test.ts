/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import type * as http from 'http';
import * as os from 'os';
import type * as wsTypes from 'ws';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import type { IServerEnvironmentService } from '../../node/serverEnvironmentService.js';
import {
	agentHostWebSocketUrl,
	createServerFumieWebShell,
	isFumieWebShellPath,
	resolveServerWebBundleRoot,
	FUMIE_WEB_SHELL_PATH_PREFIX,
	ServerFumieWebShellServer,
	UnavailableFumieWebShellServer,
	type IFumieWebShellServer,
} from '../../node/fumie/serverFumieWebShell.js';

const WS_PATH = '/__mobile-agent-host';

async function ws(): Promise<typeof wsTypes> {
	return await import('ws');
}

async function nodeHttp(): Promise<typeof http> {
	return await import('http');
}

/** A stand-in agent host that echoes back whatever a bridged client sends. */
async function startEchoAgentHost(store: Pick<DisposableStore, 'add'>): Promise<{ url: string; seenUrls: string[] }> {
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

/**
 * A stand-in for the headless server's HTTP face: it owns the address, strips
 * the base path the way `RemoteExtensionHostAgentServer` does, and hands
 * everything under the Fumie prefix to the shell. Anything else answers with a
 * marker, which is how a test tells "the shell declined" from "the shell was
 * never asked".
 */
async function startHostServer(store: Pick<DisposableStore, 'add'>, shell: IFumieWebShellServer, basePath = ''): Promise<{ origin: string }> {
	const strip = (pathname: string) => basePath && pathname.startsWith(basePath) ? (pathname.substring(basePath.length) || '/') : pathname;
	const server = (await nodeHttp()).createServer((req, res) => {
		const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
		const stripped = strip(pathname);
		if (isFumieWebShellPath(stripped)) {
			void shell.handleRequest(req, res, stripped, pathname.substring(0, pathname.length - stripped.length));
			return;
		}
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('the host server answered this');
	});
	server.on('upgrade', (req, socket, head) => {
		const stripped = strip(new URL(req.url ?? '/', 'http://localhost').pathname);
		if (isFumieWebShellPath(stripped)) {
			shell.handleUpgrade(req, socket, head, stripped);
			return;
		}
		socket.end('HTTP/1.1 418 I\'m a teapot\r\nConnection: close\r\n\r\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	store.add({ dispose: () => server.close() });
	return { origin: `http://127.0.0.1:${port}` };
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

function environment(appRoot: string, userDataPath: string): IServerEnvironmentService {
	// eslint-disable-next-line local/code-no-any-casts
	return { appRoot, userDataPath } as any as IServerEnvironmentService;
}

suite('server Fumie web shell', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let appRoot: string;
	let bundleRoot: string;
	let userDataPath: string;

	setup(() => {
		appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fumie-web-shell-test-'));
		bundleRoot = path.join(appRoot, 'web-bundle');
		fs.mkdirSync(bundleRoot);
		userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'fumie-web-shell-data-'));
	});

	teardown(() => {
		fs.rmSync(appRoot, { recursive: true, force: true });
		fs.rmSync(userDataPath, { recursive: true, force: true });
	});

	async function shellFor(resolveAgentHostUrl: () => Promise<string>, capability = 'test-capability'): Promise<ServerFumieWebShellServer> {
		const shell = store.add(new ServerFumieWebShellServer(capability, bundleRoot, resolveAgentHostUrl, new NullLogService()));
		// The bridge's WebSocket machinery is readied asynchronously; a test that
		// dials it before that would be racing the server rather than testing it.
		await shell.ready;
		return shell;
	}

	test('the shell owns its prefix and nothing outside it', () => {
		assert.strictEqual(isFumieWebShellPath('/fumie'), true);
		assert.strictEqual(isFumieWebShellPath('/fumie/'), true);
		assert.strictEqual(isFumieWebShellPath('/fumie/m/abc'), true);
		assert.strictEqual(isFumieWebShellPath('/'), false);
		assert.strictEqual(isFumieWebShellPath('/version'), false);
		// The workbench's own routes must not be swallowed by a prefix match.
		assert.strictEqual(isFumieWebShellPath('/fumiebox'), false);
		assert.strictEqual(isFumieWebShellPath('/vscode-remote-resource'), false);
	});

	test('addresses the agent host the way ws parses each kind of endpoint', () => {
		assert.strictEqual(
			agentHostWebSocketUrl({ socketPath: '/tmp/ah.sock', connectionToken: 'tok en' }),
			'ws+unix:///tmp/ah.sock:/?tkn=tok%20en');
		assert.strictEqual(
			agentHostWebSocketUrl({ host: 'localhost', port: '7788', connectionToken: 'abc' }),
			'ws://localhost:7788/?tkn=abc');
		// A spawn configuration without a mandatory connection token is a real
		// case; the url must still be dialable.
		assert.strictEqual(agentHostWebSocketUrl({ port: 7788 }), 'ws://localhost:7788/');
		assert.throws(() => agentHostWebSocketUrl({}), /neither a socket path nor a port/);
	});

	test('finds the bundle beside out/, and reports its absence rather than guessing', () => {
		assert.strictEqual(resolveServerWebBundleRoot(appRoot, new NullLogService()), bundleRoot);
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fumie-web-shell-empty-'));
		try {
			assert.strictEqual(resolveServerWebBundleRoot(empty, new NullLogService()), undefined);
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
	});

	test('serves the Fumie client page under the prefix, on the capability path only', async () => {
		const shell = await shellFor(() => Promise.reject(new Error('unused')));
		const { origin } = await startHostServer(store, shell);

		const page = await get(`${origin}${FUMIE_WEB_SHELL_PATH_PREFIX}/m/test-capability`);
		assert.strictEqual(page.status, 200);
		assert.ok(
			page.body.includes('/fumie/m/test-capability/bundle/vs/sessions/sessions.web.main.internal.js'),
			'the page must load the Fumie client, not the upstream workbench');
		assert.ok(String(page.headers['set-cookie']?.[0]).startsWith('fumie_mobile=test-capability'));

		assert.strictEqual((await get(`${origin}${FUMIE_WEB_SHELL_PATH_PREFIX}/m/not-the-capability`)).status, 404);
		assert.strictEqual((await get(`${origin}${FUMIE_WEB_SHELL_PATH_PREFIX}/`)).status, 404);
	});

	/**
	 * The workbench routes are the reason this seam is a prefix the shell owns
	 * outright: everything else must reach the host server untouched.
	 */
	test('leaves every path outside the prefix to the host server', async () => {
		const shell = await shellFor(() => Promise.reject(new Error('unused')));
		const { origin } = await startHostServer(store, shell);

		const workbench = await get(`${origin}/`);
		assert.strictEqual(workbench.status, 200);
		assert.strictEqual(workbench.body, 'the host server answered this');
		assert.strictEqual((await get(`${origin}/version`)).body, 'the host server answered this');
	});

	test('serves the bundle through the base path the host answers on', async () => {
		fs.mkdirSync(path.join(bundleRoot, 'vs', 'sessions'), { recursive: true });
		fs.writeFileSync(path.join(bundleRoot, 'vs', 'sessions', 'sessions.web.main.internal.js'), 'the client');

		const shell = await shellFor(() => Promise.reject(new Error('unused')));
		const { origin } = await startHostServer(store, shell, '/base');

		const page = await get(`${origin}/base${FUMIE_WEB_SHELL_PATH_PREFIX}/m/test-capability`);
		assert.strictEqual(page.status, 200);
		assert.ok(
			page.body.includes('/base/fumie/m/test-capability/bundle/vs/sessions/sessions.web.main.internal.js'),
			'asset urls must come back to the address the browser used');

		const cookie = String(page.headers['set-cookie']?.[0]).split(';')[0];
		const asset = await get(`${origin}/base${FUMIE_WEB_SHELL_PATH_PREFIX}/m/test-capability/bundle/vs/sessions/sessions.web.main.internal.js`, { cookie });
		assert.strictEqual(asset.status, 200);
		assert.strictEqual(asset.body, 'the client');

		// The capability cookie is the whole of the access control and is not
		// weakened by being mounted inside another server.
		assert.strictEqual((await get(`${origin}/base${FUMIE_WEB_SHELL_PATH_PREFIX}/m/test-capability/bundle/vs/sessions/sessions.web.main.internal.js`)).status, 403);
	});

	test('bridges a browser onto this server\'s own agent host', async () => {
		const agentHost = await startEchoAgentHost(store);
		const shell = await shellFor(async () => agentHost.url);
		const { origin } = await startHostServer(store, shell);

		const page = await get(`${origin}${FUMIE_WEB_SHELL_PATH_PREFIX}/m/test-capability`);
		const cookie = String(page.headers['set-cookie']?.[0]).split(';')[0];

		const client = new (await ws()).WebSocket(
			`${origin.replace('http:', 'ws:')}${FUMIE_WEB_SHELL_PATH_PREFIX}/m/test-capability${WS_PATH}`,
			{ headers: { cookie } });
		store.add({ dispose: () => client.close() });
		const echoed = await new Promise<string>((resolve, reject) => {
			client.once('error', reject);
			client.once('open', () => client.send('hello'));
			client.once('message', data => resolve(data.toString()));
		});

		assert.strictEqual(echoed, 'echo:hello');
		assert.deepStrictEqual(agentHost.seenUrls, ['/upstream']);
	});

	test('a bridge asked for without the session cookie is refused, not bridged', async () => {
		const agentHost = await startEchoAgentHost(store);
		const shell = await shellFor(async () => agentHost.url);
		const { origin } = await startHostServer(store, shell);

		const client = new (await ws()).WebSocket(
			`${origin.replace('http:', 'ws:')}${FUMIE_WEB_SHELL_PATH_PREFIX}/m/test-capability${WS_PATH}`);
		store.add({ dispose: () => client.close() });
		const error = await new Promise<Error>(resolve => client.once('error', resolve));

		assert.ok(/Unexpected server response: 403/.test(error.message), error.message);
		assert.deepStrictEqual(agentHost.seenUrls, []);
	});

	/**
	 * The shell answers the whole prefix, including the parts of it that are not
	 * its own address. Declining them would hand the request to the host server,
	 * which would answer a workbench page where the shell was asked for.
	 */
	test('an upgrade under the prefix but off the bridge is refused by the shell', async () => {
		const shell = await shellFor(() => Promise.reject(new Error('unused')));
		const { origin } = await startHostServer(store, shell);

		const client = new (await ws()).WebSocket(`${origin.replace('http:', 'ws:')}${FUMIE_WEB_SHELL_PATH_PREFIX}/m/wrong${WS_PATH}`);
		store.add({ dispose: () => client.close() });
		const error = await new Promise<Error>(resolve => client.once('error', resolve));

		assert.ok(/Unexpected server response: 404/.test(error.message), error.message);
	});

	test('reports the agent host it could not reach instead of serving a dead page silently', async () => {
		const shell = await shellFor(() => Promise.reject(new Error('the agent host is down')));
		const { origin } = await startHostServer(store, shell);

		const page = await get(`${origin}${FUMIE_WEB_SHELL_PATH_PREFIX}/m/test-capability`);
		const cookie = String(page.headers['set-cookie']?.[0]).split(';')[0];

		const client = new (await ws()).WebSocket(
			`${origin.replace('http:', 'ws:')}${FUMIE_WEB_SHELL_PATH_PREFIX}/m/test-capability${WS_PATH}`,
			{ headers: { cookie } });
		store.add({ dispose: () => client.close() });
		const error = await new Promise<Error>(resolve => client.once('error', resolve));

		assert.ok(/Unexpected server response: 503/.test(error.message), error.message);
	});

	/**
	 * A capability drawn afresh per process would mean the address copied out of
	 * the log stops working at the next restart, which for a headless server is
	 * the difference between a usable feature and one nobody can find twice.
	 */
	test('keeps the same address across restarts, and needs no bundle to start without one', async () => {
		const unusedAgentHost = () => Promise.reject(new Error('unused'));
		const first = store.add(await createServerFumieWebShell(environment(appRoot, userDataPath), new NullLogService(), unusedAgentHost));
		const second = store.add(await createServerFumieWebShell(environment(appRoot, userDataPath), new NullLogService(), unusedAgentHost));

		assert.strictEqual(first.urlPath, second.urlPath);
		assert.ok(first.urlPath?.startsWith(`${FUMIE_WEB_SHELL_PATH_PREFIX}/m/`), first.urlPath);

		const withoutBundle = await createServerFumieWebShell(environment(userDataPath, userDataPath), new NullLogService(), unusedAgentHost);
		assert.ok(withoutBundle instanceof UnavailableFumieWebShellServer);
		assert.strictEqual(withoutBundle.urlPath, undefined);
	});

	test('a build with no client bundle answers the prefix rather than falling through to the workbench', async () => {
		const shell = new UnavailableFumieWebShellServer();
		const { origin } = await startHostServer(store, shell);

		const page = await get(`${origin}${FUMIE_WEB_SHELL_PATH_PREFIX}/m/anything`);
		assert.strictEqual(page.status, 404);
		assert.ok(page.body.includes('not part of this build'));
		assert.strictEqual((await get(`${origin}/`)).body, 'the host server answered this');
	});
});
