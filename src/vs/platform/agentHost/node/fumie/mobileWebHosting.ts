/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../log/common/log.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { IProductService } from '../../../product/common/productService.js';
import { MobileWebServer, type IMobileWebServerInfo } from './mobileWebServer.js';
import type { IAgentHostEndpointMetadata } from '../../common/agentHostEndpointRegistry.js';
import type { IMobileClientInfo } from '../../common/tunnelAgentHost.js';
import { AgentHostFumieHomeEnvVar, expandAgentHostUserPath } from '../../common/agentHostProductEnv.js';
import { readLocalAgentHostEndpointRegistry } from '../localAgentHostMetadata.js';
import { forgetMobileWebTunnel, readOrCreateMobileWebPairing, rememberMobileWebTunnel, rollMobileWebPairing, type IMobileWebPairing, type IMobileWebTunnelRef } from './mobileWebPairing.js';
import type { Tunnel, TunnelPort } from '@microsoft/dev-tunnels-contracts';
import type { TunnelRequestOptions } from '@microsoft/dev-tunnels-management';

const LOG_PREFIX = '[MobileWebHosting]';

/**
 * How long a start waits for the previous session's tunnel host to let go
 * before going ahead anyway. Two hosts on one tunnel is what this avoids;
 * waiting out a disconnect that has stalled on the network would cost the whole
 * feature.
 */
const TUNNEL_RELEASE_TIMEOUT_MS = 10 * 1000;

/** Where a run records the dev tunnel it created, under this installation's user data. */
const TUNNEL_RECORD_FILE = 'fumie-mobile-web-tunnel.json';

/**
 * Read a tunnel record, or `undefined` for anything that is not one.
 *
 * A record is only ever used to delete a tunnel, so half of one is worth
 * nothing: a file that has been truncated, hand-edited or written by an older
 * shape must leave the previous tunnel alone rather than aim the delete at a
 * guess.
 */
export function parseMobileWebTunnelRecord(raw: string): IMobileWebTunnelRef | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const { tunnelId, clusterId } = parsed as Record<string, unknown>;
	return typeof tunnelId === 'string' && tunnelId && typeof clusterId === 'string' && clusterId
		? { tunnelId, clusterId }
		: undefined;
}

/** A live editor agent host published in the shared local endpoint registry. */
type IEditorSocketEndpoint = IAgentHostEndpointMetadata & { readonly endpoint: { readonly type: 'socket'; readonly path: string } };

/**
 * `ws+unix://<socket path>:/<request path>` is how `ws` addresses a unix socket
 * or a Windows named pipe: everything before the `:` becomes `socketPath`, and
 * everything after is the request line the agent host's `verifyClient` reads
 * the `tkn` query from.
 */
export function desktopAgentHostSocketUrl(endpoint: IEditorSocketEndpoint): string {
	return `ws+unix://${endpoint.endpoint.path}:/?tkn=${encodeURIComponent(endpoint.connectionToken)}`;
}

/**
 * The live editor agent hosts this machine publishes.
 *
 * `readLocalAgentHostEndpointRegistry` already drops entries whose PID is gone.
 * Entries whose socket file has vanished are dropped too, which happens when a
 * host was killed hard enough to skip its cleanup and the PID got reused.
 */
export function liveEditorSocketEndpoints(entries: readonly IAgentHostEndpointMetadata[]): IEditorSocketEndpoint[] {
	return entries.filter((entry): entry is IEditorSocketEndpoint =>
		entry.type === 'editor'
		&& entry.endpoint.type === 'socket'
		&& (process.platform === 'win32' || fs.existsSync(entry.endpoint.path)));
}

/**
 * Pick the agent host belonging to *this* application.
 *
 * One `FUMIE_HOME` can hold several desktops — a packaged Fumie and a source
 * build both publish here — and attaching the phone to the wrong one would
 * silently hand it another workspace and session catalog. The agent host and
 * this process are both utility processes of the same Electron main process, so
 * a shared parent PID identifies our own; that check only runs when the choice
 * is actually ambiguous.
 */
