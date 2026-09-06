/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { AGENT_SDK_SETUP_CANCEL_SIGN_IN_REQUEST_KEY, AGENT_SDK_SETUP_DOWNLOAD_REQUEST_KEY, AGENT_SDK_SETUP_RELOAD_REQUEST_KEY, AGENT_SDK_SETUP_SIGN_IN_REQUEST_KEY, AgentSdkAccountStatus, AgentSdkDownloadStatus, IAgentSdkSetupInfo, agentSdkSetupStatusKey, isAgentSdkSetupRequestFor } from '../common/agentSdkSetup.js';
import { IAgentConfigurationService } from './agentConfigurationService.js';
import { IAgentSdkDownloader, IAgentSdkPackage } from './agentSdkDownloader.js';

/** The per-agent half of {@link AgentSdkSetupChannel}. */
export interface IAgentSdkSetupChannelAgent {
	/** Agent/provider id, which becomes {@link IAgentSdkSetupInfo.agent}. */
	readonly id: string;
	readonly sdkPackage: IAgentSdkPackage;

	/** What this agent offers besides the download. Published verbatim. */
	readonly setupInfo: Omit<IAgentSdkSetupInfo, 'agent' | 'download' | 'accountStatus'>;

	/**
	 * Start the agent's official sign-in process. Absent when it has no in-app
	 * route.
	 *
	 * `token` fires when the attempt is abandoned — the user pressed sign in
	 * again, cancelled, or the host is shutting down. The implementation must
	 * stop whatever it started (an OAuth flow typically waits on a browser
	 * round-trip that may never come) and settle the promise.
	 */
	signIn?(token: CancellationToken): Promise<void>;

	/** Latest result of the agent's own account check. */
	getAccountStatus?(): AgentSdkAccountStatus;

	/** Whether the SDK can be loaded without a network fetch. */
	isSdkLocal(): Promise<boolean>;

	/** Fetch the SDK. Only ever called for the explicit gesture. */
	downloadSdk(): Promise<void>;

	/** Restart chat discovery, which defers itself while there is no SDK to read a catalog from. */
	restartChatDiscovery(): void;

	/** Re-enumerate models against the SDK that just landed. */
	refreshModels(): Promise<void>;
}

/**
 * One agent's side of the SDK setup channel: publishes whether its SDK is on
 * disk, performs the download the workbench asks for, and looks again when it
 * asks for that. Every agent needs the same nonce handling, latching and publish
 * ordering, so only the calls in {@link IAgentSdkSetupChannelAgent} differ.
 */
export class AgentSdkSetupChannel extends Disposable {

	/** Consumed request nonce per request key, so a root-config change we caused isn't re-handled. */
	private readonly _lastRequests = new Map<string, string>();

	/**
	 * Latched while the *explicit* download runs. {@link IAgentSdkSetupChannelAgent.isSdkLocal}
	 * stays false throughout, so without this the channel could only ever report
	 * `notDownloaded` and the banner would keep offering a button for work already
	 * underway. Deliberately not a query on the downloader, which would also latch
	 * for background fetches — those are the ones the user never asked for and so
	 * must stay invisible.
	 */
	private _downloadInFlight = false;

	/**
	 * The sign-in attempt currently running, if any. Cancelling it is how an
	 * attempt is abandoned — the shell has no view into the browser flow, so the
	 * only things that can end one are the process finishing or the user asking
	 * for another. Holding the source rather than a boolean is what lets a repeat
	 * press supersede instead of being swallowed.
	 */
	private _signInAttempt: CancellationTokenSource | undefined;

	constructor(
		private readonly _agent: IAgentSdkSetupChannelAgent,
		private readonly _configurationService: IAgentConfigurationService,
		private readonly _downloader: IAgentSdkDownloader,
		private readonly _logService: ILogService,
	) {
		super();
		// The workbench addresses the agent through the root config bag. The key is
		// cleared as it is consumed so a later identical press still lands.
		this._register(this._configurationService.onDidRootConfigChange(() => this._handleRequest()));
		queueMicrotask(() => { void this.publish(); });
	}

	/** Publish the current status, paying for the is-local probe. */
	async publish(): Promise<void> {
		this.publishWith(await this._agent.isSdkLocal());
	}

	/** The synchronous half, for callers that have just paid for the probe. */
	publishWith(sdkIsLocal: boolean): void {
		const download: AgentSdkDownloadStatus = this._downloadInFlight
			? 'downloading'
			: sdkIsLocal ? 'ready' : 'notDownloaded';
		const accountStatus = this._signInAttempt ? 'signingIn' : this._agent.getAccountStatus?.();
		const info: Omit<IAgentSdkSetupInfo, 'agent'> = { ...this._agent.setupInfo, download, accountStatus };
		this._configurationService.publishRootTransientValues?.({ [agentSdkSetupStatusKey(this._agent.id)]: info });
	}

	private _handleRequest(): void {
		const values = this._configurationService.getRootConfigValues?.() ?? {};
		if (this._takeRequest(values, AGENT_SDK_SETUP_DOWNLOAD_REQUEST_KEY)) {
			void this._download();
		}
		if (this._takeRequest(values, AGENT_SDK_SETUP_RELOAD_REQUEST_KEY)) {
			this._logService.info(`[AgentSdkSetup] ${this._agent.id}: reloading the agent's configuration at the user's request`);
			// Nothing to publish: the SDK is already on disk either way, and what the
			// banner reads is the catalog the re-look republishes.
			void this._lookAgain();
		}
		if (this._takeRequest(values, AGENT_SDK_SETUP_SIGN_IN_REQUEST_KEY)) {
			this._signIn();
		}
		if (this._takeRequest(values, AGENT_SDK_SETUP_CANCEL_SIGN_IN_REQUEST_KEY)) {
			this._cancelSignIn();
		}
	}

