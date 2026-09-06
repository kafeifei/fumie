/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { Tunnel } from '@microsoft/dev-tunnels-contracts';
import type { TunnelRelayTunnelHost as TunnelRelayTunnelHostType } from '@microsoft/dev-tunnels-connections';
import type { TunnelManagementHttpClient as TunnelManagementHttpClientType } from '@microsoft/dev-tunnels-management';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const minimist = require('minimist');
const {
	TunnelAccessControlEntryType,
	TunnelAccessScopes,
	TunnelProtocol,
} = require('@microsoft/dev-tunnels-contracts');
const { TunnelRelayTunnelHost } = require('@microsoft/dev-tunnels-connections');
const {
	ManagementApiVersions,
	TunnelManagementHttpClient,
} = require('@microsoft/dev-tunnels-management');
interface PreviewServer {
	port: number;
	localUrl: string;
	setPublicHost(host: string): void;
	close(): Promise<void>;
}

interface RelayConnection {
	send(message: string): Promise<void>;
	onMessage(listener: (message: string) => void): { dispose(): void };
	onClose(listener: () => void): { dispose(): void };
	close(): Promise<void>;
}

interface TunnelRelayService {
	onDidRelayMessage(listener: (event: { connectionId: string; data: string }) => void): { dispose(): void };
	onDidRelayClose(listener: (connectionId: string) => void): { dispose(): void };
	listTunnels(token: string, authProvider: 'github', additionalTunnelNames?: string[]): Promise<Array<{
		tunnelId: string;
		clusterId: string;
		name: string;
		hostConnectionCount: number;
	}>>;
	connect(token: string, authProvider: 'github', tunnelId: string, clusterId: string): Promise<{ connectionId: string }>;
	prepareSelection(token: string, authProvider: 'github', tunnelId: string, clusterId: string): Promise<{
		selectionId: string;
		inventory: { endpoints: readonly { type: 'editor' | 'standalone'; instanceId: string }[] };
	} | undefined>;
	completeSelection(selectionId: string, selection: { instanceId: string }): Promise<{ connectionId: string }>;
	cancelSelection(selectionId: string): Promise<void>;
	relaySend(connectionId: string, message: string): Promise<void>;
	disconnect(connectionId: string): Promise<void>;
	dispose(): void;
}

const { startPreviewServer } = require('./server.ts') as {
	startPreviewServer(options: {
		capability: string;
		upstream:
			| { kind: 'websocket'; url: string }
			| { kind: 'microsoftTunnel'; connect(): Promise<RelayConnection> };
		port?: number;
	}): Promise<PreviewServer>;
};

const APP_ROOT = path.join(__dirname, '..', '..');
const AGENT_HOST_ENTRY = path.join(APP_ROOT, 'out', 'vs', 'platform', 'agentHost', 'node', 'agentHostServerMain.js');
const SESSIONS_WEB_ENTRY = path.join(APP_ROOT, 'out', 'vs', 'sessions', 'sessions.web.main.internal.js');
const TUNNEL_AGENT_HOST_SERVICE_ENTRY = path.join(APP_ROOT, 'out', 'vs', 'platform', 'agentHost', 'node', 'tunnelAgentHostService.js');
const LOG_SERVICE_ENTRY = path.join(APP_ROOT, 'out', 'vs', 'platform', 'log', 'common', 'log.js');
const LOCAL_AGENT_HOST_METADATA_ENTRY = path.join(APP_ROOT, 'out', 'vs', 'platform', 'agentHost', 'node', 'localAgentHostMetadata.js');
// The client page the preview and the shipped app share. server.ts loads the
// compiled copy by URL, so a stale `out/` shows up here rather than as a blank
// page with a module-resolution error in the browser console.
const MOBILE_WEB_CLIENT_PAGE_ENTRY = path.join(APP_ROOT, 'out', 'vs', 'platform', 'agentHost', 'common', 'fumie', 'mobileWebClientPage.js');

interface DesktopAgentHostEndpoint {
	readonly type: 'editor' | 'standalone';
	readonly pid: number;
	readonly instanceId: string;
	readonly endpoint: { readonly type: string; readonly path?: string };
	readonly connectionToken: string;
	readonly protocolVersion: string;
}

