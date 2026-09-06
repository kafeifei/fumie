/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */

import type { IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import type { TLSSocket } from 'tls';
import type { WebSocket as WebSocketType } from 'ws';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const { pathToFileURL } = require('url');

const APP_ROOT = path.join(__dirname, '..', '..');
const OUT_ROOT = path.join(APP_ROOT, 'out');
const NODE_MODULES_ROOT = path.join(APP_ROOT, 'node_modules');
const PREVIEW_COOKIE = 'fumie_mobile_preview';
const PREVIEW_PATH_PREFIX = '/preview/';
const AGENT_HOST_PATH = '/__mobile-agent-preview/agent-host';

interface AgentHostRelayConnection {
	send(message: string): Promise<void>;
	onMessage(listener: (message: string) => void): { dispose(): void };
	onClose(listener: () => void): { dispose(): void };
	close(): Promise<void>;
}

type AgentHostUpstream =
	| { readonly kind: 'websocket'; readonly url: string }
	| { readonly kind: 'microsoftTunnel'; connect(): Promise<AgentHostRelayConnection> };

interface PreviewServerOptions {
	capability: string;
	upstream: AgentHostUpstream;
	host?: string;
	port?: number;
}

interface PreviewServer {
	port: number;
	localUrl: string;
	setPublicHost(host: string): void;
	close(): Promise<void>;
}

async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
	const bundleRoot = await createPreviewBundle();
	const html = await createPreviewHtml(options.capability);
	let publicHost: string | undefined;
	const server = http.createServer((request, response) => {
		handleRequest(request, response, html, options.capability, publicHost, bundleRoot);
	});
	const webSocketServer = new WebSocketServer({ noServer: true });
	const openSockets = new Set<WebSocketType>();

	server.on('upgrade', (request, socket, head) => {
		const requestUrl = new URL(request.url ?? '/', 'http://localhost');
		const capabilityPath = `${PREVIEW_PATH_PREFIX}${encodeURIComponent(options.capability)}`;
		const scopedAgentHostPath = `${capabilityPath}${AGENT_HOST_PATH}`;
		if (
			(requestUrl.pathname !== scopedAgentHostPath && (requestUrl.pathname !== AGENT_HOST_PATH || !hasCapabilityCookie(request, options.capability)))
			|| !isAllowedPublicHost(request, publicHost)
			|| !hasAllowedOrigin(request)
		) {
			socket.destroy();
			return;
		}

		if (options.upstream.kind === 'websocket') {
			const upstream = new WebSocket(options.upstream.url);
			let opened = false;
			upstream.once('open', () => {
				opened = true;
				webSocketServer.handleUpgrade(request, socket, head, downstream => {
					openSockets.add(downstream);
					openSockets.add(upstream);
					bridgeSockets(downstream, upstream, openSockets);
				});
			});
			upstream.once('error', () => {
				if (!opened) {
					socket.destroy();
				}
			});
			return;
		}

		void options.upstream.connect().then(relay => {
			if (socket.destroyed) {
				void relay.close();
				return;
			}
			webSocketServer.handleUpgrade(request, socket, head, downstream => {
				openSockets.add(downstream);
				bridgeMicrosoftTunnel(downstream, relay, openSockets);
			});
		}, () => socket.destroy());
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
	});

	const address = server.address() as AddressInfo | null;
	if (!address || typeof address === 'string') {
		throw new Error('Mobile agent preview server did not bind to a TCP port');
	}

	return {
		port: address.port,
		localUrl: `http://127.0.0.1:${address.port}${PREVIEW_PATH_PREFIX}${encodeURIComponent(options.capability)}`,
		setPublicHost(host: string) {
			publicHost = host;
		},
		async close() {
			for (const socket of openSockets) {
				socket.close();
			}
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			webSocketServer.close();
			fs.rmSync(bundleRoot, { recursive: true, force: true });
		},
	};
}