export async function selectOwnEditorEndpoint(
	candidates: readonly IEditorSocketEndpoint[],
	getParentPid: (pid: number) => Promise<number | undefined>,
	ownParentPid: number,
	logService: ILogService,
): Promise<IEditorSocketEndpoint | undefined> {
	if (candidates.length <= 1) {
		return candidates[0];
	}

	const owned: IEditorSocketEndpoint[] = [];
	for (const candidate of candidates) {
		if (await getParentPid(candidate.pid) === ownParentPid) {
			owned.push(candidate);
		}
	}
	if (owned.length === 1) {
		return owned[0];
	}

	logService.warn(`${LOG_PREFIX} ${candidates.length} desktop agent hosts are published and ${owned.length} belong to this app; using the first`);
	return (owned.length > 0 ? owned : candidates)[0];
}

function readParentPid(pid: number): Promise<number | undefined> {
	if (process.platform === 'win32') {
		return Promise.resolve(undefined);
	}
	return new Promise(resolve => {
		execFile('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], (error, stdout) => {
			const parsed = Number.parseInt(String(stdout).trim(), 10);
			resolve(error || Number.isNaN(parsed) ? undefined : parsed);
		});
	});
}

/** The half of a Dev Tunnels host {@link watchForwardedConnections} needs. */
export interface IForwardingTunnelHost {
	forwardedPortConnecting(listener: (event: { readonly stream: unknown }) => void): unknown;
}

/**
 * Keep a forwarded connection that dies mid-flight from taking the shared
 * process's error handler with it.
 *
 * Dev Tunnels forwards each connection by piping the phone's socket into an
 * `SshStream` over the relay (`StreamForwarder` in
 * `@microsoft/dev-tunnels-ssh-tcp`), and that pipe carries no `error` handler.
 * When the relay disposes a channel — a phone that walked out of range, a
 * reload, a relay-side timeout — anything still in flight is written into the
 * disposed channel, and the resulting stream error has nowhere left to go:
 *
 *     [uncaught exception in sharedProcess]: SshChannel disposed.
 *         at SshChannel.sendCommon (…/sshChannel.js:156:19)
 *         at SshStream.write [as _write] (…/sshStream.js:29:35)
 *
 * The connection is over either way, so the only thing worth doing is naming it
 * in this service's log instead of the process-wide one. `forwardedPortConnecting`
 * hands over the very stream the forwarder is about to pipe, which makes this
 * the one place the missing listener can be added.
 */
export function watchForwardedConnections(host: IForwardingTunnelHost, log: (message: string) => void): void {
	host.forwardedPortConnecting(event => {
		const stream = event.stream as { on?: (name: string, listener: (error: unknown) => void) => void } | undefined;
		stream?.on?.('error', error => {
			log(`A forwarded connection ended early: ${error instanceof Error ? error.message : String(error)}`);
		});
	});
}

/** The half of a Dev Tunnels management client {@link resolveMobileWebTunnel} needs. */
export interface IMobileWebTunnelClient {
	getTunnel(tunnel: Tunnel, options?: TunnelRequestOptions): Promise<Tunnel | null>;
	createTunnel(tunnel: Tunnel, options?: TunnelRequestOptions): Promise<Tunnel>;
	createOrUpdateTunnelPort(tunnel: Tunnel, tunnelPort: TunnelPort, options?: TunnelRequestOptions): Promise<TunnelPort>;
	deleteTunnelPort(tunnel: Tunnel, portNumber: number, options?: TunnelRequestOptions): Promise<boolean>;
}

/** What {@link resolveMobileWebTunnel} settled on, and whether the hostname survived. */
export interface IResolvedMobileWebTunnel {
	readonly tunnel: Tunnel;
	/**
	 * True when this is the tunnel the pairing already pointed at, which is the
	 * only case where the phone's remote address is unchanged. A caller uses it
	 * to decide whether the tunnel is safe to delete on failure — a reused one
	 * is the address itself, a fresh one is not yet anything.
	 */
	readonly reused: boolean;
}