interface RuntimeState {
	agentHost?: ChildProcessWithoutNullStreams;
	previewServer?: PreviewServer;
	tunnel?: Tunnel;
	tunnelClient?: TunnelManagementHttpClientType;
	tunnelHost?: TunnelRelayTunnelHostType;
	relayService?: TunnelRelayService;
}

async function main(): Promise<void> {
	const args = minimist(process.argv.slice(2), {
		boolean: ['cleanup', 'help', 'local-only', 'local-agent-host', 'mock-agent', 'desktop-agent-host', 'list-desktop-agent-hosts'],
		string: ['agent-host-tunnel', 'capability', 'desktop-instance', 'fumie-home'],
	});
	if (args.help) {
		process.stdout.write(
			'Usage: node --experimental-strip-types scripts/mobile-agent-preview/run.ts <mode> [options]\n\n' +
			'Modes — pick exactly one. They differ in what the browser gets to touch:\n\n' +
			'  --mock-agent\n' +
			'      Isolated deterministic Agent Host in a temp directory. Fake agents, fake\n' +
			'      models, no filesystem or terminal access to anything you care about.\n' +
			'      Touches your real machine: no. Use it for UI smoke tests.\n\n' +
			'  --local-agent-host\n' +
			'      Spawns a standalone Agent Host on 127.0.0.1 with its own store in\n' +
			'      ~/.fumie/mobile-preview. Real Claude/Codex harnesses and real workspace\n' +
			'      file/terminal access, but a session catalog that is nobody else\'s, and no\n' +
			'      renderer BYOK bridge — so provider (Custom Endpoint) models are absent and\n' +
			'      Claude publishes nothing here. Use it to test the standalone server itself.\n\n' +
			'  --desktop-agent-host\n' +
			'      Connects to the Agent Host inside a Fumie desktop window that is already\n' +
			'      running on this machine, over its unix-socket endpoint. You get that\n' +
			'      window\'s real session catalog and its real BYOK model list (your own\n' +
			'      Claude models). It is a full AHP session against your real workspace:\n' +
			'      file read/write, terminals, agent runs. Loopback only — this mode refuses\n' +
			'      to open a public Dev Tunnel. Requires the desktop to stay open.\n\n' +
			'  --agent-host-tunnel <name-or-id>\n' +
			'      Connects to a Fumie desktop through Microsoft Dev Tunnels (its Remote\n' +
			'      Control tunnel). Same real-workspace power as --desktop-agent-host, over\n' +
			'      the authenticated production relay rather than a loopback socket.\n\n' +
			'Options:\n' +
			'  --local-only  Skip Microsoft Dev Tunnels and print a localhost URL\n' +
			'  --port <number>  Listen on a fixed port instead of an ephemeral one\n' +
			'  --capability <token>  Use a fixed URL token so the link survives a restart (--local-only only)\n' +
			'  --desktop-instance <id>  Pick one desktop Agent Host when several are running\n' +
			'  --fumie-home <path>  Where to read the desktop endpoint registry (default: $FUMIE_HOME or ~/.fumie)\n' +
			'  --list-desktop-agent-hosts  Print the live desktop Agent Host endpoints and exit\n' +
			'  --cleanup     Delete offline preview tunnels left by an interrupted run\n' +
			'  --help        Show this help\n'
		);
		return;
	}
	if (args.cleanup) {
		const deletedCount = await cleanupStaleTunnels();
		process.stdout.write(`Deleted ${deletedCount} offline Fumie mobile preview tunnel(s).\n`);
		return;
	}
	if (args['list-desktop-agent-hosts']) {
		assertCompiledOutput('desktop');
		const endpoints = await readDesktopAgentHostEndpoints(args['fumie-home']);
		process.stdout.write(endpoints.length
			? `${describeDesktopEndpoints(endpoints)}\n`
			: `No running Fumie desktop Agent Host found under ${resolveFumieHome(args['fumie-home'])}.\n`);
		return;
	}

	const selectedModes = [
		args['mock-agent'] ? '--mock-agent' : undefined,
		args['local-agent-host'] ? '--local-agent-host' : undefined,
		args['desktop-agent-host'] ? '--desktop-agent-host' : undefined,
		args['agent-host-tunnel'] ? '--agent-host-tunnel' : undefined,
	].filter((mode): mode is string => mode !== undefined);
	if (selectedModes.length === 0) {
		throw new Error('Pass --desktop-agent-host to use the agents and models of a running Fumie desktop, --local-agent-host for a standalone Agent Host on this machine, --agent-host-tunnel for a Microsoft Dev Tunnels connection to a Fumie desktop, or --mock-agent for an isolated UI smoke test. Run with --help for what each one exposes.');
	}
	if (selectedModes.length > 1) {
		throw new Error(`${selectedModes.join(', ')} are mutually exclusive; pass exactly one.`);
	}

	// Both locally spawned modes run `agentHostServerMain.js` out of `out/`;
	// the other two talk to a host somebody else already started.
	const spawnsAgentHost: boolean = args['mock-agent'] || args['local-agent-host'];
	const usesDesktopEndpoint: boolean = args['desktop-agent-host'];
	assertCompiledOutput(spawnsAgentHost ? 'standalone' : usesDesktopEndpoint ? 'desktop' : 'tunnel');

	// --desktop-agent-host hands the browser a full AHP session against the real
	// workspace agent host of a live desktop window: file read/write, terminals,
	// agent runs. In front of that sits nothing but the capability token in the
	// URL — a non-expiring bearer with no revocation that lands in browser
	// history and in any chat it is pasted into. That is an acceptable trade on
	// loopback and not on a public relay, so the mode is loopback-only and says
	// so rather than quietly downgrading a tunnel request.
	if (usesDesktopEndpoint && process.argv.includes('--no-local-only')) {
		throw new Error('--desktop-agent-host cannot open a public Dev Tunnel. It exposes your real workspace agent host — files, terminals and agent runs — behind nothing but the capability token in the URL, which never expires and cannot be revoked. Use --agent-host-tunnel, whose relay is authenticated, if you need to reach this machine from off it.');
	}
	const localOnly: boolean = args['local-only'] || usesDesktopEndpoint;

	// A fixed token keeps one link working across restarts, which is what makes
	// the preview shareable with someone testing alongside you. It is only a
	// secret worth having on a public tunnel, so that is where it stays random.
	if (args.capability && !localOnly) {
		throw new Error('--capability is only allowed with --local-only; a public preview needs an unguessable link.');
	}
	const port = args.port === undefined ? undefined : Number(args.port);
	if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
		throw new Error(`--port must be a TCP port number, got '${args.port}'.`);
	}
	const capability = args.capability || crypto.randomBytes(16).toString('base64url');
	// The mock host is throwaway state, so it gets a temp dir that cleanup
	// deletes. The real host keeps a dedicated directory that survives
	// restarts — it must never be the live desktop profile, whose SQLite state
	// a second process would fight over.
	const tempDirectory = args['mock-agent'] ? fs.mkdtempSync(path.join(os.tmpdir(), 'fumie-mobile-preview-')) : undefined;
	const agentHostUserDataDirectory = args['mock-agent']
		? path.join(tempDirectory!, 'agent-host-data')
		: path.join(os.homedir(), '.fumie', 'mobile-preview', 'agent-host-data');
	const state: RuntimeState = {
		agentHost: undefined,
		previewServer: undefined,
		tunnel: undefined,
		tunnelClient: undefined,
		tunnelHost: undefined,
	};
	let cleaningUp = false;

	const cleanup = async (): Promise<void> => {
		if (cleaningUp) {
			return;
		}
		cleaningUp = true;

		await state.previewServer?.close().catch(() => undefined);
		state.relayService?.dispose();
		await stopAgentHost(state.agentHost);
		await state.tunnelHost?.dispose().catch(() => undefined);
		if (state.tunnel && state.tunnelClient) {
			await state.tunnelClient.deleteTunnel(state.tunnel).catch(error => {
				process.stderr.write(`Warning: failed to delete the preview tunnel: ${error}\n`);
			});
		}
		await state.tunnelClient?.dispose().catch(() => undefined);
		if (tempDirectory) {
			fs.rmSync(tempDirectory, { recursive: true, force: true });
		}
	};

	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
		process.once(signal, () => {
			cleanup().finally(() => process.exit(0));
		});
	}

	try {
		let upstream:
			| { kind: 'websocket'; url: string }
			| { kind: 'microsoftTunnel'; connect(): Promise<RelayConnection> };
		let agentHostTunnelName: string | undefined;
		let desktopEndpoint: DesktopAgentHostEndpoint | undefined;
		if (spawnsAgentHost) {
			const agentHostToken = crypto.randomBytes(32).toString('base64url');
			const agentHost = await startAgentHost(agentHostUserDataDirectory, agentHostToken, args['mock-agent'] ? 'mock' : 'real');
			state.agentHost = agentHost.process;
			upstream = { kind: 'websocket', url: `ws://127.0.0.1:${agentHost.port}?tkn=${encodeURIComponent(agentHostToken)}` };
		} else if (usesDesktopEndpoint) {
			desktopEndpoint = await selectDesktopAgentHostEndpoint(args['fumie-home'], args['desktop-instance']);
			// The endpoint's connection token stays inside this process: the
			// browser talks to the preview server, and the preview server is what
			// dials the socket with `?tkn=`.
			upstream = { kind: 'websocket', url: desktopAgentHostUrl(desktopEndpoint) };
		} else {
			const relay = await createMicrosoftTunnelUpstream(args['agent-host-tunnel']);
			state.relayService = relay.service;
			agentHostTunnelName = relay.name;
			upstream = relay.upstream;
		}
		state.previewServer = await startPreviewServer({
			capability,
			upstream,
			port,
		});

		let previewUrl = state.previewServer.localUrl;
		if (!localOnly) {
			const tunnel = await startWebTunnel(state.previewServer.port, capability, resources => {
				state.tunnel = resources.tunnel;
				state.tunnelClient = resources.client;
				state.tunnelHost = resources.host;
			});
			state.previewServer.setPublicHost(new URL(tunnel.url).host);
			previewUrl = tunnel.url;
		}

		process.stdout.write('\nFumie mobile preview is ready.\n\n');
		if (args['mock-agent']) {
			process.stdout.write('Mode: isolated mock Agent Host (not a desktop session)\n');
		} else if (args['local-agent-host']) {
			process.stdout.write('Mode: standalone Agent Host on 127.0.0.1 (real harnesses, isolated store, no BYOK models)\n');
			process.stdout.write(`Agent Host user data: ${agentHostUserDataDirectory}\n`);
		} else if (desktopEndpoint) {
			process.stdout.write('Mode: running Fumie desktop Agent Host (your real workspace, sessions and BYOK models)\n');
			process.stdout.write(`Desktop endpoint: instance ${desktopEndpoint.instanceId} (PID ${desktopEndpoint.pid}), protocol ${desktopEndpoint.protocolVersion}\n`);
			process.stdout.write(`Socket: ${desktopEndpoint.endpoint.path}\n`);
			process.stdout.write('This link drives the real agent host: files, terminals and agent runs. Loopback only.\n');
		} else {
			process.stdout.write(`Mode: Microsoft Dev Tunnels relay -> ${agentHostTunnelName}\n`);
		}
		process.stdout.write(`Open on your phone:\n${previewUrl}\n\n`);
		process.stdout.write('Keep this process running. Press Ctrl+C to close and delete the preview tunnel.\n');

		if (state.agentHost) {
			await new Promise<void>((resolve, reject) => {
				state.agentHost!.once('exit', code => {
					if (!cleaningUp) {
						reject(new Error(`Agent Host exited unexpectedly with code ${code}`));
					} else {
						resolve();
					}
				});
			});
		} else {
			await new Promise<void>(() => { /* keep the preview alive until a signal arrives */ });
		}
	} finally {
		await cleanup();
	}
}

