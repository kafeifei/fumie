/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { IMobileClientInfo, ITunnelHostInfo } from '../../../../platform/agentHost/common/tunnelAgentHost.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { ITunnelHostService } from '../../../../workbench/contrib/chat/common/tunnelHost.js';
import {
	appendCard,
	appendIcon,
	appendLinkButton,
	appendOverflowMenu,
	appendSection,
	renderCheckbox,
} from './agentSettingsForm.js';
import { encodeQrCode, renderQrCode } from './qrCode.js';

const $ = DOM.$;

/**
 * The one address this card leads with — the one another device can open —
 * and, when there is none, why not.
 */
export type ThisMachineLink =
	/** Sharing has started but nothing has reported an address yet. */
	| { readonly kind: 'waiting' }
	| { readonly kind: 'ready'; readonly url: string }
	/** The dev tunnel is still being created; an address is still coming. */
	| { readonly kind: 'pending' }
	| { readonly kind: 'failed'; readonly reason: string };

/**
 * Which address the card leads with.
 *
 * The remote address is the one worth having — a link only this machine can
 * open is not what "let another device in" means — so the local one is never
 * promoted into its place. When the remote address is missing the row says why
 * instead of disappearing: a card that quietly shows one address teaches the
 * user this build only ever had one.
 */
export function selectPrimaryLink(info: ITunnelHostInfo | undefined): ThisMachineLink {
	if (!info || (!info.mobileUrl && !info.mobileLocalUrl && !info.mobileUrlUnavailableReason)) {
		return { kind: 'waiting' };
	}
	if (info.mobileUrl) {
		return { kind: 'ready', url: info.mobileUrl };
	}
	return info.mobileUrlUnavailableReason
		? { kind: 'failed', reason: info.mobileUrlUnavailableReason }
		: { kind: 'pending' };
}

/** The line under the toggle: what sharing is doing right now. */
export function sharingStatusLine(sharing: boolean, connecting: boolean, info: ITunnelHostInfo | undefined): string {
	if (connecting) {
		return localize('agentSettings.remoteHosts.allowConnecting', "Starting…");
	}
	if (!sharing) {
		return localize('agentSettings.remoteHosts.allowOff', "Off. No other device can reach this machine.");
	}
	return info?.tunnelName
		? localize('agentSettings.remoteHosts.allowOnNamed', "Sharing as '{0}'.", info.tunnelName)
		: localize('agentSettings.remoteHosts.allowOn', "On.");
}

/** One row of the connected-devices list, decided without touching the DOM. */
export interface IConnectedDeviceRow {
	readonly id: string;
	readonly label: string;
	readonly detail: string;
}

/**
 * Who is on this machine right now, newest first — after a scan the device
 * being looked for is the one that just arrived.
 *
 * How a device got in belongs on the row: a browser on this machine and a
 * phone on the far side of the internet are not the same thing to be told
 * about, and only the second is a reason to press Disconnect.
 */