/**
 * The dev tunnel this run hosts on: the pairing's, if the service still has it.
 *
 * This replaces creating a tunnel per run under a fixed name. A fixed name does
 * not work on a personal GitHub account — `checkNameAvailablility` answers 403
 * `The allow custom tunnel names feature is disabled`, so every run took a
 * service-assigned name and the hostname moved regardless. Reconnecting to the
 * same tunnel keeps whatever name the service picked the first time, which is
 * the only kind of stable hostname actually on offer.
 *
 * The port is restated rather than assumed: a run whose pinned local port was
 * taken comes up on another one, and a tunnel still forwarding the old port
 * would forward to nothing. Restating it also reasserts the port's access
 * control, which matters more than the forwarding does — a reused tunnel
 * carries whatever ACL it was last left with, and the deny-anonymous entry is
 * the only thing between this address and the open internet.
 *
 * Whether re-pointing a reused tunnel at a *different* port keeps the hostname
 * is not known here: the port number is part of the host label
 * (`<name>-<port>.<cluster>.devtunnels.ms`), so the service may well answer on
 * a new one. That path is only reached when the pinned port was already lost,
 * which is reported on its own, and nothing this function could do would
 * change the outcome either way.
 */
export async function resolveMobileWebTunnel(
	client: IMobileWebTunnelClient,
	remembered: IMobileWebTunnelRef | undefined,
	port: TunnelPort,
	requestOptions: TunnelRequestOptions,
	report: (message: string, error?: unknown) => void,
): Promise<IResolvedMobileWebTunnel> {
	if (remembered) {
		let existing: Tunnel | null;
		try {
			existing = await client.getTunnel({ ...remembered }, requestOptions);
		} catch (error) {
			// The management SDK preserves Axios response.status on failures;
			// getTunnel does not opt into converting a 404 response to null.
			if ((error as { response?: { status?: number } } | null)?.response?.status !== 404) {
				throw new Error('Could not check the existing phone tunnel; its address is preserved. Try connecting again.', { cause: error });
			}
			existing = null;
		}
		if (existing) {
			try {
				await client.createOrUpdateTunnelPort(existing, port, requestOptions);
				for (const stale of existing.ports ?? []) {
					if (stale.portNumber !== port.portNumber) {
						await client.deleteTunnelPort(existing, stale.portNumber, requestOptions);
					}
				}
			} catch (error) {
				throw new Error('Could not configure the existing phone tunnel; its address is preserved. Try connecting again.', { cause: error });
			}
			return { tunnel: existing, reused: true };
		}
		report(`The dev tunnel this pairing used is gone, so a new one is created and the phone address moves (${remembered.tunnelId})`);
	}

	const tunnel = await client.createTunnel({
		// One label, and nothing about the capability in it. The second label
		// used to be `mobile-<first ten characters of the capability>`, which
		// published a tenth of the secret into tunnel metadata — cheap when the
		// capability died with the process, and no longer cheap now that it
		// survives restarts.
		labels: ['fumie-mobile-web'],
		ports: [port],
	}, requestOptions);
	return { tunnel, reused: false };
}

export interface IMobileWebHostingStatus {
	readonly active: boolean;
	readonly localUrl?: string;
	readonly publicUrl?: string;
	/**
	 * Why {@link publicUrl} is absent even though hosting is active.
	 *
	 * The dev tunnel is created separately from the local server and can fail on
	 * its own — an expired token, no network, or the account's tunnel quota. The
	 * local address still works when it does, so hosting stays active and only
	 * the remote half is missing. Carrying the reason is what lets the settings
	 * page say the remote address is unavailable and why, instead of dropping
	 * the row and leaving the user to guess whether it was ever meant to be there.
	 */
	readonly publicUrlError?: string;
}

export class MobileWebHostingService extends Disposable {

	private readonly _session = this._register(new MutableDisposable());
	private _status: IMobileWebHostingStatus = { active: false };

	/**
	 * Settles once the previous session's tunnel host has actually let go.
	 *
	 * Tearing the session down can only *start* that: disposal is synchronous
	 * and disconnecting from the relay is a round trip. The tunnel outlives the
	 * session now, so a restart that does not wait would have two hosts
	 * claiming one tunnel and the relay picking between them.
	 */
	private _tunnelReleased: Promise<void> = Promise.resolve();

