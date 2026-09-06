/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { RemoteAgentHostsEnabledSettingId } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import {
	isTunnelHosted,
	PROTOCOL_VERSION_TAG_PREFIX,
	TUNNEL_LAUNCHER_LABEL,
	type ITunnelHostInfo,
	type ITunnelInfo,
	type ITunnelUserLimit,
} from '../../../../platform/agentHost/common/tunnelAgentHost.js';
import { appendCollapsibleSection, appendLinkButton, appendSettingRow, appendUnavailableRow } from './agentSettingsForm.js';

const $ = DOM.$;

/**
 * The auth providers a dev tunnel can be created or listed with, in the order
 * the tunnel services themselves try them (see `_getToken` in
 * `workbench/contrib/chat/electron-browser/tunnelHostService.ts`). Only the
 * providers `product.tunnelApplicationConfig` gives scopes for are usable, so
 * on this distribution the list collapses to GitHub.
 */
export const TUNNEL_AUTH_PROVIDERS = ['github', 'microsoft'] as const;
export type TunnelAuthProvider = typeof TUNNEL_AUTH_PROVIDERS[number];

/**
 * Which account the dev tunnel services would authenticate as. Every state is
 * rendered: a page that only draws a row when it has an account is how a user
 * ends up staring at a section that says nothing at all.
 */
export type DevTunnelAccount =
	| { readonly kind: 'unknown' }
	| { readonly kind: 'loading' }
	/** No provider in this build has tunnel scopes, so nothing here can sign in. */
	| { readonly kind: 'unconfigured' }
	/** Scopes exist but no auth provider is declared — a browser client, which has no auth extensions. */
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'signedOut'; readonly providerId: TunnelAuthProvider; readonly scopes: readonly string[] }
	| { readonly kind: 'signedIn'; readonly providerId: TunnelAuthProvider; readonly sessionId: string; readonly label: string }
	| { readonly kind: 'failed'; readonly message: string };

/** The account's dev tunnels, as far as this page has been able to ask for them. */
export type DevTunnelList =
	| { readonly kind: 'unknown' }
	| { readonly kind: 'loading' }
	| { readonly kind: 'loaded'; readonly tunnels: readonly ITunnelInfo[] }
	| { readonly kind: 'failed'; readonly message: string };

/**
 * The account's Dev Tunnels allowance. Kept apart from {@link DevTunnelList}
 * because the two come from different calls and one can answer while the other
 * does not — and a quota figure is only ever shown when it is a real one.
 */
export type DevTunnelLimits =
	| { readonly kind: 'unknown' }
	| { readonly kind: 'loading' }
	| { readonly kind: 'loaded'; readonly limits: readonly ITunnelUserLimit[] }
	/** This client cannot ask at all: an embedder proxy has no limits call. */
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'failed'; readonly message: string };

/** The allowances worth a row: one the service put a number on. */
export function selectReportableLimits(limits: readonly ITunnelUserLimit[]): ITunnelUserLimit[] {
	return limits.filter(limit => typeof limit.limit === 'number');
}

/**
 * The tunnels a bulk clean-up may delete: offline ones, never the tunnel this
 * machine is hosting right now. Exported so the choice can be tested without a
 * rendered page — deleting the wrong tunnel here is not an undoable mistake.
 */
export function selectOfflineTunnels(
	tunnels: readonly ITunnelInfo[],
	sharingInfo: ITunnelHostInfo | undefined,
): ITunnelInfo[] {
	return tunnels.filter(tunnel => tunnel.hostConnectionCount === 0 && !isTunnelHosted(sharingInfo, tunnel));
}

/**
 * What a tunnel is for, as far as its labels admit.
 *
 * The list is no longer confined to tunnels this app can connect to, so a row
 * may well be something the user has never heard of. Naming the one label this
 * product understands, and otherwise repeating the labels verbatim, is what
 * keeps an unfamiliar tunnel legible instead of mysterious.
 */
