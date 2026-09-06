/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { AGENT_SDK_SETUP_CANCEL_SIGN_IN_REQUEST_KEY, AGENT_SDK_SETUP_DOWNLOAD_REQUEST_KEY, AGENT_SDK_SETUP_SIGN_IN_REQUEST_KEY, IAgentSdkSetupInfo, IAgentSdkSetupPresentationSource, readAgentSdkSetupInfos } from '../../../../../platform/agentHost/common/agentSdkSetup.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../../../../platform/agentHost/common/state/sessionActions.js';
import { ROOT_STATE_URI } from '../../../../../platform/agentHost/common/state/sessionState.js';

/**
 * The agent SDK setup a remote host publishes for its own agents, read straight
 * off that connection's root state.
 *
 * The window-wide `IAgentSdkSetupService` describes the agent host this window
 * started, which for a browser client is none at all — so the Models page would
 * fall back to a generic "no models" where the desktop says which sign-in is
 * missing. Download and sign-in are dispatched back over the same connection,
 * because the account belongs to the machine the agent runs on.
 */
export class RemoteAgentSdkSetup extends Disposable implements IAgentSdkSetupPresentationSource {

	private readonly _onDidChangeSetups = this._register(new Emitter<readonly IAgentSdkSetupInfo[]>());
	readonly onDidChangeSetups = this._onDidChangeSetups.event;

	private _setups: readonly IAgentSdkSetupInfo[] = [];
	get setups(): readonly IAgentSdkSetupInfo[] { return this._setups; }

	constructor(private readonly _connection: IAgentConnection) {
		super();
		this._setups = readAgentSdkSetupInfos(this._readRootState());
		this._register(this._connection.rootState.onDidChange(() => {
			this._setups = readAgentSdkSetupInfos(this._readRootState());
			this._onDidChangeSetups.fire(this._setups);
		}));
	}

	requestDownload(agent: string): void {
		this._dispatch(AGENT_SDK_SETUP_DOWNLOAD_REQUEST_KEY, agent);
	}

	signIn(agent: string): void {
		this._dispatch(AGENT_SDK_SETUP_SIGN_IN_REQUEST_KEY, agent);
	}

	cancelSignIn(agent: string): void {
		this._dispatch(AGENT_SDK_SETUP_CANCEL_SIGN_IN_REQUEST_KEY, agent);
	}

	private _readRootState() {
		const state = this._connection.rootState.value;
		return state instanceof Error ? undefined : state;
	}

	private _dispatch(key: string, agent: string): void {
		// A fresh nonce every time so pressing the same thing twice is two
		// requests; the agent clears the key as it consumes it.
		this._connection.dispatch(ROOT_STATE_URI, {
			type: ActionType.RootConfigChanged,
			config: { [key]: { agent, request: generateUuid() } },
		});
	}
}