	/** Claim one request addressed to this agent, clearing the key so a repeat press still lands. */
	private _takeRequest(values: Readonly<Record<string, unknown>>, key: string): boolean {
		const request = values[key];
		if (!isAgentSdkSetupRequestFor(request, this._agent.id) || request.request === this._lastRequests.get(key)) {
			return false;
		}
		this._lastRequests.set(key, request.request);
		this._configurationService.updateRootConfig({ [key]: undefined });
		return true;
	}

	/**
	 * The explicit download gesture. Acquiring progress interest is what makes the
	 * fetch visible: the downloader only emits frames for a session that asked or an
	 * explicitly-registered interest, and this download belongs to no session.
	 */
	private async _download(): Promise<void> {
		if (this._downloadInFlight) {
			return;
		}
		const progressInterest = this._downloader.acquireDownloadProgressInterest(this._agent.sdkPackage);
		this._downloadInFlight = true;
		this.publishWith(false);
		try {
			this._logService.info(`[AgentSdkSetup] ${this._agent.id}: downloading the agent SDK at the user's request`);
			await this._agent.downloadSdk();
		} catch (error) {
			this._logService.error(error, `[AgentSdkSetup] ${this._agent.id}: agent SDK download failed`);
		} finally {
			this._downloadInFlight = false;
			progressInterest.dispose();
		}
		await this._lookAgain();
	}

	/**
	 * Start an official sign-in, abandoning any attempt already running.
	 *
	 * Never refused. What happens in the browser — the user cancelling, closing
	 * the tab, an authorization that simply never returns — is invisible from
	 * here, so a running attempt tells us nothing about whether the user still
	 * wants it. Pressing sign in again is the user saying they do; the honest
	 * answer is to drop the old flow and start over rather than swallow the
	 * press behind an "already signing in" latch it can never clear.
	 */
	private _signIn(): void {
		if (!this._agent.signIn) {
			return;
		}
		this._abandonSignInAttempt();
		const attempt = new CancellationTokenSource();
		this._signInAttempt = attempt;
		void this._runSignIn(attempt);
	}

	/** Abandon a running sign-in at the user's request and fall back to what the agent reports. */
	private _cancelSignIn(): void {
		if (!this._signInAttempt) {
			return;
		}
		this._logService.info(`[AgentSdkSetup] ${this._agent.id}: abandoning the official sign-in flow at the user's request`);
		this._abandonSignInAttempt();
		// Publish immediately so the UI leaves `signingIn` on the press rather
		// than waiting for the abandoned process to notice it was killed.
		this.publishWith(true);
	}

	/** Cancel and forget the current attempt, if any. Its own `finally` will not republish. */
	private _abandonSignInAttempt(): void {
		const attempt = this._signInAttempt;
		this._signInAttempt = undefined;
		attempt?.cancel();
		attempt?.dispose();
	}

	private async _runSignIn(attempt: CancellationTokenSource): Promise<void> {
		try {
			const sdkIsLocal = await this._agent.isSdkLocal();
			if (!sdkIsLocal) {
				this._logService.warn(`[AgentSdkSetup] ${this._agent.id}: ignored sign-in request because the agent SDK is not downloaded`);
				return;
			}
			this.publishWith(true);
			try {
				this._logService.info(`[AgentSdkSetup] ${this._agent.id}: starting the agent's official sign-in flow`);
				await this._agent.signIn?.(attempt.token);
			} catch (error) {
				this._logService.error(error, `[AgentSdkSetup] ${this._agent.id}: official sign-in process did not complete successfully`);
			}
			// A superseded or cancelled attempt has nothing to say: the run that
			// replaced it owns the state, and re-checking here would publish over it.
			if (this._signInAttempt !== attempt) {
				return;
			}
			// Process exit is not proof of authentication. The agent's own account
			// check inside refreshModels is the only operation that can settle it.
			await this._lookAgain();
		} catch (error) {
			this._logService.error(error, `[AgentSdkSetup] ${this._agent.id}: failed to recheck setup after sign-in`);
		} finally {
			if (this._signInAttempt === attempt) {
				this._signInAttempt = undefined;
				attempt.dispose();
				try {
					await this.publish();
				} catch (error) {
					this._logService.error(error, `[AgentSdkSetup] ${this._agent.id}: failed to publish setup after sign-in`);
				}
			}
		}
	}

	override dispose(): void {
		// A login process outliving the host would keep holding its OAuth callback port.
		this._abandonSignInAttempt();
		super.dispose();
	}

	/**
	 * Re-read the world after a download, reload, or official sign-in process. Each
	 * gesture can change what discovery and the authoritative account check see.
	 */
	private async _lookAgain(): Promise<void> {
		// Chat discovery deferred itself while there was no SDK to read the catalog
		// from; this is the one moment that can change.
		this._agent.restartChatDiscovery();
		// Second, not first: the refresh is what asks the SDK about the account, so
		// announcing `ready` ahead of it would show "no account found" to a user who
		// has one for as long as enumeration takes.
		await this._agent.refreshModels();
	}
}