function assertCompiledOutput(mode: 'standalone' | 'desktop' | 'tunnel'): void {
	const requiredFiles = mode === 'standalone'
		? [AGENT_HOST_ENTRY, SESSIONS_WEB_ENTRY, MOBILE_WEB_CLIENT_PAGE_ENTRY]
		: mode === 'desktop'
			? [SESSIONS_WEB_ENTRY, LOCAL_AGENT_HOST_METADATA_ENTRY, LOG_SERVICE_ENTRY, MOBILE_WEB_CLIENT_PAGE_ENTRY]
			: [SESSIONS_WEB_ENTRY, TUNNEL_AGENT_HOST_SERVICE_ENTRY, LOG_SERVICE_ENTRY, MOBILE_WEB_CLIENT_PAGE_ENTRY];
	for (const requiredFile of requiredFiles) {
		if (!fs.existsSync(requiredFile)) {
			throw new Error(`Missing compiled output: ${requiredFile}\nRun npm run transpile-client before starting the preview.`);
		}
	}
}

/**
 * Where a desktop Fumie publishes its Agent Host endpoint registry.
 *
 * `agentHostMain` writes it under `FUMIE_HOME` and only falls back to the editor
 * profile when that variable is unset — and the desktop starters always set it,
 * from `product.json`'s `agentHostDefaultFumieHome`. So read the same two places
 * in the same order rather than guessing at a profile directory.
 */
