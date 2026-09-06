/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CLAUDE_AGENT_PROVIDER_ID } from '../../../../platform/agentHost/common/agent.js';
import { AgentHostClaudeAgentEnabledSettingId, IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { CLAUDE_ACCOUNT_SIGN_OUT_REQUEST_KEY, IClaudeAccountInfo, readClaudeAccountInfo } from '../../../../platform/agentHost/common/claudeAccount.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { ActionType } from '../../../../platform/agentHost/common/state/sessionActions.js';
import { ROOT_STATE_URI } from '../../../../platform/agentHost/common/state/sessionState.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IAgentSdkSetupPresentationSource } from '../../../../platform/agentHost/common/agentSdkSetup.js';
import { IAgentSdkSetupService } from './agentSdkSetupService.js';
import { IAgentHostModelProviderPresentation } from './agentHostModelProviderPresentation.js';

interface IClaudeAccountVisibilityConfiguration {
	getValue<T>(section: string): T | undefined;
}

export const IClaudeAccountService = createDecorator<IClaudeAccountService>('claudeAccountService');

/**
 * View of the native (first-party Anthropic) Claude identity, mirrored from the
 * AHP root state. Sign-in and download state live with
 * {@link IAgentSdkSetupService}; this service carries who is signed in (email,
 * organization, subscription) for the account chrome, plus the sign-out the
 * setup channel has no counterpart for.
 */
export interface IClaudeAccountService {
	readonly _serviceBrand: undefined;
	readonly account: IClaudeAccountInfo;
	readonly onDidChangeAccount: Event<IClaudeAccountInfo>;
	/**
	 * Ask the agent to run the Claude CLI's own logout. The credential is the
	 * CLI's, held in the system keychain, so this drops it for every tool that
	 * shares it — never a Fumie-local erasure.
	 */
	signOut(): void;
}

export function hasSignedInClaudeAccount(account: IClaudeAccountInfo, visible = true): boolean {
	return visible && account.status === 'signedIn';
}

export function shouldShowClaudeAccount(configurationService: IClaudeAccountVisibilityConfiguration, isSessionsWindow: boolean): boolean {
	return isSessionsWindow
		&& configurationService.getValue<boolean>(ChatAIDisabledSettingId) !== true
		&& configurationService.getValue<boolean>(AgentHostClaudeAgentEnabledSettingId) === true;
}

/** Present the native Claude account independently from proxy and BYOK models. */
export function createClaudeModelProviderPresentation(setupService: IAgentSdkSetupPresentationSource): IAgentHostModelProviderPresentation {
	const signInAction = (retry: boolean) => toAction({
		id: retry ? 'claude.retrySignInFromModels' : 'claude.signInFromModels',
		label: retry
			? localize('retryClaudeSignInFromModels', "Retry Claude sign-in")
			: localize('signInToClaudeFromModels', "Sign in to Claude"),
		class: ThemeIcon.asClassName(Codicon.account),
		run: () => setupService.signIn(CLAUDE_AGENT_PROVIDER_ID),
	});
	const downloadAction = toAction({
		id: 'claude.downloadAgentFromModels',
		label: localize('downloadClaudeAgentFromModels', "Download Claude Agent"),
		class: ThemeIcon.asClassName(Codicon.cloudDownload),
		run: () => setupService.requestDownload(CLAUDE_AGENT_PROVIDER_ID),
	});
	// The only way out of a sign-in that will not finish. Nothing the user does in
	// the browser — cancelling, closing the tab — is visible from here, so the
	// running flow is abandoned on request rather than inferred to have failed.
	const cancelSignInAction = toAction({
		id: 'claude.cancelSignInFromModels',
		label: localize('cancelClaudeSignInFromModels', "Cancel sign-in"),
		class: ThemeIcon.asClassName(Codicon.close),
		run: () => setupService.cancelSignIn(CLAUDE_AGENT_PROVIDER_ID),
	});

	return {
		onDidChange: Event.map(setupService.onDidChangeSetups, () => undefined),
		provideStatus: () => {
			const setup = setupService.setups.find(candidate => candidate.agent === CLAUDE_AGENT_PROVIDER_ID);
			if (!setup) {
				return undefined;
			}
			switch (setup.download) {
				case 'notDownloaded':
					return {
						message: localize('claudeModels.download', "Download Claude Agent to sign in and load native models"),
						severity: Severity.Warning,
						action: downloadAction,
					};
				case 'downloading':
					return { message: localize('claudeModels.downloading', "Downloading Claude Agent…"), severity: Severity.Info };
				case 'ready':
					switch (setup.accountStatus) {
						case 'signingIn':
							return {
								message: localize('claudeModels.signingIn', "Signing in to Claude… complete it in the browser, or sign in again to start over"),
								severity: Severity.Info,
								action: cancelSignInAction,
							};
						case 'error':
							return {
								message: localize('claudeModels.signInError', "Claude sign-in needs attention"),
								severity: Severity.Error,
								action: signInAction(true),
							};
						case 'signedIn':
							return undefined;
						case undefined:
							return undefined;
						case 'unknown':
						case 'signedOut':
							return {
								message: localize('claudeModels.signIn', "Sign in to Claude to load native models"),
								severity: Severity.Warning,
								action: signInAction(false),
							};
					}
			}
		},
	};
}

class ClaudeAccountService extends Disposable implements IClaudeAccountService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAccount = this._register(new Emitter<IClaudeAccountInfo>());
	readonly onDidChangeAccount = this._onDidChangeAccount.event;

	private _account: IClaudeAccountInfo;

	get account(): IClaudeAccountInfo {
		return this._account;
	}

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
	) {
		super();
		const initialState = this._agentHostService.rootState.value;
		this._account = readClaudeAccountInfo(initialState instanceof Error ? undefined : initialState);
		this._register(this._agentHostService.rootState.onDidChange(state => {
			this._account = readClaudeAccountInfo(state);
			this._onDidChangeAccount.fire(this._account);
		}));
	}

	signOut(): void {
		this._agentHostService.dispatch(ROOT_STATE_URI, {
			type: ActionType.RootConfigChanged,
			config: { [CLAUDE_ACCOUNT_SIGN_OUT_REQUEST_KEY]: generateUuid() },
		});
	}
}

registerSingleton(IClaudeAccountService, ClaudeAccountService, InstantiationType.Delayed);

// No registration on the `claude` agent vendor. That vendor exists to route the
// harness's models and is no longer listed in Manage Models, so a status card on
// it had nowhere left to render. The account this presentation describes belongs
// to the Claude Subscription provider, which builds it directly. Sign-in
// guidance outside Manage Models is unaffected: it comes from the SDK setup
// notification, not from here.
