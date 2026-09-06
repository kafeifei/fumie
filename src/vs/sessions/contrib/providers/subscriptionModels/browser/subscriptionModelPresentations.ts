/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Event } from '../../../../../base/common/event.js';
import Severity from '../../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IClaudeAccountInfo } from '../../../../../platform/agentHost/common/claudeAccount.js';
import { ICodexAccountInfo } from '../../../../../platform/agentHost/common/codexAccount.js';
import { IAgentHostModelProviderPresentation, IAgentHostModelProviderPresentationContext, IAgentHostModelProviderPresentationStatus } from '../../../../../workbench/services/agentHost/browser/agentHostModelProviderPresentation.js';
import { IClaudeAccountService, createClaudeModelProviderPresentation } from '../../../../../workbench/services/agentHost/browser/claudeAccountService.js';
import { ICodexAccountService, createCodexModelProviderPresentation } from '../../../../../workbench/services/agentHost/browser/codexAccountService.js';
import { IAgentSdkSetupService } from '../../../../../workbench/services/agentHost/browser/agentSdkSetupService.js';

/**
 * The agent's own presentation says nothing once the account is good, because on
 * the agent's row a working account is simply the absence of a problem. A
 * subscription row is about the account itself, so it says who is signed in and
 * offers the way out. Everything before that — download, sign-in, retry — is the
 * agent's presentation verbatim: those states and their actions are identical,
 * and duplicating them is how they drift apart.
 *
 * The signed-in status marks itself `explicitActionOnly`: the states it replaces
 * offer a way *into* a working account and are worth triggering from anywhere on
 * the row, but signing out takes away something the user has, so it must be
 * asked for on its own control.
 */
function withSignedInAccount(
	base: IAgentHostModelProviderPresentation,
	onDidChangeAccount: Event<unknown>,
	signedInStatus: () => IAgentHostModelProviderPresentationStatus | undefined,
): IAgentHostModelProviderPresentation {
	return {
		onDidChange: Event.any(base.onDidChange, Event.map(onDidChangeAccount, () => undefined)),
		provideStatus: (context: IAgentHostModelProviderPresentationContext) => base.provideStatus(context) ?? signedInStatus(),
	};
}

function signOutAction(id: string, run: () => void) {
	return toAction({
		id,
		label: localize('subscriptionModels.signOut', "Sign out"),
		class: ThemeIcon.asClassName(Codicon.signOut),
		run,
	});
}

/**
 * Attaches who is signed in to a base "Signed in to X" line: the identifying
 * label first (the whole point — a user with several accounts has to tell them
 * apart), then the plan in parentheses when it is not already the label.
 *
 * The email is shown here and nowhere else — never logged, never sent to
 * telemetry — because the row is the one place it is the user's own screen.
 *
 * The composed line is one row tall like every other status; when it overruns
 * the column it clips and the row's title carries the whole of it, so a long
 * address stays legible on hover rather than being dropped.
 */
function signedInMessage(base: string, identity: string | undefined, qualifier: string | undefined): string {
	if (!identity) {
		return base;
	}
	return qualifier && qualifier !== identity
		? localize('subscriptionModels.signedIn.identityWithPlan', "{0} · {1} ({2})", base, identity, qualifier)
		: localize('subscriptionModels.signedIn.identity', "{0} · {1}", base, identity);
}

/**
 * The Claude signed-in line. Email identifies the account; the organization and
 * then the subscription stand in when the SDK reports no email, and the
 * subscription is appended as the plan whenever it is not already the label.
 */
export function claudeSignedInMessage(account: IClaudeAccountInfo): string {
	const base = localize('subscriptionModels.claude.signedInPlain', "Signed in to Claude");
	const identity = account.email ?? account.organization ?? account.subscriptionType;
	return signedInMessage(base, identity, account.subscriptionType);
}

/**
 * The Codex signed-in line. Email identifies the ChatGPT account; the plan
 * stands in when there is no email and is otherwise appended.
 */
export function codexSignedInMessage(account: ICodexAccountInfo): string {
	const base = localize('subscriptionModels.codex.signedInPlain', "Signed in to ChatGPT");
	const identity = account.email ?? account.planType;
	return signedInMessage(base, identity, account.planType);
}

export function createClaudeSubscriptionPresentation(setupService: IAgentSdkSetupService, accountService: IClaudeAccountService): IAgentHostModelProviderPresentation {
	return withSignedInAccount(
		createClaudeModelProviderPresentation(setupService),
		accountService.onDidChangeAccount,
		() => {
			const account = accountService.account;
			if (account.status !== 'signedIn') {
				return undefined;
			}
			return {
				message: claudeSignedInMessage(account),
				severity: Severity.Info,
				action: signOutAction('claudeSubscription.signOut', () => accountService.signOut()),
				explicitActionOnly: true,
			};
		},
	);
}

export function createCodexSubscriptionPresentation(accountService: ICodexAccountService): IAgentHostModelProviderPresentation {
	return withSignedInAccount(
		createCodexModelProviderPresentation(accountService),
		accountService.onDidChangeAccount,
		() => {
			const account = accountService.account;
			if (account.status !== 'signedIn') {
				return undefined;
			}
			return {
				message: codexSignedInMessage(account),
				severity: Severity.Info,
				action: signOutAction('codexSubscription.signOut', () => accountService.signOut()),
				explicitActionOnly: true,
			};
		},
	);
}