function resolveFumieHome(override: string | undefined): string {
	if (override) {
		return path.resolve(expandHomePath(override));
	}
	if (process.env.FUMIE_HOME) {
		return path.resolve(expandHomePath(process.env.FUMIE_HOME));
	}
	let productDefault: string | undefined;
	try {
		productDefault = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'product.json'), 'utf8')).agentHostDefaultFumieHome;
	} catch {
		// A source tree without a readable product.json still has a sane default.
	}
	return path.resolve(expandHomePath(productDefault || path.join('~', '.fumie')));
}

function expandHomePath(value: string): string {
	return value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;
}

/**
 * Live editor endpoints from the shared registry, newest-usable first.
 *
 * `readLocalAgentHostEndpointRegistry` already drops entries whose PID is gone;
 * we additionally drop any whose socket file has vanished, which happens when a
 * host was killed hard enough to skip its cleanup and the PID got reused.
 */
async function readDesktopAgentHostEndpoints(fumieHomeOverride: string | undefined): Promise<DesktopAgentHostEndpoint[]> {
	const fumieHome = resolveFumieHome(fumieHomeOverride);
	const { readLocalAgentHostEndpointRegistry } = await import(pathToFileURL(LOCAL_AGENT_HOST_METADATA_ENTRY).href);
	const entries: DesktopAgentHostEndpoint[] = await readLocalAgentHostEndpointRegistry(fumieHome);
	return entries.filter(entry =>
		entry.type === 'editor'
		&& entry.endpoint?.type === 'socket'
		&& typeof entry.endpoint.path === 'string'
		&& (process.platform === 'win32' || fs.existsSync(entry.endpoint.path))
	);
}