export function tunnelPurpose(tunnel: ITunnelInfo): string {
	if (tunnel.tags.includes(TUNNEL_LAUNCHER_LABEL)) {
		return localize('agentSettings.remoteHosts.tunnelAgentHost', "Agent host");
	}
	// `protocolvN` and `_`-prefixed labels are protocol bookkeeping, not
	// anything the user chose; TunnelTags already reads them that way.
	const labels = tunnel.tags.filter(tag => !tag.startsWith('_') && !tag.startsWith(PROTOCOL_VERSION_TAG_PREFIX));
	return labels.length > 0
		? localize('agentSettings.remoteHosts.tunnelLabels', "Labelled {0}", labels.join(', '))
		: localize('agentSettings.remoteHosts.tunnelNoLabels', "No labels");
}

/** The identifying line under a tunnel's name: enough to tell two similar tunnels apart. */
export function tunnelDetail(tunnel: ITunnelInfo, hosted: boolean): string {
	return [
		tunnel.tunnelId,
		tunnel.clusterId,
		tunnel.hostConnectionCount > 0
			? localize('agentSettings.remoteHosts.tunnelOnline', "Online")
			: localize('agentSettings.remoteHosts.tunnelOffline', "Offline"),
		tunnelPurpose(tunnel),
		hosted ? localize('agentSettings.remoteHosts.tunnelThisMachine', "Hosted by this machine") : undefined,
	].filter((part): part is string => !!part).join(' · ');
}

export function providerLabel(providerId: TunnelAuthProvider): string {
	return providerId === 'github'
		? localize('agentSettings.remoteHosts.providerGitHub', "GitHub")
		: localize('agentSettings.remoteHosts.providerMicrosoft', "Microsoft");
}

/**
 * What the Advanced section needs from the page around it: the three lookup
 * state machines, and the operations that own a confirmation dialog.
 */
export interface IRemoteHostsAdvancedContext {
	readonly store: DisposableStore;
	readonly account: DevTunnelAccount;
	readonly tunnels: DevTunnelList;
	readonly limits: DevTunnelLimits;
	/** `chat.remoteAgentHostsEnabled`: turned off, the services list nothing rather than fail. */
	readonly remoteAgentHostsEnabled: boolean;
	readonly sharingInfo: ITunnelHostInfo | undefined;
	loadAccount(): void;
	loadTunnels(): void;
	loadLimits(): void;
	signIn(providerId: TunnelAuthProvider, scopes: readonly string[]): void;
	signOut(providerId: TunnelAuthProvider, sessionId: string, label: string): void;
	deleteTunnels(tunnels: readonly ITunnelInfo[]): void;
}

/**
 * The dev tunnels registered to the signed-in account.
 *
 * Hosting an address for another device creates a dev tunnel, and Dev Tunnels
 * caps how many tunnels one account may keep in a cluster. Once that cap is
 * reached the next tunnel simply fails to be created and the remote address
 * never appears, with no way inside the app to see what is taking up the
 * allowance. This section is that way — folded away, because it is a
 * diagnostic, and kept whole, because nothing else can answer the question.
 */
export function renderAdvanced(container: HTMLElement, ctx: IRemoteHostsAdvancedContext): HTMLElement {
	const section = appendCollapsibleSection(
		container,
		localize('agentSettings.remoteHosts.advancedSection', "Advanced: Dev Tunnel account"),
		{
			description: localize(
				'agentSettings.remoteHosts.tunnelsSectionDetail',
				"Dev Tunnels limits how many tunnels one account may keep in a cluster. When that limit is reached, hosting an address for another device fails. Every tunnel on the account is listed, whatever created it, because the limit counts them all."),
		},
	);

	renderAccountRow(section, ctx);

	if (ctx.account.kind !== 'signedIn') {
		return section;
	}

	// `listTunnels` returns an empty array — not an error — when remote agent
	// hosts are turned off, so without this the section would claim the account
	// has no tunnels at all.
	if (!ctx.remoteAgentHostsEnabled) {
		appendUnavailableRow(
			section,
			localize('agentSettings.remoteHosts.tunnelsDisabled', "Dev tunnels are turned off"),
			localize(
				'agentSettings.remoteHosts.tunnelsDisabledDetail',
				"'{0}' is off, so this app will not list or connect to dev tunnels. Turn it on to manage them here.",
				RemoteAgentHostsEnabledSettingId),
		);
		return section;
	}

	renderTunnelRows(section, ctx);
	return section;
}