	private readonly _onDidChangeStatus = this._register(new Emitter<IMobileWebHostingStatus>());
	readonly onDidChangeStatus: Event<IMobileWebHostingStatus> = this._onDidChangeStatus.event;

	/**
	 * The server this session is hosting on, for the questions that are about
	 * the live server rather than about the addresses it answers at.
	 */
	private _server: MobileWebServer | undefined;

	private readonly _onDidChangeClients = this._register(new Emitter<readonly IMobileClientInfo[]>());
	readonly onDidChangeClients: Event<readonly IMobileClientInfo[]> = this._onDidChangeClients.event;

	constructor(
		private readonly _logService: ILogService,
		private readonly _environmentService: INativeEnvironmentService,
		private readonly _productService: IProductService,
	) {
		super();
	}

	get status(): IMobileWebHostingStatus {
		return this._status;
	}

	/** The clients bridged onto this machine right now; nothing is hosting, nothing is connected. */
	get clients(): readonly IMobileClientInfo[] {
		return this._server?.clients ?? [];
	}

	/** See {@link MobileWebServer.disconnectClient}. Answers whether the id matched a client. */
	disconnectClient(id: string): boolean {
		return this._server?.disconnectClient(id) ?? false;
	}

	async start(token: string, authProvider: 'github' | 'microsoft'): Promise<IMobileWebHostingStatus> {
		this._session.clear();
		await raceTimeout(this._tunnelReleased, TUNNEL_RELEASE_TIMEOUT_MS);

		const webBundleRoot = this._resolveWebBundleRoot();
		if (!webBundleRoot) {
			this._logService.warn(`${LOG_PREFIX} Web bundle not found; mobile web hosting unavailable`);
			return this._status;
		}

		const pairing = await this._readPairing();

		// Loopback only. Reaching this machine from elsewhere goes through the
		// dev tunnel, which is private and makes the far device sign in first;
		// binding every interface additionally handed anyone on the same network
		// the whole agent host for the price of the URL, with no sign-in at all.
		const server = new MobileWebServer({
			webBundleRoot,
			resolveAgentHostUrl: () => this._resolveAgentHostUrl(),
			host: '127.0.0.1',
			capability: pairing?.secret,
			port: pairing?.port,
		});
		const session = new DisposableStore();
		session.add(server);
		session.add(server.onDidFallBackFromPinnedPort(reason =>
			this._logService.warn(`${LOG_PREFIX} The phone address moved: ${reason}`)));
		session.add(server.onDidFailToReachAgentHost(error =>
			this._logService.warn(`${LOG_PREFIX} A phone reached the page but no agent host could be resolved`, error)));
		session.add(server.onDidRejectUpgrade(reason =>
			this._logService.warn(`${LOG_PREFIX} Refused a client's agent host bridge: ${reason}`)));
		session.add(server.onDidReceiveUpgrade(request =>
			this._logService.info(`${LOG_PREFIX} A client asked for an agent host bridge: ${request}`)));
		session.add(server.onDidBridgeClient(() =>
			this._logService.info(`${LOG_PREFIX} Bridged a client onto this machine's agent host`)));
		session.add(server.onDidChangeClients(clients => this._onDidChangeClients.fire(clients)));
		// The server going away is a change to the client list that the server
		// itself cannot report: its own emitters die with it.
		session.add(toDisposable(() => {
			if (this._server === server) {
				this._server = undefined;
				this._onDidChangeClients.fire([]);
			}
		}));

		try {
			const info = await server.start();
			this._server = server;
			this._logService.info(`${LOG_PREFIX} Server started on port ${info.port}`);

			let publicUrl: string | undefined;
			let publicUrlError: string | undefined;
			try {
				publicUrl = await this._createTunnel(info, token, authProvider, server, session, pairing);
			} catch (tunnelError) {
				publicUrlError = tunnelError instanceof Error ? tunnelError.message : String(tunnelError);
				this._logService.warn(`${LOG_PREFIX} Dev Tunnel creation failed; mobile web available on local network only`, tunnelError);
			}

			this._session.value = session;
			this._status = {
				active: true,
				localUrl: info.localUrl,
				publicUrl,
				publicUrlError,
			};
			this._onDidChangeStatus.fire(this._status);
			return this._status;
		} catch (error) {
			session.dispose();
			throw error;
		}
	}