function describeDesktopEndpoints(endpoints: readonly DesktopAgentHostEndpoint[]): string {
	return endpoints
		.map(endpoint => `  ${endpoint.instanceId}  PID ${endpoint.pid}  protocol ${endpoint.protocolVersion}`)
		.join('\n');
}

async function selectDesktopAgentHostEndpoint(fumieHomeOverride: string | undefined, instanceId: string | undefined): Promise<DesktopAgentHostEndpoint> {
	const endpoints = await readDesktopAgentHostEndpoints(fumieHomeOverride);
	if (endpoints.length === 0) {
		throw new Error(`No running Fumie desktop Agent Host is published under ${resolveFumieHome(fumieHomeOverride)}. Open Fumie on this machine and retry, or pass --fumie-home if that desktop uses a different FUMIE_HOME.`);
	}
	if (instanceId) {
		const match = endpoints.find(endpoint => endpoint.instanceId === instanceId);
		if (!match) {
			throw new Error(`No live desktop Agent Host has instance id '${instanceId}'. Live endpoints:\n${describeDesktopEndpoints(endpoints)}`);
		}
		return match;
	}
	if (endpoints.length > 1) {
		// Two desktops means two profiles; picking for the user would silently
		// attach the phone to the wrong workspace and session catalog.
		throw new Error(`More than one Fumie desktop Agent Host is running. Pass --desktop-instance <id> to choose:\n${describeDesktopEndpoints(endpoints)}`);
	}
	return endpoints[0];
}