export function connectedDeviceRows(clients: readonly IMobileClientInfo[]): readonly IConnectedDeviceRow[] {
	return [...clients]
		// Two tabs opened together really do share a millisecond, and a list
		// that reshuffles itself under the pointer is a list you misclick.
		.sort((a, b) => b.connectedAt - a.connectedAt || compareStrings(a.id, b.id))
		.map(client => ({
			id: client.id,
			label: client.label,
			detail: [
				client.transport === 'tunnel'
					? localize('agentSettings.remoteHosts.clientTunnel', "Through the link")
					: localize('agentSettings.remoteHosts.clientLocal', "On this machine"),
				localize('agentSettings.remoteHosts.clientConnected', "connected {0}", fromNow(client.connectedAt, true)),
			].join(' · '),
		}));
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * What the connected-devices list needs: the devices themselves, and the
 * dialog that has to be answered before one of them is cut off.
 *
 * Supplied together or not at all. A client that cannot host anything has
 * nobody to list, and drawing an empty list there would claim otherwise.
 */
export interface IConnectedClientsContext {
	readonly tunnelHostService: ITunnelHostService;
	readonly dialogService: IDialogService;
}

export interface IRemoteHostsThisMachineContext {
	readonly store: DisposableStore;
	readonly sharing: boolean;
	readonly connecting: boolean;
	readonly sharingInfo: ITunnelHostInfo | undefined;
	readonly contextMenuService: IContextMenuService;
	/** Left out, the card draws no list; see {@link IConnectedClientsContext}. */
	readonly clients?: IConnectedClientsContext;
	setSharing(enabled: boolean): void;
	copy(text: string): void;
	open(url: string): void;
	/** Owns the confirmation dialog; see `AgentSettingsRemoteHosts`. */
	resetAccessLink(): void;
}

/**
 * Letting other devices in: one toggle, one address, and the control that
 * takes the address back.
 *
 * Hosting a dev tunnel for this machine is what lets a phone — or any other
 * client — reach these sessions at all, so it leads the page rather than
 * sitting behind the account diagnostics it happens to depend on.
 */
export function renderThisMachine(container: HTMLElement, ctx: IRemoteHostsThisMachineContext): HTMLElement {
	const section = appendSection(container, localize('agentSettings.remoteHosts.thisMachineSection', "This Machine"));
	const card = appendCard(section, 'agent-settings-this-machine-card');

	const header = DOM.append(card, $('.agent-settings-card-header'));
	appendIcon(header, Codicon.deviceDesktop, 'agent-settings-card-icon');

	const heading = DOM.append(header, $('.agent-settings-card-heading'));
	DOM.append(heading, $('.agent-settings-card-title')).textContent =
		localize('agentSettings.remoteHosts.allow', "Allow other devices to connect");
	DOM.append(heading, $('.agent-settings-card-subline')).textContent =
		sharingStatusLine(ctx.sharing, ctx.connecting, ctx.sharingInfo);

	const actions = DOM.append(header, $('.agent-settings-card-actions'));
	actions.appendChild(renderCheckbox(
		ctx.store,
		ctx.sharing,
		localize('agentSettings.remoteHosts.allow', "Allow other devices to connect"),
		checked => ctx.setSharing(checked),
	));
	// The address is the same one every time, which is what makes it worth
	// keeping on a phone — and what makes taking it back something the user has
	// to be able to do. It stays reachable whether or not sharing is on right
	// now: a link that leaked is still worth killing before the next time.
	appendOverflowMenu(
		ctx.store,
		actions,
		ctx.contextMenuService,
		localize('agentSettings.remoteHosts.thisMachineMore', "More actions for this machine"),
		() => thisMachineMenuActions(ctx),
	);

	if (!ctx.sharing) {
		return section;
	}

	const body = DOM.append(card, $('.agent-settings-card-body'));
	renderPrimaryLink(body, ctx);

	if (ctx.sharingInfo?.mobileLocalUrl) {
		renderLocalLink(body, ctx, ctx.sharingInfo.mobileLocalUrl);
	}

	if (ctx.clients) {
		renderConnectedDevices(body, ctx, ctx.clients);
	}

	return section;
}

function thisMachineMenuActions(ctx: IRemoteHostsThisMachineContext): IAction[] {
	return [
		new Action(
			'agentSettings.remoteHosts.resetPairing',
			localize('agentSettings.remoteHosts.resetPairing', "Reset access link"),
			undefined,
			true,
			async () => ctx.resetAccessLink(),
		),
	];
}

/**
 * The address, as the thing a phone can act on rather than a string to retype.
 *
 * The code is generated here — see `qrCode.ts`: the address is a capability,
 * so it must not be handed to an image service to draw. When it cannot be
 * encoded the row falls back to the address in full; a card that shows neither
 * is worse than an ugly one.
 */
function renderPrimaryLink(body: HTMLElement, ctx: IRemoteHostsThisMachineContext): void {
	const link = selectPrimaryLink(ctx.sharingInfo);
	const row = DOM.append(body, $('.agent-settings-link-row'));

	if (link.kind !== 'ready') {
		row.classList.add('agent-settings-row-unavailable');
		const labels = DOM.append(row, $('.agent-settings-link-labels'));
		DOM.append(labels, $('.agent-settings-link-title')).textContent =
			localize('agentSettings.remoteHosts.publicTitle', "Open on another device");
		DOM.append(labels, $('.agent-settings-link-detail')).textContent = unavailableLinkDetail(link, ctx.sharingInfo);
		return;
	}

	const code = encodeQrCode(link.url);
	if (code) {
		row.classList.add('agent-settings-qr-row');
		const figure = DOM.append(row, $('.agent-settings-qr'));
		renderQrCode(figure, code, {
			ariaLabel: localize('agentSettings.remoteHosts.qrLabel', "QR code for the address of this machine"),
			// The card no longer spells the address out; a hover still reads it.
			title: link.url,
		});
	}

	const labels = DOM.append(row, $('.agent-settings-link-labels'));
	DOM.append(labels, $('.agent-settings-link-title')).textContent = code
		? localize('agentSettings.remoteHosts.qrTitle', "Scan with your phone, or copy the link")
		: localize('agentSettings.remoteHosts.publicTitle', "Open on another device");
	if (!code) {
		DOM.append(labels, $('.agent-settings-link-url')).textContent = link.url;
	}

	const controls = DOM.append(labels, $('.agent-settings-inline-actions'));
	appendLinkButton(ctx.store, controls, localize('agentSettings.remoteHosts.copyLink', "Copy Link"), () => ctx.copy(link.url));
	appendLinkButton(ctx.store, controls, localize('agentSettings.remoteHosts.open', "Open"), () => ctx.open(link.url));

	DOM.append(labels, $('.agent-settings-link-detail')).textContent =
		localize('agentSettings.remoteHosts.publicDetail', "The link is private: that device signs in to GitHub first.");
}

function unavailableLinkDetail(link: ThisMachineLink, info: ITunnelHostInfo | undefined): string {
	const tunnelName = info?.tunnelName ?? '';
	switch (link.kind) {
		case 'waiting':
		// A ready link never reaches this function; the waiting line is the
		// least wrong thing to say if it ever does.
		case 'ready':
			return localize('agentSettings.remoteHosts.noUrlYet', "Waiting for the address…");
		case 'pending':
			return localize('agentSettings.remoteHosts.publicPendingDetail', "Still setting up the '{0}' dev tunnel.", tunnelName);
		case 'failed':
			return localize('agentSettings.remoteHosts.publicFailedDetail', "No address reaches this machine from elsewhere yet: {0}", link.reason);
	}
}

/**
 * The loopback address, kept as a footnote. It opens straight away and nothing
 * leaves the machine, which is worth saying — but it is not the address this
 * card is for, so it does not get a row of its own beside the one that is.
 */
function renderLocalLink(body: HTMLElement, ctx: IRemoteHostsThisMachineContext, url: string): void {
	const row = DOM.append(body, $('.agent-settings-info-row'));
	appendIcon(row, Codicon.info, 'agent-settings-info-icon');
	const labels = DOM.append(row, $('.agent-settings-link-labels'));
	DOM.append(labels, $('.agent-settings-link-detail')).textContent =
		localize('agentSettings.remoteHosts.localDetail', "On this machine only: {0}", url);
	const controls = DOM.append(row, $('.agent-settings-inline-actions'));
	appendLinkButton(
		ctx.store,
		controls,
		localize('agentSettings.remoteHosts.copyLocal', "Copy local link"),
		() => ctx.copy(url),
	);
}

/**
 * The devices this machine is letting in, kept current while the page sits
 * still.
 *
 * A device joining or leaving is the one thing on this card that happens
 * without the user doing anything, so the list follows `onDidChangeClients`
 * rather than waiting for something else on the page to force a redraw.
 */
function renderConnectedDevices(body: HTMLElement, ctx: IRemoteHostsThisMachineContext, clients: IConnectedClientsContext): void {
	const group = DOM.append(body, $('.agent-settings-clients'));
	DOM.append(group, $('.agent-settings-clients-title')).textContent =
		localize('agentSettings.remoteHosts.clients', "Connected devices");
	const list = DOM.append(group, $('.agent-settings-client-list'));

	// Every row carries a button and every redraw replaces every row, so the
	// rows get a store of their own: a phone that reconnects all afternoon must
	// not leave a live button behind for each attempt.
	const listStore = ctx.store.add(new DisposableStore());
	const draw = (connected: readonly IMobileClientInfo[]): void => {
		listStore.clear();
		DOM.clearNode(list);
		const rows = connectedDeviceRows(connected);
		if (rows.length === 0) {
			DOM.append(list, $('.agent-settings-client-empty')).textContent =
				localize('agentSettings.remoteHosts.clientsEmpty', "No devices connected");
			return;
		}
		for (const row of rows) {
			renderConnectedDevice(list, listStore, clients, row);
		}
	};

	let live = false;
	ctx.store.add(clients.tunnelHostService.onDidChangeClients(connected => {
		live = true;
		draw(connected);
	}));
	// Nothing is drawn until the first answer arrives: "No devices connected",
	// shown while the question is still in flight, is a wrong answer to
	// somebody holding a connected phone. An event that landed meanwhile is the
	// newer answer and the listing must not overwrite it.
	clients.tunnelHostService.listClients().then(
		connected => {
			if (!live && !listStore.isDisposed) {
				draw(connected);
			}
		},
		() => { /* a page that cannot ask says nothing rather than "nobody" */ },
	);
}

function renderConnectedDevice(
	list: HTMLElement,
	store: DisposableStore,
	clients: IConnectedClientsContext,
	row: IConnectedDeviceRow,
): void {
	const element = DOM.append(list, $('.agent-settings-client-row'));
	appendIcon(element, Codicon.deviceMobile, 'agent-settings-client-icon');

	const labels = DOM.append(element, $('.agent-settings-client-labels'));
	DOM.append(labels, $('.agent-settings-client-name')).textContent = row.label;
	DOM.append(labels, $('.agent-settings-client-detail')).textContent = row.detail;

	const actions = DOM.append(element, $('.agent-settings-inline-actions'));
	appendLinkButton(
		store,
		actions,
		localize('agentSettings.remoteHosts.clientDisconnect', "Disconnect"),
		() => { confirmAndDisconnect(clients, row); },
	);
}

/**
 * Cutting a device off is not reversible from here — the device decides
 * whether to come back — so it is asked about first, and a failure is reported
 * rather than swallowed: a security control that quietly does nothing is worse
 * than one that is missing.
 */
async function confirmAndDisconnect(clients: IConnectedClientsContext, row: IConnectedDeviceRow): Promise<void> {
	const { confirmed } = await clients.dialogService.confirm({
		message: localize('agentSettings.remoteHosts.clientDisconnectConfirm', "Disconnect '{0}'?", row.label),
		detail: localize('agentSettings.remoteHosts.clientDisconnectConfirmDetail', "That device stops controlling this machine until someone opens the link on it again."),
		primaryButton: localize('agentSettings.remoteHosts.clientDisconnectConfirmYes', "Disconnect"),
		type: 'warning',
	});
	if (!confirmed) {
		return;
	}
	try {
		await clients.tunnelHostService.disconnectClient(row.id);
	} catch (error) {
		clients.dialogService.error(
			localize('agentSettings.remoteHosts.clientDisconnectFailed', "Could not disconnect '{0}'.", row.label),
			error instanceof Error ? error.message : String(error));
	}
}
