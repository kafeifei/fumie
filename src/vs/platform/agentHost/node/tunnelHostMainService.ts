/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../../base/common/async.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { joinPath } from '../../../base/common/resources.js';
import { localize } from '../../../nls.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ILogger, ILoggerService, ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { ITunnelProcessCoordinator, ITunnelProcessOutput, ITunnelProcessStatus } from '../../remoteTunnel/node/tunnelProcessCoordinator.js';
import {
	ITunnelAgentHostHostingService,
	type IMobileClientInfo,
	type ITunnelHostInfo,
	type TunnelHostStatus,
	TUNNEL_HOST_LOG_ID,
} from '../common/tunnelAgentHost.js';
import { MobileWebHostingService, type IMobileWebHostingStatus } from './fumie/mobileWebHosting.js';

const AGENT_HOST_START_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Attach the mobile web addresses to a tunnel's sharing info.
 *
 * The two are reported separately and never substituted for one another. They
 * reach the same interface but differ in what it takes to open them, and a
 * loopback address presented as the remote one sends the user to copy an
 * address onto a phone that can never resolve it.
 */
export function withMobileAddresses(info: ITunnelHostInfo, mobile: IMobileWebHostingStatus | undefined): ITunnelHostInfo {
	return {
		...info,
		...(mobile?.publicUrl ? { mobileUrl: mobile.publicUrl } : {}),
		...(mobile?.localUrl ? { mobileLocalUrl: mobile.localUrl } : {}),
		...(!mobile?.publicUrl && mobile?.publicUrlError
			? { mobileUrlUnavailableReason: mobile.publicUrlError }
			: {}),
	};
}

