/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IMobileClientInfo, ITunnelHostInfo } from '../../../../platform/agentHost/common/tunnelAgentHost.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import product from '../../../../platform/product/common/product.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ITunnelHostService } from '../../../../workbench/contrib/chat/common/tunnelHost.js';
import { CONFIGURATION_KEY_MICROSOFT_AUTH } from '../../../../workbench/contrib/chat/electron-browser/tunnelHostService.js';
import { IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';

/**
 * Remembers that the user left "Allow Remote Connections" on so the tunnel is
 * armed again on the next launch. Machine-scoped on purpose: an intent to
 * expose *this* machine must never travel to another one through settings sync.
 */
export const TUNNEL_HOST_SHARING_INTENT_KEY = 'sessions.tunnelHost.sharingIntent';

/** Lets the user opt out of the restore without giving up the toggle. */
export const TunnelHostRestoreSharingSettingId = 'chat.remoteConnectionsRestoreOnStartup';

/** The auth providers the tunnel host will try, in the order it tries them. */
type TunnelAuthProvider = 'github' | 'microsoft';

/**
 * Whether a tunnel credential is already cached. `startSharing` falls back to
 * an interactive sign-in when nothing is cached, which must never happen
 * unprompted during startup.
 */
export async function hasCachedTunnelAuth(authenticationService: Pick<IAuthenticationService, 'getSessions'>, microsoftAuthEnabled: boolean): Promise<boolean> {
	const providers: TunnelAuthProvider[] = microsoftAuthEnabled ? ['microsoft', 'github'] : ['github'];
	for (const provider of providers) {
		const scopes = product.tunnelApplicationConfig?.authenticationProviders?.[provider]?.scopes ?? [];
		if (scopes.length === 0) {
			continue;
		}
		// A session with broader scopes works too — this mirrors the superset
		// match `TunnelHostService._getTokenForProvider` does before prompting.
		const sessions = await authenticationService.getSessions(provider, undefined, {}, true).catch(() => []);
		if (sessions.some(session => scopes.every(scope => session.scopes.includes(scope)))) {
			return true;
		}
	}
	return false;
}

/**
 * The tunnel host as upstream registers it, before {@link SharingIntentTunnelHostService}
 * wraps it. Kept under an identifier of its own so the wrapper can take over
 * `ITunnelHostService` itself, which is what puts the recording in front of
 * every caller rather than in front of the ones we remembered to change.
 */
export const ITunnelHostDelegate = createDecorator<ITunnelHostService>('tunnelHostDelegate');

/**
 * Records the user's sharing intent as it passes through the service, so that
 * turning sharing on is remembered whichever control did it.
 *
 * The intent used to be read off the toggle command executing, which the
 * checkbox on Settings → Remote Connections never runs — it calls the service
 * directly, so the clicks the user actually makes went unrecorded and the
 * restore below never had anything to restore. The command, the sidebar
 * control, the checkbox and whatever is added next all arrive here instead.
 */
export class SharingIntentTunnelHostService implements ITunnelHostService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ITunnelHostDelegate private readonly _tunnelHostService: ITunnelHostService,
		@IStorageService private readonly _storageService: IStorageService,
	) { }

	get onDidChangeStatus(): Event<void> { return this._tunnelHostService.onDidChangeStatus; }

	get isSharing(): boolean { return this._tunnelHostService.isSharing; }

	get isConnecting(): boolean { return this._tunnelHostService.isConnecting; }

	get sharingInfo(): ITunnelHostInfo | undefined { return this._tunnelHostService.sharingInfo; }

	async startSharing(): Promise<void> {
		// Recorded before the attempt, not after it: the ask is the intent, and
		// a tunnel that fails to come up now is still one the user wants back.
		this._recordIntent(true);
		await this._tunnelHostService.startSharing();
	}

	async stopSharing(): Promise<void> {
		this._recordIntent(false);
		await this._tunnelHostService.stopSharing();
	}

	/** Not an intent to start or stop sharing, so nothing to record. */
	rollPhonePairing(): Promise<void> {
		return this._tunnelHostService.rollPhonePairing();
	}

	// The clients surface carries no sharing intent either — pure pass-through.

	get onDidChangeClients(): Event<readonly IMobileClientInfo[]> { return this._tunnelHostService.onDidChangeClients; }

	listClients(): Promise<readonly IMobileClientInfo[]> {
		return this._tunnelHostService.listClients();
	}

	disconnectClient(id: string): Promise<void> {
		return this._tunnelHostService.disconnectClient(id);
	}

	private _recordIntent(sharing: boolean): void {
		this._storageService.store(TUNNEL_HOST_SHARING_INTENT_KEY, sharing, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

/**
 * Carries the "Allow Remote Connections" toggle across restarts. Sharing hosts
 * a dev tunnel that exposes this machine, so the restore is deliberately
 * narrow: it only runs when the user turned sharing on and never turned it off
 * again, it never signs in on the user's behalf, and it can be switched off
 * entirely with {@link TunnelHostRestoreSharingSettingId}.
 *
 * The stored value is the user's intent, recorded by
 * {@link SharingIntentTunnelHostService} rather than read from the tunnel's
 * status — a tunnel that drops on its own is not the user asking to stop
 * sharing, and must still come back on the next launch.
 */
export class TunnelHostSharingRestoreContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsTunnelHostSharingRestore';

	/** Settles once the startup restore attempt is done. Visible for testing. */
	readonly restored: Promise<void>;

	constructor(
		@ITunnelHostService private readonly _tunnelHostService: ITunnelHostService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		const intent = storageService.getBoolean(TUNNEL_HOST_SHARING_INTENT_KEY, StorageScope.APPLICATION, false);
		this.restored = intent ? this._restoreSharing() : Promise.resolve();
	}

	private async _restoreSharing(): Promise<void> {
		if (this._tunnelHostService.isSharing || this._tunnelHostService.isConnecting) {
			return;
		}
		if (this._configurationService.getValue<boolean>(TunnelHostRestoreSharingSettingId) === false) {
			return;
		}

		const microsoftAuthEnabled = !!this._configurationService.getValue<boolean>(CONFIGURATION_KEY_MICROSOFT_AUTH);
		if (!await hasCachedTunnelAuth(this._authenticationService, microsoftAuthEnabled)) {
			// Leave the stored intent alone so the next launch can try again.
			this._logService.info('[TunnelHost] Not restoring remote connections: no cached tunnel credentials.');
			return;
		}

		try {
			await this._tunnelHostService.startSharing();
		} catch (err) {
			this._logService.warn(`[TunnelHost] Failed to restore remote connections: ${toErrorMessage(err)}`);
		}
	}
}