/**
 * `ws+unix://<socket path>:/<request path>` is how `ws` addresses a unix socket:
 * everything before the `:` is the socket, everything after is the HTTP request
 * line the Agent Host's `verifyClient` reads the `tkn` query from.
 */
function desktopAgentHostUrl(endpoint: DesktopAgentHostEndpoint): string {
	return `ws+unix://${endpoint.endpoint.path}:/?tkn=${encodeURIComponent(endpoint.connectionToken)}`;
}

/**
 * Opt the Agent Host into serving a GitHub-signed-out client.
 *
 * The browser never signs in to GitHub, so every provider that gates its model
 * catalog on a GitHub token publishes nothing — Codex included, even though it
 * has its own ChatGPT credential and needs no token. The switch that lifts that
 * is `allowSignedOutWhenUsable`, and on the desktop the renderer forwards it
 * from `chat.agentHost.allowSignedOutWhenUsable`. That forwarder is deliberately
 * local-host-only (`agentHostRootConfigForwarder.ts`: "Remote agent hosts ... are
 * intentionally not fanned out to ... Remote operators should configure such
 * values server-side via the remote's agent-host-config.json") — and this preview
 * connects as a remote. So the harness, as the operator of this host, writes it
 * where the docs say to. Merged, never clobbered: the host owns every other key.
 */
function enableSignedOutModelCatalogs(userDataDirectory: string): void {
	const configFile = path.join(userDataDirectory, 'User', 'globalStorage', 'agent-host-config.json');
	let config: Record<string, unknown> = {};
	try {
		config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
	} catch {
		// No config yet (first run), or one we cannot parse — start from empty
		// rather than refusing to launch over it.
	}
	if (config['allowSignedOutWhenUsable'] === true) {
		return;
	}
	config['allowSignedOutWhenUsable'] = true;
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, `${JSON.stringify(config, null, '\t')}\n`);
}

function startAgentHost(userDataDirectory: string, connectionToken: string, mode: 'mock' | 'real'): Promise<{ process: ChildProcessWithoutNullStreams; port: number }> {
	return new Promise((resolve, reject) => {
		fs.mkdirSync(userDataDirectory, { recursive: true });
		if (mode === 'real') {
			enableSignedOutModelCatalogs(userDataDirectory);
		}
		// Bound to the loopback interface in both modes: the preview server is
		// the only thing that ever talks to this host, and it does so from this
		// machine. The connection token guards it even there.
		const serverArgs = [
			AGENT_HOST_ENTRY,
			'--host', '127.0.0.1',
			'--port', '0',
			'--connection-token', connectionToken,
			'--user-data-dir', userDataDirectory,
			'--disable-telemetry',
		];
		if (mode === 'mock') {
			serverArgs.push('--enable-mock-agent', '--quiet');
		}

		const environment: NodeJS.ProcessEnv = {
			...process.env,
			VSCODE_DEV: '1',
		};
		if (mode === 'mock') {
			environment.VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED = 'false';
			environment.VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED = 'false';
		} else {
			// `agentHostServerMain` registers Claude and Codex only outside
			// `--quiet`, which is why the real mode drops that flag. Claude is
			// on by default there, Codex is off, so opt Codex in — but let an
			// inherited value win, the way the desktop starters do.
			environment.VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED ??= 'true';
			environment.VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED ??= 'true';
		}
		const processHandle = childProcess.spawn(process.execPath, serverArgs, {
			cwd: APP_ROOT,
			env: environment,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let settled = false;
		let stdout = '';
		const timeout = setTimeout(() => {
			processHandle.kill('SIGTERM');
			reject(new Error('Timed out waiting for the Agent Host to start'));
		}, 30_000);

		processHandle.stdout.on('data', data => {
			stdout += data.toString();
			const match = stdout.match(/READY:(\d+)/);
			if (match && !settled) {
				settled = true;
				clearTimeout(timeout);
				resolve({ process: processHandle, port: Number(match[1]) });
			}
		});
		processHandle.stderr.on('data', data => process.stderr.write(data));
		processHandle.once('error', error => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				reject(error);
			}
		});
		processHandle.once('exit', code => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				reject(new Error(`Agent Host exited before startup with code ${code}`));
			}
		});
	});
}