/** Publishes agent host sharing status while the coordinator owns the tunnel process. */
export class TunnelHostMainService extends Disposable implements ITunnelAgentHostHostingService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<TunnelHostStatus>());
	readonly onDidChangeStatus: Event<TunnelHostStatus> = this._onDidChangeStatus.event;

	/**
	 * Declared as a field rather than an accessor because `ProxyChannel` finds
	 * the events it can serve by enumerating the service's own properties, and a
	 * prototype accessor is not one.
	 */
	readonly onDidChangeClients: Event<readonly IMobileClientInfo[]>;

	private readonly _logger: ILogger;
	private readonly _mobileWebHosting: MobileWebHostingService;
	private _request: { token: string; authProvider: 'github' | 'microsoft' } | undefined;
	private _lastStatus: TunnelHostStatus = { active: false };

	constructor(
		@ILoggerService loggerService: ILoggerService,
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@ILogService logService: ILogService,
		@ITunnelProcessCoordinator private readonly tunnelProcessCoordinator: ITunnelProcessCoordinator,
		@IProductService productService: IProductService,
	) {
		super();
		this._logger = this._register(loggerService.createLogger(
			joinPath(environmentService.logsHome, `${TUNNEL_HOST_LOG_ID}.log`),
			{ id: TUNNEL_HOST_LOG_ID, name: localize('tunnelHost.log', "Remote Connections") },
		));
		this._mobileWebHosting = this._register(new MobileWebHostingService(logService, environmentService, productService));
		this.onDidChangeClients = this._mobileWebHosting.onDidChangeClients;
		this._register(tunnelProcessCoordinator.onDidChangeStatus(status => this._emitStatus(status)));
		this._register(tunnelProcessCoordinator.onDidOutput(output => this._handleOutput(output)));
	}

	async startHosting(token: string, authProvider: 'github' | 'microsoft'): Promise<ITunnelHostInfo> {
		const request = { token, authProvider };
		this._request = request;
		// The readiness wait is created before the intent is handed over, so it
		// can outlive a rejection from the coordinator. Owning its store here
		// tears the wait down immediately instead of leaving it pending until
		// the start timeout elapses.
		const store = new DisposableStore();
		try {
			// Awaited together so the readiness promise always has a handler
			// attached: disposing the store below rejects it, which would
			// otherwise go unhandled on exactly the failure path this guards.
			const [status] = await Promise.all([
				this._waitForActiveStatus(store),
				this.tunnelProcessCoordinator.setAgentHostSharing({ token, authProvider, logLevel: this._logger.getLevel() }),
			]);

			// Start mobile web hosting alongside the tunnel (best-effort).
			// Both addresses are reported, not one or the other: they reach the
			// same server but differ in what it takes to get there, and only
			// the caller can say which one it wants to show.
			let mobileStatus: IMobileWebHostingStatus | undefined;
			try {
				mobileStatus = await this._mobileWebHosting.start(token, authProvider);
			} catch (mobileError) {
				this._logger.warn('Mobile web hosting failed to start', mobileError);
			}

			return withMobileAddresses(status.info, mobileStatus);
		} catch (error) {
			// Without this the caller sees a failure while the sharing intent
			// survives, and a later reconcile brings hosting online anyway.
			// A newer request owns the intent, so only roll back our own.
			if (this._request === request) {
				this._request = undefined;
				this._mobileWebHosting.stop();
				try {
					await this.tunnelProcessCoordinator.setAgentHostSharing(undefined);
				} catch (rollbackError) {
					this._logger.error(rollbackError);
				}
			}
			throw error;
		} finally {
			store.dispose();
		}
	}

	async stopHosting(): Promise<void> {
		this._request = undefined;
		this._mobileWebHosting.stop();
		await this.tunnelProcessCoordinator.setAgentHostSharing(undefined);
		this._emitStatus(this.tunnelProcessCoordinator.getStatus());
	}

	/**
	 * Take back every phone address handed out so far.
	 *
	 * A pairing that survives restarts is worth more than a per-process one and
	 * is more dangerous for the same reason, so it has to be revocable. The
	 * secret is what every issued URL and every stored cookie carries, so a new
	 * one kills all of them — but only once the server is serving it, which is
	 * why hosting is restarted here rather than left to pick the new secret up
	 * on the next launch. The token that restart needs is the one
	 * {@link startHosting} was handed and already keeps.
	 */
	async rollMobileWebPairing(): Promise<ITunnelHostInfo | undefined> {
		const request = this._request;

		// The same token pays for the tunnel delete: the reset gives up the
		// dev tunnel as well as the secret, and deleting one is authenticated.
		// With sharing off there is no token and no live tunnel to serve the
		// old address either, so the next start reclaims it as a leftover.
		await this._mobileWebHosting.rollPairing(request && { token: request.token, authProvider: request.authProvider });

		const status = this._getStatus(this.tunnelProcessCoordinator.getStatus());
		if (!request || !status.active) {
			return undefined;
		}

		let mobileStatus: IMobileWebHostingStatus | undefined;
		try {
			mobileStatus = await this._mobileWebHosting.start(request.token, request.authProvider);
		} catch (error) {
			// The old address is dead either way — the file is already
			// rewritten — so the caller is told what is left, not handed a
			// failure that suggests nothing happened.
			this._logger.warn('Mobile web hosting failed to restart onto the new pairing', error);
		}
		return withMobileAddresses(status.info, mobileStatus);
	}

	listClients(): Promise<readonly IMobileClientInfo[]> {
		return Promise.resolve(this._mobileWebHosting.clients);
	}

	async disconnectClient(id: string): Promise<void> {
		if (this._mobileWebHosting.disconnectClient(id)) {
			this._logger.info('Disconnected a client from this machine at the user\'s request');
		}
	}

	getStatus(): Promise<TunnelHostStatus> {
		return Promise.resolve(this._getStatus(this.tunnelProcessCoordinator.getStatus()));
	}

	private _handleOutput(output: ITunnelProcessOutput): void {
		if (output.mode !== 'agentHost') {
			return;
		}
		if (output.isError) {
			this._logger.error(output.message);
		} else {
			this._logger.info(output.message);
		}
	}

	private async _waitForActiveStatus(store: DisposableStore): Promise<TunnelHostStatus & { active: true; info: ITunnelHostInfo }> {
		const current = this._getStatus(this.tunnelProcessCoordinator.getStatus());
		if (current.active) {
			return current;
		}

		const settled = new DeferredPromise<TunnelHostStatus & { active: true; info: ITunnelHostInfo }>();
		store.add(this.tunnelProcessCoordinator.onDidChangeStatus(coordinatorStatus => {
			const status = this._getStatus(coordinatorStatus);
			if (status.active) {
				settled.complete(status);
			} else if (coordinatorStatus.mode === 'agentHost' && coordinatorStatus.connectionState === 'disconnected') {
				settled.error(new Error(localize('tunnelHost.startFailed', "The agent host tunnel exited before it became ready.")));
			}
		}));
		// Settles the race when the caller abandons the wait, so neither this
		// promise nor `raceTimeout`'s timer outlives the store.
		store.add(toDisposable(() => settled.error(new CancellationError())));

		const status = await raceTimeout(settled.p, AGENT_HOST_START_TIMEOUT_MS);
		if (!status) {
			throw new Error(localize('tunnelHost.startTimeout', "Timed out waiting for the agent host tunnel to start."));
		}
		return status;
	}

	private _getStatus(status: ITunnelProcessStatus): TunnelHostStatus {
		if (!this._request || status.connectionState !== 'connected' || !status.tunnelName) {
			return { active: false };
		}
		const info = {
			tunnelName: status.tunnelName,
			...(status.tunnelId === undefined ? {} : { tunnelId: status.tunnelId }),
		};
		if (status.mode === 'remoteAccess' || status.mode === 'service') {
			return { active: true, info: { ...info, viaRemoteTunnelAccess: true } };
		}
		if (status.mode === 'agentHost') {
			return { active: true, info };
		}
		return { active: false };
	}

	private _emitStatus(coordinatorStatus: ITunnelProcessStatus): void {
		const status = this._getStatus(coordinatorStatus);
		if (!status.active && !this._lastStatus.active) {
			return;
		}
		if (status.active && this._lastStatus.active
			&& status.info.tunnelName === this._lastStatus.info.tunnelName
			&& status.info.tunnelId === this._lastStatus.info.tunnelId
			&& status.info.viaRemoteTunnelAccess === this._lastStatus.info.viaRemoteTunnelAccess) {
			return;
		}
		this._lastStatus = status;
		this._onDidChangeStatus.fire(status);
	}

	override dispose(): void {
		this._request = undefined;
		this._mobileWebHosting.stop();
		void this.tunnelProcessCoordinator.setAgentHostSharing(undefined);
		super.dispose();
	}
}