	/**
	 * The agent host to bridge a phone onto: this desktop's own, over the
	 * socket it publishes in the shared local endpoint registry.
	 *
	 * This is the address `scripts/mobile-agent-preview --desktop-agent-host`
	 * uses, and the same registry the tunnel CLI's selection gateway reads.
	 * There is deliberately no loopback TCP fallback: the agent host publishes
	 * a socket and nothing else, so a second address would only ever be wrong.
	 */
	private async _resolveAgentHostUrl(): Promise<string> {
		const registryRoot = this._agentHostUserDataPath();
		const candidates = liveEditorSocketEndpoints(await readLocalAgentHostEndpointRegistry(registryRoot, this._logService));
		const endpoint = await selectOwnEditorEndpoint(candidates, readParentPid, process.ppid, this._logService);
		if (!endpoint) {
			throw new Error(`No desktop agent host is published under ${registryRoot}`);
		}
		return desktopAgentHostSocketUrl(endpoint);
	}

	/**
	 * Where the agent host publishes its endpoint: `FUMIE_HOME` when the app
	 * sets one, otherwise the distribution default, mirroring the order
	 * `applyAgentHostProductEnv` uses to hand the value to the host itself.
	 */
	private _agentHostUserDataPath(): string {
		return expandAgentHostUserPath(process.env[AgentHostFumieHomeEnvVar] ?? this._productService.agentHostDefaultFumieHome)
			?? this._environmentService.userDataPath;
	}

	/**
	 * The pairing that keeps the phone's address the same from one run to the
	 * next.
	 *
	 * A pairing that can neither be read nor written is not fatal: hosting still
	 * comes up on a one-off capability and an OS-assigned port, which is exactly
	 * what this file did before there was a pairing at all. Saying so in the log
	 * is the only way anyone finds out why the address moved again.
	 */
	private async _readPairing(): Promise<IMobileWebPairing | undefined> {
		try {
			return await readOrCreateMobileWebPairing(this._agentHostUserDataPath());
		} catch (error) {
			this._logService.warn(`${LOG_PREFIX} Could not read or create the phone pairing; this run takes a one-off address`, error);
			return undefined;
		}
	}

	/**
	 * Replace the secret every phone address carries, and give up the host it
	 * carries too, so every address handed out before now stops working.
	 *
	 * The secret alone would do it for the path, but the hostname is the other
	 * half of what was pasted onto a phone and it is the half that persists by
	 * design now — so the tunnel goes as well, and the next start takes a new
	 * one. Deleting it is best effort: the file is already rewritten by then,
	 * and a delete that fails leaves a tunnel that is no longer the pairing's
	 * and gets picked up as a leftover instead. Blocking the reset on a network
	 * round trip would be the worse trade.
	 *
	 * Restarting is the caller's job. This only rewrites the file, and a server
	 * that is already up goes on serving the old address until it is started
	 * again — which also makes rolling while hosting is off a complete operation
	 * on its own, since the next start reads the new secret.
	 */
	async rollPairing(credential?: { readonly token: string; readonly authProvider: 'github' | 'microsoft' }): Promise<void> {
		const { releasedTunnel } = await rollMobileWebPairing(this._agentHostUserDataPath());
		this._logService.info(`${LOG_PREFIX} Rolled the phone pairing; every address issued before now is dead`);

		if (!releasedTunnel) {
			return;
		}
		if (!credential) {
			// Nothing to authenticate a delete with, which is the case when
			// sharing is off. The reference is gone from the pairing either
			// way, so the next start reclaims it as a leftover.
			this._logService.info(`${LOG_PREFIX} The old dev tunnel is left for the next start to reclaim (${releasedTunnel.tunnelId})`);
			return;
		}

		const client = await this._createManagementClient(credential.token, credential.authProvider);
		try {
			await client.deleteTunnel({ ...releasedTunnel });
			this._logService.info(`${LOG_PREFIX} Deleted the dev tunnel the old address lived on (${releasedTunnel.tunnelId})`);
		} catch (error) {
			this._logService.warn(`${LOG_PREFIX} Could not delete the dev tunnel the old address lived on (${releasedTunnel.tunnelId})`, error);
		} finally {
			await client.dispose().catch(() => undefined);
		}
	}