function renderAccountRow(section: HTMLElement, ctx: IRemoteHostsAdvancedContext): void {
	const account = ctx.account;
	switch (account.kind) {
		case 'unknown':
		case 'loading':
			appendSettingRow(
				section,
				localize('agentSettings.remoteHosts.account', "Account"),
				localize('agentSettings.remoteHosts.accountLoading', "Checking which account this app is signed in as…"),
				$('.agent-settings-inline-actions'),
			);
			if (account.kind === 'unknown') {
				ctx.loadAccount();
			}
			return;
		case 'unconfigured':
			appendUnavailableRow(
				section,
				localize('agentSettings.remoteHosts.accountUnconfigured', "No sign-in is configured for dev tunnels"),
				localize('agentSettings.remoteHosts.accountUnconfiguredDetail', "This build ships no tunnel authentication provider, so dev tunnels cannot be listed or removed from here."),
			);
			return;
		case 'unsupported':
			appendUnavailableRow(
				section,
				localize('agentSettings.remoteHosts.accountUnsupported', "Signing in is not available in this client"),
				localize('agentSettings.remoteHosts.accountUnsupportedDetail', "No authentication provider is available here — a browser client has none — so the account's dev tunnels cannot be listed. Manage them from the desktop app."),
			);
			return;
		case 'failed':
			appendRetryRow(
				section,
				ctx.store,
				localize('agentSettings.remoteHosts.accountFailed', "Could not tell which account is signed in"),
				account.message,
				() => ctx.loadAccount(),
			);
			return;
		case 'signedOut': {
			const actions = $('.agent-settings-inline-actions');
			appendLinkButton(
				ctx.store,
				actions,
				localize('agentSettings.remoteHosts.signIn', "Sign in"),
				() => ctx.signIn(account.providerId, account.scopes),
			);
			appendSettingRow(
				section,
				localize('agentSettings.remoteHosts.accountSignedOut', "Not signed in"),
				localize(
					'agentSettings.remoteHosts.accountSignedOutDetail',
					"Sign in with {0} to see and remove the dev tunnels on your account. This is the same sign-in hosting an address uses.",
					providerLabel(account.providerId)),
				actions,
			);
			return;
		}
		case 'signedIn': {
			const actions = $('.agent-settings-inline-actions');
			appendLinkButton(
				ctx.store,
				actions,
				localize('agentSettings.remoteHosts.signOut', "Sign out"),
				() => ctx.signOut(account.providerId, account.sessionId, account.label),
			);
			appendSettingRow(
				section,
				account.label,
				localize(
					'agentSettings.remoteHosts.accountSignedInDetail',
					"Signed in with {0}. The dev tunnels below belong to this account.",
					providerLabel(account.providerId)),
				actions,
			);
			return;
		}
	}
}

/**
 * How much of the account's tunnel allowance is gone.
 *
 * The number comes from Dev Tunnels itself and is drawn only when it does:
 * counting the rows above would give a figure that is wrong the moment another
 * cluster or another client holds a tunnel, and this page exists because a
 * made-up quota is worse than none.
 */
function renderTunnelAllowance(section: HTMLElement, ctx: IRemoteHostsAdvancedContext): void {
	const state = ctx.limits;
	switch (state.kind) {
		case 'unknown':
		case 'loading':
			appendSettingRow(
				section,
				localize('agentSettings.remoteHosts.allowance', "Tunnel allowance"),
				localize('agentSettings.remoteHosts.allowanceLoading', "Asking Dev Tunnels how much of the allowance is in use…"),
				$('.agent-settings-inline-actions'),
			);
			if (state.kind === 'unknown') {
				ctx.loadLimits();
			}
			return;
		case 'unsupported':
			appendUnavailableRow(
				section,
				localize('agentSettings.remoteHosts.allowanceUnsupported', "The tunnel allowance is not available here"),
				localize('agentSettings.remoteHosts.allowanceUnsupportedDetail', "This client reaches dev tunnels through its host, which reports no limits. The tunnels below are all it can show."),
			);
			return;
		case 'failed':
			appendRetryRow(
				section,
				ctx.store,
				localize('agentSettings.remoteHosts.allowanceFailed', "Could not read the tunnel allowance"),
				state.message,
				() => ctx.loadLimits(),
			);
			return;
		case 'loaded': {
			const reportable = selectReportableLimits(state.limits);
			if (reportable.length === 0) {
				appendUnavailableRow(
					section,
					localize('agentSettings.remoteHosts.allowanceNone', "Dev Tunnels reported no limits for this account"),
					localize('agentSettings.remoteHosts.allowanceNoneDetail', "Nothing came back with a number on it, so there is no allowance to show."),
				);
				return;
			}
			for (const limit of reportable) {
				const row = appendSettingRow(
					section,
					localize('agentSettings.remoteHosts.allowance', "Tunnel allowance"),
					localize('agentSettings.remoteHosts.allowanceDetail', "{0} of {1} tunnels in use.", limit.current, limit.limit!),
					$('.agent-settings-inline-actions'),
				);
				if (limit.name) {
					// The service's own name for the limit is what a support
					// thread or its documentation calls it, and nothing else
					// tells the user which allowance this row is. It belongs
					// within reach, not in the sentence.
					row.title = localize('agentSettings.remoteHosts.allowanceName', "Dev Tunnels calls this limit '{0}'.", limit.name);
				}
			}
			return;
		}
	}
}