async function createMicrosoftTunnelUpstream(selector: string): Promise<{
	service: TunnelRelayService;
	name: string;
	upstream: { kind: 'microsoftTunnel'; connect(): Promise<RelayConnection> };
}> {
	const [{ TunnelAgentHostMainService }, { NullLogService }] = await Promise.all([
		import(pathToFileURL(TUNNEL_AGENT_HOST_SERVICE_ENTRY).href),
		import(pathToFileURL(LOG_SERVICE_ENTRY).href),
	]);
	const service = new TunnelAgentHostMainService(new NullLogService()) as TunnelRelayService;
	const token = await readGitHubToken();
	const tunnels = await service.listTunnels(token, 'github', [selector]);
	const matches = tunnels.filter(tunnel =>
		tunnel.hostConnectionCount > 0
		&& (tunnel.tunnelId === selector || tunnel.name === selector)
	);
	if (matches.length !== 1) {
		service.dispose();
		const online = tunnels.filter(tunnel => tunnel.hostConnectionCount > 0).map(tunnel => `${tunnel.name} (${tunnel.tunnelId})`);
		throw new Error(matches.length > 1
			? `More than one online Agent Host tunnel matched '${selector}'. Pass its tunnel ID instead.`
			: `No online Agent Host tunnel matched '${selector}'. Online tunnels: ${online.join(', ') || '(none)'}`);
	}

	const tunnel = matches[0];
	return {
		service,
		name: `${tunnel.name} (${tunnel.tunnelId})`,
		upstream: {
			kind: 'microsoftTunnel',
			async connect(): Promise<RelayConnection> {
				// Protocol-v6 tunnels (including every `--delegate-to-editor`
				// host) only accept the gateway-selection handshake; a legacy
				// direct connect is answered with 503. Fall back to the direct
				// path only when the tunnel predates the gateway.
				let result: { connectionId: string };
				const selection = await service.prepareSelection(token, 'github', tunnel.tunnelId, tunnel.clusterId);
				if (selection) {
					const editor = selection.inventory.endpoints.find(endpoint => endpoint.type === 'editor');
					if (!editor) {
						await service.cancelSelection(selection.selectionId).catch(() => undefined);
						throw new Error('The tunnel is online but reported no live editor agent host. Is the Fumie desktop window open?');
					}
					result = await service.completeSelection(selection.selectionId, { instanceId: editor.instanceId });
				} else {
					result = await service.connect(token, 'github', tunnel.tunnelId, tunnel.clusterId);
				}
				const connectionId = result.connectionId;
				let closed = false;
				return {
					send: message => service.relaySend(connectionId, message),
					onMessage: listener => service.onDidRelayMessage(event => {
						if (event.connectionId === connectionId) {
							listener(event.data);
						}
					}),
					onClose: listener => service.onDidRelayClose(closedConnectionId => {
						if (closedConnectionId === connectionId) {
							closed = true;
							listener();
						}
					}),
					async close(): Promise<void> {
						if (!closed) {
							closed = true;
							await service.disconnect(connectionId);
						}
					},
				};
			},
		},
	};
}

async function stopAgentHost(agentHost: ChildProcessWithoutNullStreams | undefined): Promise<void> {
	if (!agentHost || agentHost.exitCode !== null) {
		return;
	}

	const waitForExit = new Promise<void>(resolve => agentHost.once('exit', () => resolve()));
	agentHost.kill('SIGTERM');
	await Promise.race([
		waitForExit,
		new Promise<void>(resolve => setTimeout(resolve, 5_000)),
	]);
	if (agentHost.exitCode === null) {
		agentHost.kill('SIGKILL');
		await waitForExit;
	}
}