	stop(): void {
		this._session.clear();
		this._status = { active: false };
		this._onDidChangeStatus.fire(this._status);
		this._logService.info(`${LOG_PREFIX} Stopped`);
	}

	/**
	 * Locate the packaged mobile web bundle.
	 *
	 * `appRoot` alone is not enough. Fumie Debug ships as a launcher app around
	 * a nested runtime app, so the root this process reports does not always
	 * land on the directory the bundle was copied into, and the only symptom
	 * was a warning saying the bundle was missing while it sat on disk. Try the
	 * roots the bundle can legitimately occupy, and say which ones were tried
	 * when none of them hold it.
	 */
	private _resolveWebBundleRoot(): string | undefined {
		// Start at the app root, then walk up from the running executable.
		// Fumie Debug ships as a launcher app around a nested runtime app, so
		// the root this process reports does not always land on the directory
		// the bundle was copied into; whichever ancestor holds it is the right
		// one, without this code having to know the package layout.
		const roots: string[] = [];
		const add = (root: string | undefined) => {
			if (root && !roots.includes(root)) {
				roots.push(root);
			}
		};
		add(this._environmentService.appRoot);
		let dir: string | undefined = path.dirname(process.execPath);
		for (let depth = 0; dir && depth < 8; depth++) {
			add(dir);
			add(path.join(dir, 'Resources', 'app'));
			const parent = path.dirname(dir);
			dir = parent === dir ? undefined : parent;
		}

		const tried: string[] = [];
		for (const root of roots) {
			const candidate = path.join(root, 'web-bundle');
			tried.push(candidate);
			try {
				if (fs.existsSync(candidate)) {
					this._logService.info(`${LOG_PREFIX} Web bundle at ${candidate}`);
					return candidate;
				}
			} catch {
				// An unreadable candidate is simply not the one.
			}
		}

		this._logService.warn(`${LOG_PREFIX} No web bundle at: ${tried.join(', ')}`);
		return undefined;
	}

	/** An authenticated Dev Tunnels management client, made the one way this service makes one. */
	private async _createManagementClient(token: string, authProvider: 'github' | 'microsoft') {
		const {
			ManagementApiVersions,
			TunnelManagementHttpClient,
		} = await import('@microsoft/dev-tunnels-management');
		const authCallback = async () => `${authProvider === 'github' ? 'github' : 'Bearer'} ${token}`;
		return new TunnelManagementHttpClient(
			'fumie-mobile-web',
			ManagementApiVersions.Version20230927preview,
			authCallback,
		);
	}