function renderTunnelRows(section: HTMLElement, ctx: IRemoteHostsAdvancedContext): void {
	renderTunnelAllowance(section, ctx);

	const state = ctx.tunnels;
	if (state.kind === 'unknown' || state.kind === 'loading') {
		appendSettingRow(
			section,
			localize('agentSettings.remoteHosts.tunnelsLoading', "Dev tunnels"),
			localize('agentSettings.remoteHosts.tunnelsLoadingDetail', "Asking Dev Tunnels for this account's tunnels…"),
			$('.agent-settings-inline-actions'),
		);
		if (state.kind === 'unknown') {
			ctx.loadTunnels();
		}
		return;
	}

	if (state.kind === 'failed') {
		appendRetryRow(
			section,
			ctx.store,
			localize('agentSettings.remoteHosts.tunnelsFailed', "Could not list your dev tunnels"),
			state.message,
			() => ctx.loadTunnels(),
		);
		return;
	}

	const offline = selectOfflineTunnels(state.tunnels, ctx.sharingInfo);

	const summaryActions = $('.agent-settings-inline-actions');
	appendLinkButton(
		ctx.store,
		summaryActions,
		localize('agentSettings.remoteHosts.tunnelsRefresh', "Refresh"),
		() => ctx.loadTunnels(),
	);
	if (offline.length > 0) {
		appendLinkButton(
			ctx.store,
			summaryActions,
			localize('agentSettings.remoteHosts.tunnelsRemoveOffline', "Remove offline"),
			() => ctx.deleteTunnels(offline),
		);
	}
	appendSettingRow(
		section,
		state.tunnels.length === 1
			? localize('agentSettings.remoteHosts.tunnelsCountOne', "1 dev tunnel listed")
			: localize('agentSettings.remoteHosts.tunnelsCount', "{0} dev tunnels listed", state.tunnels.length),
		state.tunnels.length === 0
			// An empty list used to be what a failed lookup looked like too, so
			// this had to hedge. The services now throw instead, which lands on
			// the failure row above — an empty list here really is an empty
			// account.
			? localize('agentSettings.remoteHosts.tunnelsNoneDetail', "Dev Tunnels holds no tunnels for this account, so nothing here is using the allowance up.")
			: localize('agentSettings.remoteHosts.tunnelsCountDetail', "Counted from what Dev Tunnels returned for this account, including tunnels this app cannot connect to."),
		summaryActions,
	);

	for (const tunnel of state.tunnels) {
		const hosted = isTunnelHosted(ctx.sharingInfo, tunnel);
		const actions = $('.agent-settings-inline-actions');
		appendLinkButton(
			ctx.store,
			actions,
			localize('agentSettings.remoteHosts.tunnelDelete', "Delete"),
			() => ctx.deleteTunnels([tunnel]),
		);
		appendSettingRow(section, tunnel.name, tunnelDetail(tunnel, hosted), actions);
	}
}

/** A failure the user can act on: what went wrong, plus the button to try it again. */
function appendRetryRow(section: HTMLElement, store: DisposableStore, label: string, message: string, retry: () => void): void {
	const actions = $('.agent-settings-inline-actions');
	appendLinkButton(store, actions, localize('agentSettings.remoteHosts.retry', "Try again"), retry);
	const row = appendSettingRow(section, label, message, actions);
	row.classList.add('agent-settings-row-unavailable');
}