interface WebTunnelResources {
	client: TunnelManagementHttpClientType;
	host: TunnelRelayTunnelHostType;
	tunnel: Tunnel;
}

async function startWebTunnel(port: number, capability: string, onAllocated: (resources: WebTunnelResources) => void): Promise<WebTunnelResources & { url: string }> {
	const githubToken = await readGitHubToken();
	const client = createManagementClient(githubToken);
	const privateAccessControl = {
		entries: [{
			type: TunnelAccessControlEntryType.Anonymous,
			isDeny: true,
			isInherited: false,
			isInverse: false,
			subjects: [],
			scopes: [TunnelAccessScopes.Connect],
		}],
	};
	const tunnel = await client.createTunnel({
		labels: ['fumie-mobile-preview', `preview-${capability.slice(0, 10)}`],
		ports: [{
			portNumber: port,
			protocol: TunnelProtocol.Http,
			isDefault: true,
			accessControl: privateAccessControl,
		}],
	}, {
		includePorts: true,
		tokenScopes: [TunnelAccessScopes.Host, TunnelAccessScopes.Connect],
	});

	const host = new TunnelRelayTunnelHost(client);
	host.forwardConnectionsToLocalPorts = true;
	onAllocated({ client, host, tunnel });
	try {
		await host.connect(tunnel);
		const resolved = await client.getTunnel(tunnel, {
			includePorts: true,
			tokenScopes: [TunnelAccessScopes.Host, TunnelAccessScopes.Connect],
		});
		const forwardingUrl = resolved?.ports?.find(candidate => candidate.portNumber === port)?.portForwardingUris?.[0];
		if (!forwardingUrl) {
			throw new Error('Microsoft Dev Tunnels did not return a web forwarding URL');
		}
		const url = new URL(forwardingUrl);
		url.pathname = `/preview/${encodeURIComponent(capability)}`;
		url.search = '';
		return { client, host, tunnel, url: url.toString() };
	} catch (error) {
		await host.dispose().catch(() => undefined);
		await client.deleteTunnel(tunnel).catch(() => undefined);
		await client.dispose().catch(() => undefined);
		throw error;
	}
}

async function cleanupStaleTunnels(): Promise<number> {
	const githubToken = await readGitHubToken();
	const client = createManagementClient(githubToken);
	let deletedCount = 0;
	try {
		const tunnels = await client.listTunnels(undefined, undefined, {
			labels: ['fumie-mobile-preview'],
			requireAllLabels: true,
			limit: 100,
		});
		for (const tunnel of tunnels) {
			const hostConnectionCount = tunnel.status?.hostConnectionCount;
			const currentHosts = typeof hostConnectionCount === 'number' ? hostConnectionCount : hostConnectionCount?.current;
			if (currentHosts === 0) {
				await client.deleteTunnel(tunnel);
				deletedCount++;
			}
		}
		return deletedCount;
	} finally {
		await client.dispose();
	}
}

function createManagementClient(githubToken: string): TunnelManagementHttpClientType {
	return new TunnelManagementHttpClient(
		'fumie-mobile-preview',
		ManagementApiVersions.Version20230927preview,
		async () => `github ${githubToken}`,
	);
}

function readGitHubToken(): Promise<string> {
	return new Promise((resolve, reject) => {
		childProcess.execFile('gh', ['auth', 'token', '--hostname', 'github.com'], {
			encoding: 'utf8',
			maxBuffer: 1024 * 1024,
		}, (error, stdout) => {
			if (error || !stdout.trim()) {
				reject(new Error('GitHub CLI is not signed in. Run gh auth login --hostname github.com, then retry.'));
				return;
			}
			resolve(stdout.trim());
		});
	});
}

main().catch(error => {
	process.stderr.write(`\nMobile agent preview failed: ${error.stack ?? error}\n`);
	process.exitCode = 1;
});