	private async _createTunnel(
		info: IMobileWebServerInfo,
		token: string,
		authProvider: 'github' | 'microsoft',
		server: MobileWebServer,
		session: DisposableStore,
		pairing: IMobileWebPairing | undefined,
	): Promise<string> {
		const {
			TunnelAccessControlEntryType,
			TunnelAccessScopes,
			TunnelProtocol,
		} = await import('@microsoft/dev-tunnels-contracts');
		const { TunnelRelayTunnelHost } = await import('@microsoft/dev-tunnels-connections');

		const client = await this._createManagementClient(token, authProvider);

		await this._reclaimPreviousTunnel(client, pairing?.tunnel);

		const requestOptions: TunnelRequestOptions = {
			includePorts: true,
			tokenScopes: [TunnelAccessScopes.Host, TunnelAccessScopes.Connect],
		};
		const port: TunnelPort = {
			portNumber: info.port,
			protocol: TunnelProtocol.Http,
			isDefault: true,
			// Restated on every start, reused tunnels included. This single
			// deny-anonymous entry is what makes the address private; a tunnel
			// that outlives the process could otherwise come back carrying an
			// ACL somebody widened out of band.
			accessControl: {
				entries: [{
					type: TunnelAccessControlEntryType.Anonymous,
					isDeny: true,
					isInherited: false,
					isInverse: false,
					subjects: [],
					scopes: [TunnelAccessScopes.Connect],
				}],
			},
		};

		const { tunnel, reused } = await resolveMobileWebTunnel(
			client,
			pairing?.tunnel,
			port,
			requestOptions,
			(message, error) => this._logService.warn(`${LOG_PREFIX} ${message}`, error),
		).catch(async error => {
			await client.dispose().catch(() => undefined);
			throw error;
		});
		this._logService.info(`${LOG_PREFIX} ${reused ? 'Reconnected to the dev tunnel this pairing already used' : 'Created a dev tunnel for this pairing'} (${tunnel.tunnelId})`);

		await this._recordTunnel(tunnel);
		if (!reused) {
			await this._rememberTunnel(pairing, tunnel);
		}

		const host = new TunnelRelayTunnelHost(client);
		(host as { forwardConnectionsToLocalPorts: boolean }).forwardConnectionsToLocalPorts = true;
		watchForwardedConnections(host, message => this._logService.info(`${LOG_PREFIX} ${message}`));

		/** Let go of the relay and the client, leaving the tunnel itself standing. */
		const releaseTunnel = async () => {
			await host.dispose().catch(() => undefined);
			await client.dispose().catch(() => undefined);
		};

		/**
		 * Give up a tunnel this start could not use.
		 *
		 * Only ever a freshly created one: a reused tunnel *is* the phone's
		 * address, and deleting it over a failure that a retry might not repeat
		 * would throw the address away to fix nothing.
		 */
		const discardTunnel = async () => {
			await host.dispose().catch(() => undefined);
			if (!reused) {
				await client.deleteTunnel(tunnel).catch(() => undefined);
				await this._forgetTunnel();
				await this._forgetPairedTunnel(pairing);
			}
			await client.dispose().catch(() => undefined);
		};

		try {
			await host.connect(tunnel);
		} catch (error) {
			await discardTunnel();
			throw error;
		}

		const resolved = await client.getTunnel(tunnel, requestOptions);
		const forwardingUrl = resolved?.ports?.find(p => p.portNumber === info.port)?.portForwardingUris?.[0];
		if (!forwardingUrl) {
			await discardTunnel();
			throw new Error('Dev Tunnels did not return a forwarding URL for the mobile web port');
		}

		// The forwarding URI is where Dev Tunnels puts an access token when the
		// tunnel denies anonymous connections, and the query is dropped below.
		// Record whether one was offered, without recording the token itself.
		this._logService.info(`${LOG_PREFIX} Forwarding URI carries a query: ${new URL(forwardingUrl).search.length > 0}`);
		const url = new URL(forwardingUrl);
		url.pathname = `/m/${info.capability}`;
		url.search = '';
		const publicUrl = url.toString();

		server.setPublicOrigin(url.origin);
		// The origin, and deliberately not the path: the path is `/m/<the
		// capability>`, and the capability now outlives the process, so writing
		// a whole public URL here would put a long-lived credential in a log
		// file that is kept, copied into bug reports and read over shoulders.
		// The origin is the half worth having anyway — it is what moves when
		// the tunnel could not be reconnected to.
		this._logService.info(`${LOG_PREFIX} Dev Tunnel active at ${url.origin}`);

		// Torn down with the session rather than by patching the server's own
		// `dispose`, and the promise it produces is kept: the next `start` waits
		// on it so two hosts never claim one tunnel. The tunnel itself stays —
		// it is the address, and outliving the process is the whole point.
		session.add(toDisposable(() => {
			this._tunnelReleased = releaseTunnel();
		}));

		return publicUrl;
	}

	private get _tunnelRecordPath(): string {
		return path.join(this._environmentService.userDataPath, TUNNEL_RECORD_FILE);
	}

