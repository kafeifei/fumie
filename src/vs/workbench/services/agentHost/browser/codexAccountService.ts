/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Action, IAction, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import Severity from '../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CODEX_ACCOUNT_SIGN_IN_REQUEST_KEY, CODEX_ACCOUNT_SIGN_OUT_REQUEST_KEY, ICodexAccountInfo, readCodexAccountInfo } from '../../../../platform/agentHost/common/codexAccount.js';
import { CODEX_AGENT_PROVIDER_ID } from '../../../../platform/agentHost/common/agent.js';
import { AgentHostCodexAgentEnabledSettingId, CodexPreferAgentHostEditorSettingId, IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { ActionType } from '../../../../platform/agentHost/common/state/sessionActions.js';
import { ROOT_STATE_URI } from '../../../../platform/agentHost/common/state/sessionState.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IAgentHostModelProviderPresentation } from './agentHostModelProviderPresentation.js';

interface ICodexAccountVisibilityConfiguration {
	getValue<T>(section: string): T | undefined;
}

export const ICodexAccountService = createDecorator<ICodexAccountService>('codexAccountService');

export interface ICodexAccountService {
	readonly _serviceBrand: undefined;
	/**
	 * The agent whose account this service manages, so callers that dispatch by
	 * agent id — the SDK setup banner's Sign In button — can check they are
	 * talking to the right service without carrying a literal `'codex'`.
	 */
	readonly agent: string;
	readonly account: ICodexAccountInfo;
	readonly onDidChangeAccount: Event<ICodexAccountInfo>;
	signIn(): void;
	signOut(): void;
}

export function hasSignedInCodexChatGPTAccount(account: ICodexAccountInfo, visible = true): boolean {
	return visible && account.status === 'signedIn';
}

export function shouldShowCodexAccount(configurationService: ICodexAccountVisibilityConfiguration, isSessionsWindow: boolean): boolean {
	return configurationService.getValue<boolean>(ChatAIDisabledSettingId) !== true
		&& configurationService.getValue<boolean>(AgentHostCodexAgentEnabledSettingId) === true
		&& (isSessionsWindow || configurationService.getValue<boolean>(CodexPreferAgentHostEditorSettingId) === true);
}

export function createCodexAccountMenuActions(service: ICodexAccountService, visible = true): IAction[] {
	if (!visible) {
		return [];
	}
	const account = service.account;
	if (account.status === 'signedIn') {
		const signOut = toAction({
			id: 'codex.signOutOfChatGPT',
			label: localize('signOutOfChatGPT', "Sign Out"),
			run: () => service.signOut(),
		});
		const accountLabel = account.email
			? localize('chatGPTAccountWithProvider', "{0} (ChatGPT)", account.email)
			: localize('chatGPTAccount', "ChatGPT");
		return [new SubmenuAction('codex.chatgptAccount', accountLabel, [signOut])];
	}
	if (account.status === 'downloading') {
		return [new Action('codex.downloadingAgent', localize('downloadingCodexAgent', "Downloading Codex agent…"), undefined, false)];
	}
	if (account.status === 'unknown' || account.status === 'signedOut' || account.status === 'error') {
		return [new Action('codex.signInToChatGPT', localize('signInToChatGPT', "Sign in to ChatGPT"), undefined, true, () => service.signIn())];
	}
	return [];
}

export function createCodexModelProviderPresentation(service: ICodexAccountService): IAgentHostModelProviderPresentation {
	const signInAction = (retry: boolean): IAction => toAction({
		id: retry ? 'codex.retryChatGPTSignInFromModels' : 'codex.signInToChatGPTFromModels',
		label: retry
			? localize('retryChatGPTSignInFromModels', "Retry ChatGPT sign-in")
			: localize('signInToChatGPTFromModels', "Sign in to ChatGPT"),
		class: ThemeIcon.asClassName(Codicon.account),
		run: () => service.signIn(),
	});

	return {
		onDidChange: Event.map(service.onDidChangeAccount, () => undefined),
		provideStatus: () => {
			switch (service.account.status) {
				case 'unknown':
				case 'signedOut':
					return {
						message: localize('codexModels.signIn', "Sign in to ChatGPT to load Codex models"),
						severity: Severity.Warning,
						action: signInAction(false),
					};
				case 'error':
					return {
						message: localize('codexModels.signInError', "ChatGPT sign-in needs attention"),
						severity: Severity.Error,
						action: signInAction(true),
					};
				case 'downloading':
					return { message: localize('codexModels.downloading', "Downloading Codex agent…"), severity: Severity.Info };
				case 'signedIn':
				case 'unavailable':
					return undefined;
			}
		},
	};
}

export function openCodexAuthUrl(openerService: Pick<IOpenerService, 'open'>, authUrl: string): Promise<boolean> {
	return openerService.open(authUrl, { openExternal: true, skipValidation: true });
}

class CodexAccountService extends Disposable implements ICodexAccountService {
	declare readonly _serviceBrand: undefined;

	readonly agent = CODEX_AGENT_PROVIDER_ID;

	private readonly _onDidChangeAccount = this._register(new Emitter<ICodexAccountInfo>());
	readonly onDidChangeAccount = this._onDidChangeAccount.event;

	private readonly _pendingSignInRequests = new Set<string>();
	private _account: ICodexAccountInfo;

	get account(): ICodexAccountInfo {
		return this._account;
	}

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super();
		const initialState = this._agentHostService.rootState.value;
		this._account = readCodexAccountInfo(initialState instanceof Error ? undefined : initialState);
		this._register(this._agentHostService.rootState.onDidChange(state => this._updateAccount(readCodexAccountInfo(state))));
	}

	signIn(): void {
		const request = generateUuid();
		this._pendingSignInRequests.add(request);
		this._agentHostService.dispatch(ROOT_STATE_URI, {
			type: ActionType.RootConfigChanged,
			config: { [CODEX_ACCOUNT_SIGN_IN_REQUEST_KEY]: request },
		});
	}

	signOut(): void {
		this._agentHostService.dispatch(ROOT_STATE_URI, {
			type: ActionType.RootConfigChanged,
			config: { [CODEX_ACCOUNT_SIGN_OUT_REQUEST_KEY]: generateUuid() },
		});
	}

	private _updateAccount(account: ICodexAccountInfo): void {
		this._account = account;
		this._onDidChangeAccount.fire(account);
		if (account.authUrlNonce && this._pendingSignInRequests.delete(account.authUrlNonce) && account.authUrl) {
			void openCodexAuthUrl(this._openerService, account.authUrl);
		}
	}
}

registerSingleton(ICodexAccountService, CodexAccountService, InstantiationType.Delayed);

// No registration on the `codex` agent vendor — see the note in
// `claudeAccountService`. The Codex Subscription provider builds this
// presentation for the row the account actually belongs to.