function handleRequest(request: IncomingMessage, response: ServerResponse, html: string, capability: string, publicHost: string | undefined, bundleRoot: string): void {
	const requestUrl = new URL(request.url ?? '/', 'http://localhost');
	const capabilityPath = `${PREVIEW_PATH_PREFIX}${encodeURIComponent(capability)}`;
	const scopedOutPrefix = `${capabilityPath}/out/`;
	const scopedBundlePrefix = `${capabilityPath}/bundle/`;
	const scopedNodeModulesPrefix = `${capabilityPath}/node_modules/`;
	response.once('finish', () => {
		if (response.statusCode >= 400) {
			const redactedPath = requestUrl.pathname.startsWith(capabilityPath)
				? `/preview/<redacted>${requestUrl.pathname.slice(capabilityPath.length)}`
				: requestUrl.pathname;
			process.stderr.write(`[mobile-preview] ${response.statusCode} ${redactedPath}\n`);
		}
	});
	if (!isAllowedPublicHost(request, publicHost)) {
		respond(response, 421, 'Remote preview requests must arrive through Microsoft Dev Tunnels.');
		return;
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		respond(response, 405, 'Method not allowed');
		return;
	}

	if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html' || requestUrl.pathname === capabilityPath) {
		const hasCookie = hasCapabilityCookie(request, capability);
		const hasLinkCapability = requestUrl.pathname === capabilityPath || requestUrl.searchParams.get('preview') === capability;
		if (!hasCookie && !hasLinkCapability) {
			respondInvalidPreviewLink(response, request.method === 'HEAD');
			return;
		}

		const headers = securityHeaders('text/html; charset=utf-8');
		if (!hasCookie) {
			const secure = isSecureForwardedRequest(request) ? '; Secure' : '';
			headers['Set-Cookie'] = `${PREVIEW_COOKIE}=${capability}; HttpOnly; SameSite=Strict; Path=/${secure}`;
		}
		response.writeHead(200, headers);
		if (request.method === 'HEAD') {
			response.end();
		} else {
			response.end(html);
		}
		return;
	}

	const isScopedOutResource = requestUrl.pathname.startsWith(scopedOutPrefix);
	const isScopedBundleResource = requestUrl.pathname.startsWith(scopedBundlePrefix);
	// The workbench pulls a few libraries (xterm, katex) straight out of
	// node_modules, resolved as siblings of the file root rather than through
	// the bundle. Serving them keeps the terminal and math rendering alive.
	const isScopedNodeModulesResource = requestUrl.pathname.startsWith(scopedNodeModulesPrefix);
	if (!isScopedOutResource && !isScopedBundleResource && !isScopedNodeModulesResource && (!hasCapabilityCookie(request, capability) || !requestUrl.pathname.startsWith('/out/'))) {
		respond(response, 404, 'Not found');
		return;
	}

	const resourceRoot = isScopedBundleResource
		? bundleRoot
		: isScopedNodeModulesResource ? NODE_MODULES_ROOT : OUT_ROOT;
	const resourcePrefix = isScopedBundleResource
		? scopedBundlePrefix
		: isScopedNodeModulesResource ? scopedNodeModulesPrefix : isScopedOutResource ? scopedOutPrefix : '/out/';
	let relativePath: string;
	try {
		relativePath = decodeURIComponent(requestUrl.pathname.slice(resourcePrefix.length));
	} catch {
		respond(response, 404, 'Not found');
		return;
	}
	if (!relativePath || relativePath.endsWith('.map') || relativePath.split('/').includes('..')) {
		respond(response, 404, 'Not found');
		return;
	}

	const filePath = path.resolve(resourceRoot, relativePath);
	if (!filePath.startsWith(`${resourceRoot}${path.sep}`)) {
		respond(response, 404, 'Not found');
		return;
	}

	fs.stat(filePath, (error, stat) => {
		if (error || !stat.isFile()) {
			respond(response, 404, 'Not found');
			return;
		}

		response.writeHead(200, securityHeaders(contentType(filePath)));
		if (request.method === 'HEAD') {
			response.end();
		} else {
			fs.createReadStream(filePath).pipe(response);
		}
	});
}