	/**
	 * Delete a dev tunnel a previous run of this installation left behind —
	 * unless it is the one the pairing still points at.
	 *
	 * That exception is the whole change: the recorded tunnel used to be
	 * deleted unconditionally on every start, which is exactly what made the
	 * hostname move. Now the common case is that the record names the pairing's
	 * own tunnel and nothing is deleted at all. What is left to reclaim is a
	 * tunnel that stopped being the pairing's — a reset that could not reach the
	 * service, or a start that created one and then failed to record it — and
	 * Dev Tunnels caps how many tunnels one account may keep, so each such leak
	 * is permanent and enough of them stop any new tunnel being created.
	 *
	 * The record stays per installation rather than becoming a sweep over
	 * everything wearing the `fumie-mobile-web` label: another machine on the
	 * same account hosts a tunnel with exactly those labels, and its live tunnel
	 * is not ours to delete.
	 */
	private async _reclaimPreviousTunnel(
		client: { deleteTunnel(tunnel: Tunnel): Promise<boolean> },
		paired: IMobileWebTunnelRef | undefined,
	): Promise<void> {
		let raw: string;
		try {
			raw = await fs.promises.readFile(this._tunnelRecordPath, 'utf8');
		} catch {
			return; // No previous run recorded one, which is the common case.
		}

		const record = parseMobileWebTunnelRecord(raw);
		if (record && record.tunnelId === paired?.tunnelId && record.clusterId === paired.clusterId) {
			return; // This is the address, not a leftover.
		}
		if (record) {
			try {
				await client.deleteTunnel({ ...record });
				this._logService.info(`${LOG_PREFIX} Reclaimed the dev tunnel a previous run left behind (${record.tunnelId})`);
			} catch (error) {
				// Already gone, or no longer ours: either way the record has
				// served its purpose and this start carries on regardless.
				this._logService.warn(`${LOG_PREFIX} Could not delete the dev tunnel a previous run left behind (${record.tunnelId})`, error);
			}
		}
		await this._forgetTunnel();
	}

	/**
	 * Point the pairing at the tunnel this start created, so the next start
	 * reconnects to it rather than creating another and moving the hostname.
	 */
	private async _rememberTunnel(pairing: IMobileWebPairing | undefined, tunnel: Tunnel): Promise<void> {
		const { tunnelId, clusterId } = tunnel;
		if (!pairing || !tunnelId || !clusterId) {
			return;
		}
		try {
			await rememberMobileWebTunnel(this._agentHostUserDataPath(), pairing, { tunnelId, clusterId });
		} catch (error) {
			// Hosting still works; only the next start's hostname is lost.
			this._logService.warn(`${LOG_PREFIX} Could not record the dev tunnel in the pairing, so the next start takes a new address`, error);
		}
	}

	private async _forgetPairedTunnel(pairing: IMobileWebPairing | undefined): Promise<void> {
		if (!pairing) {
			return;
		}
		try {
			await forgetMobileWebTunnel(this._agentHostUserDataPath(), pairing);
		} catch (error) {
			this._logService.warn(`${LOG_PREFIX} Could not clear the dev tunnel from the pairing`, error);
		}
	}

	private async _recordTunnel(tunnel: { tunnelId?: string; clusterId?: string }): Promise<void> {
		const { tunnelId, clusterId } = tunnel;
		if (!tunnelId || !clusterId) {
			this._logService.warn(`${LOG_PREFIX} Dev Tunnels returned a tunnel without an identity; a crash would leak it`);
			return;
		}
		try {
			await fs.promises.writeFile(this._tunnelRecordPath, JSON.stringify({ tunnelId, clusterId } satisfies IMobileWebTunnelRef), 'utf8');
		} catch (error) {
			// Hosting still works; only the next run's clean-up is lost.
			this._logService.warn(`${LOG_PREFIX} Could not record the dev tunnel for clean-up`, error);
		}
	}

	private async _forgetTunnel(): Promise<void> {
		try {
			await fs.promises.rm(this._tunnelRecordPath, { force: true });
		} catch (error) {
			this._logService.warn(`${LOG_PREFIX} Could not clear the dev tunnel record`, error);
		}
	}
}