function isAllowedPublicHost(request: IncomingMessage, publicHost: string | undefined): boolean {
	if (publicHost === undefined) {
		return true;
	}
	return request.headers['x-forwarded-host'] === publicHost;
}

function respond(response: ServerResponse, statusCode: number, message: string): void {
	response.writeHead(statusCode, securityHeaders('text/plain; charset=utf-8'));
	response.end(message);
}

function respondInvalidPreviewLink(response: ServerResponse, isHeadRequest: boolean): void {
	response.writeHead(403, securityHeaders('text/html; charset=utf-8'));
	if (isHeadRequest) {
		response.end();
		return;
	}

	response.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
	<title>Fumie Mobile Preview</title>
	<style>
		:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
		body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f7f7f8; color: #1f2328; }
		main { box-sizing: border-box; width: min(100% - 40px, 420px); padding: 28px 24px; border: 1px solid #d8dee4; border-radius: 18px; background: #fff; box-shadow: 0 10px 30px rgba(0, 0, 0, .08); }
		h1 { margin: 0 0 12px; font-size: 22px; }
		p { margin: 0; color: #59636e; font-size: 16px; line-height: 1.5; }
		@media (prefers-color-scheme: dark) {
			body { background: #111318; color: #f0f3f6; }
			main { border-color: #343a46; background: #1b1f27; }
			p { color: #aeb7c2; }
		}
	</style>
</head>
<body>
	<main>
		<!-- allow-any-unicode-next-line -->
		<h1>这个测试链接不完整</h1>
		<!-- allow-any-unicode-next-line -->
		<p>请打开包含完整测试凭证的新链接。临时预览停止或重新启动后，旧链接也会失效。</p>
	</main>
</body>
</html>`);
}

function securityHeaders(contentTypeValue: string): Record<string, string> {
	return {
		'Cache-Control': 'no-store',
		'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline' data:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src 'self';",
		'Content-Type': contentTypeValue,
		'Cross-Origin-Resource-Policy': 'same-origin',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
	};
}

function hasCapabilityCookie(request: IncomingMessage, capability: string): boolean {
	const cookies = request.headers.cookie?.split(';') ?? [];
	return cookies.some(cookie => cookie.trim() === `${PREVIEW_COOKIE}=${capability}`);
}

function isSecureForwardedRequest(request: IncomingMessage): boolean {
	return request.headers['x-forwarded-proto'] === 'https' || !!(request.socket as TLSSocket).encrypted;
}

function hasAllowedOrigin(request: IncomingMessage): boolean {
	const origin = request.headers.origin;
	if (!origin) {
		return false;
	}

	try {
		const originHost = new URL(origin).host;
		const forwardedHost = request.headers['x-forwarded-host'];
		const allowedHosts: (string | undefined)[] = [
			request.headers.host,
			typeof forwardedHost === 'string' ? forwardedHost : undefined,
		].filter(Boolean);
		return allowedHosts.includes(originHost);
	} catch {
		return false;
	}
}

function bridgeSockets(downstream: WebSocketType, upstream: WebSocketType, openSockets: Set<WebSocketType>): void {
	downstream.on('message', (data, isBinary) => {
		if (upstream.readyState === WebSocket.OPEN) {
			upstream.send(data, { binary: isBinary });
		}
	});
	upstream.on('message', (data, isBinary) => {
		if (downstream.readyState === WebSocket.OPEN) {
			downstream.send(data, { binary: isBinary });
		}
	});

	const close = () => {
		openSockets.delete(downstream);
		openSockets.delete(upstream);
		if (downstream.readyState === WebSocket.OPEN) {
			downstream.close();
		}
		if (upstream.readyState === WebSocket.OPEN) {
			upstream.close();
		}
	};
	downstream.once('close', close);
	upstream.once('close', close);
	downstream.once('error', close);
	upstream.once('error', close);
}

function bridgeMicrosoftTunnel(downstream: WebSocketType, relay: AgentHostRelayConnection, openSockets: Set<WebSocketType>): void {
	const messageDisposable = relay.onMessage(message => {
		if (downstream.readyState === WebSocket.OPEN) {
			downstream.send(message);
		}
	});
	const relayCloseDisposable = relay.onClose(() => {
		if (downstream.readyState === WebSocket.OPEN) {
			downstream.close();
		}
	});

	downstream.on('message', data => {
		void relay.send(data.toString()).catch(() => downstream.close());
	});

	const close = () => {
		openSockets.delete(downstream);
		messageDisposable.dispose();
		relayCloseDisposable.dispose();
		void relay.close();
		if (downstream.readyState === WebSocket.OPEN) {
			downstream.close();
		}
	};
	downstream.once('close', close);
	downstream.once('error', close);
}

async function createPreviewBundle(): Promise<string> {
	const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fumie-mobile-preview-bundle-'));
	const esbuild = require(path.join(APP_ROOT, 'build', 'node_modules', 'esbuild'));
	try {
		await esbuild.build({
			entryPoints: [path.join(OUT_ROOT, 'vs', 'sessions', 'sessions.web.main.internal.js')],
			outdir: bundleRoot,
			bundle: true,
			minify: true,
			splitting: true,
			format: 'esm',
			platform: 'browser',
			target: ['safari17'],
			entryNames: 'workbench',
			chunkNames: 'chunks/[name]-[hash]',
			loader: {
				'.png': 'dataurl',
				'.svg': 'dataurl',
				'.ttf': 'dataurl',
				'.woff': 'dataurl',
				'.woff2': 'dataurl',
			},
			logLevel: 'warning',
		});
		return bundleRoot;
	} catch (error) {
		fs.rmSync(bundleRoot, { recursive: true, force: true });
		throw error;
	}
}

/**
 * The preview serves the same client the shipped app does, rendered by the same
 * module: `src/vs/platform/agentHost/common/fumie/mobileWebClientPage.ts`. Only
 * the asset layout differs — the preview points the workbench at the raw `out/`
 * tree with a throwaway esbuild bundle over it, where the app points it at the
 * prebuilt `web-bundle` — so only that is passed in.
 *
 * The compiled copy is loaded by URL rather than imported. Everything under
 * `scripts/` is CommonJS (`scripts/package.json` is `{"type":"commonjs"}`) while
 * `src/vs` is ESM whose `.js` specifiers only resolve against `out/`, so the
 * TypeScript source cannot be imported from here. `out/` is already a hard
 * dependency of this harness — `assertCompiledOutput` in `run.ts` refuses to
 * start without it — so nothing new is required to make this work.
 */
async function createPreviewHtml(capability: string): Promise<string> {
	const capabilityPath = `${PREVIEW_PATH_PREFIX}${encodeURIComponent(capability)}`;
	const bundlePath = `${capabilityPath}/bundle`;
	const { renderMobileWebClientPage } = await import(
		pathToFileURL(path.join(OUT_ROOT, 'vs', 'platform', 'agentHost', 'common', 'fumie', 'mobileWebClientPage.js')).href
	);

	return renderMobileWebClientPage({
		fileRootPath: `${capabilityPath}/out`,
		stylesheetPath: `${bundlePath}/workbench.css`,
		modulePath: `${bundlePath}/workbench.js`,
		agentHostPath: `${capabilityPath}${AGENT_HOST_PATH}`,
		nameShort: 'Fumie Mobile Preview',
		nameLong: 'Fumie Mobile Preview',
		configurationDefaults: {
			// The browser profile starts empty, so this setting reads false
			// and the renderer forwards 'codexAgentEnabled: false' into the
			// Agent Host's root config — disagreeing with the env var the
			// harness starts the host with. Mirrors the desktop profile.
			'chat.agentHost.codexAgent.enabled': true,
		},
	});
}

function contentType(filePath: string): string {
	const contentTypes: Record<string, string> = {
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
	return contentTypes[path.extname(filePath)] ?? 'application/octet-stream';
}

module.exports = { AGENT_HOST_PATH, startPreviewServer };
