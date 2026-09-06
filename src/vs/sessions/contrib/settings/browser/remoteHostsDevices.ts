/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { RemoteAgentHostEntryType } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { AgentHostFilterConnectionStatus, IAgentHostFilterEntry } from '../../../services/agentHostFilter/common/agentHostFilter.js';
import {
	IRemoteAgentHostInventoryEntry,
	RemoteAgentHostInventoryState,
} from '../../../services/remoteAgentHostInventory/common/remoteAgentHostInventory.js';
import {
	AgentSettingsStatusTone,
	appendBadge,
	appendCard,
	appendIcon,
	appendLinkButton,
	appendOverflowMenu,
	appendPrimaryButton,
	appendSectionWithActions,
	appendStatusDot,
} from './agentSettingsForm.js';
import { renderAddDevice, type IRemoteHostsAddDeviceContext } from './remoteHostsAddDevice.js';

const $ = DOM.$;

/** What a device card's `…` menu offers, in the order it offers it. */
export type DeviceMenuAction = 'rename' | 'showSessions' | 'remove' | 'cleanUp';

/** Everything a device card draws, decided without touching the DOM. */
export interface IDeviceCard {
	readonly tone: AgentSettingsStatusTone;
	readonly statusLabel: string;
	/** Leftover data whose host is in no store any more. */
	readonly unavailable: boolean;
	readonly icon: ThemeIcon;
	readonly name: string;
	readonly detail: string;
	readonly primaryAction: 'connect' | 'disconnect' | 'none';
	readonly menu: readonly DeviceMenuAction[];
}

/**
 * The live host this stored device is, when there is one.
 *
 * The address is the only identity the two sides share: the filter service
 * keys hosts by a provider id that this page never sees, and the inventory
 * keys them by where the host lives.
 */
export function findHost(hosts: readonly IAgentHostFilterEntry[], entry: IRemoteAgentHostInventoryEntry): IAgentHostFilterEntry | undefined {
	return entry.address ? hosts.find(host => host.address === entry.address) : undefined;
}

/**
 * A green light means sessions on this device are reachable right now, which
 * is `hasLiveConnection` and not `status`: a dev tunnel reports itself
 * connected as soon as the far machine is online, long before anything here
 * can talk to it.
 */
export function deviceCard(entry: IRemoteAgentHostInventoryEntry, host: IAgentHostFilterEntry | undefined): IDeviceCard {
	const unavailable = entry.state === RemoteAgentHostInventoryState.Orphaned;
	const tone = deviceTone(entry, host);
	return {
		tone,
		statusLabel: statusLabel(tone),
		unavailable,
		icon: deviceIcon(entry.kind),
		name: entry.label,
		detail: deviceDetail(entry),
		primaryAction: unavailable || tone === 'connecting' ? 'none' : tone === 'connected' ? 'disconnect' : 'connect',
		menu: unavailable
			? ['cleanUp']
			: host
				? ['rename', 'showSessions', 'remove']
				: ['rename', 'remove'],
	};
}

function deviceTone(entry: IRemoteAgentHostInventoryEntry, host: IAgentHostFilterEntry | undefined): AgentSettingsStatusTone {
	if (entry.state === RemoteAgentHostInventoryState.Orphaned) {
		return 'idle';
	}
	if (host) {
		if (host.hasLiveConnection) {
			return 'connected';
		}
		return host.status === AgentHostFilterConnectionStatus.Connecting ? 'connecting' : 'idle';
	}
	switch (entry.state) {
		case RemoteAgentHostInventoryState.Connected:
			return 'connected';
		case RemoteAgentHostInventoryState.Connecting:
			return 'connecting';
		default:
			return 'idle';
	}
}

function statusLabel(tone: AgentSettingsStatusTone): string {
	switch (tone) {
		case 'connected':
			return localize('agentSettings.remoteHosts.connected', "Connected");
		case 'connecting':
			return localize('agentSettings.remoteHosts.connecting', "Connecting…");
		default:
			return localize('agentSettings.remoteHosts.disconnected', "Not connected");
	}
}

export function deviceIcon(kind: IRemoteAgentHostInventoryEntry['kind']): ThemeIcon {
	switch (kind) {
		case RemoteAgentHostEntryType.WSL:
			return Codicon.terminalLinux;
		case RemoteAgentHostEntryType.CloudSandbox:
			return Codicon.cloud;
		default:
			return Codicon.remote;
	}
}

export function kindLabel(kind: IRemoteAgentHostInventoryEntry['kind']): string {
	switch (kind) {
		case RemoteAgentHostEntryType.Tunnel:
			return localize('agentSettings.remoteHosts.kind.tunnel', "Dev tunnel");
		case RemoteAgentHostEntryType.SSH:
			return localize('agentSettings.remoteHosts.kind.ssh', "SSH");
		case RemoteAgentHostEntryType.WSL:
			return localize('agentSettings.remoteHosts.kind.wsl', "WSL");
		case RemoteAgentHostEntryType.WebSocket:
			return localize('agentSettings.remoteHosts.kind.websocket', "Address");
		case RemoteAgentHostEntryType.CloudSandbox:
			return localize('agentSettings.remoteHosts.kind.cloudSandbox', "Cloud sandbox");
		default:
			return localize('agentSettings.remoteHosts.kind.unknown', "Unknown");
	}
}

/** The line under a device's name: what it is, where it is, when it was last here. */
export function deviceDetail(entry: IRemoteAgentHostInventoryEntry): string {
	return [
		kindLabel(entry.kind),
		entry.address,
		entry.lastConnectedAt === undefined
			? localize('agentSettings.remoteHosts.neverConnected', "never connected")
			: localize('agentSettings.remoteHosts.lastConnected', "last connected {0}", fromNow(entry.lastConnectedAt, true)),
		entry.cachedSessionCount > 0
			? entry.cachedSessionCount === 1
				? localize('agentSettings.remoteHosts.cachedOne', "1 session")
				: localize('agentSettings.remoteHosts.cached', "{0} sessions", entry.cachedSessionCount)
			: undefined,
	].filter((part): part is string => !!part).join(' · ');
}

export interface IRemoteHostsDevicesContext {
	readonly store: DisposableStore;
	readonly entries: readonly IRemoteAgentHostInventoryEntry[];
	readonly hosts: readonly IAgentHostFilterEntry[];
	readonly contextMenuService: IContextMenuService;
	/** The single call site for adding a device: opens {@link addDevicePanel}. */
	addDevice(): void;
	/**
	 * The guided flow, when the page holds its state. Without it this section
	 * still has its button, and {@link addDevice} is still the quick pick it
	 * used to open.
	 */
	readonly addDevicePanel?: IRemoteHostsAddDeviceContext;
	connect(entry: IRemoteAgentHostInventoryEntry, host: IAgentHostFilterEntry | undefined): void;
	disconnect(entry: IRemoteAgentHostInventoryEntry, host: IAgentHostFilterEntry | undefined): void;
	rename(entry: IRemoteAgentHostInventoryEntry): void;
	showSessions(host: IAgentHostFilterEntry): void;
	/** Owns the confirmation dialog; see `AgentSettingsRemoteHosts`. */
	remove(entry: IRemoteAgentHostInventoryEntry): void;
}

/**
 * The machines this one connects out to.
 *
 * The list is read from the stores rather than from the live providers, so a
 * device that has stopped producing a provider — or never had one — is still
 * something the user can see, rename and delete.
 */
export function renderDevices(container: HTMLElement, ctx: IRemoteHostsDevicesContext): HTMLElement {
	const { section, actions } = appendSectionWithActions(
		container,
		localize('agentSettings.remoteHosts.devicesSection', "My Devices"),
	);
	// While the flow is open it is the way to add a device; a second button
	// that reopens it would throw away the form the user is filling in.
	const adding = ctx.addDevicePanel !== undefined && ctx.addDevicePanel.step.kind !== 'closed';
	if (!adding) {
		appendPrimaryButton(
			ctx.store,
			actions,
			localize('agentSettings.remoteHosts.addDevice', "Add Device"),
			() => ctx.addDevice(),
		);
	}
	if (ctx.addDevicePanel) {
		renderAddDevice(section, ctx.addDevicePanel);
	}

	if (ctx.entries.length === 0) {
		const empty = DOM.append(section, $('.agent-settings-empty-state'));
		DOM.append(empty, $('p.agent-settings-intro')).textContent = localize(
			'agentSettings.remoteHosts.devicesEmpty',
			"Open Fumie on another computer and let it accept connections, then add it here.");
		if (!adding) {
			appendPrimaryButton(
				ctx.store,
				DOM.append(empty, $('.agent-settings-inline-actions')),
				localize('agentSettings.remoteHosts.addDevice', "Add Device"),
				() => ctx.addDevice(),
			);
		}
		return section;
	}

	const list = DOM.append(section, $('.agent-settings-device-list'));
	for (const entry of ctx.entries) {
		renderDeviceCard(list, ctx, entry);
	}
	return section;
}

function renderDeviceCard(list: HTMLElement, ctx: IRemoteHostsDevicesContext, entry: IRemoteAgentHostInventoryEntry): void {
	const host = findHost(ctx.hosts, entry);
	const card = deviceCard(entry, host);

	const element = appendCard(list, 'agent-settings-device-card');
	appendStatusDot(element, card.tone, card.statusLabel);
	appendIcon(element, card.icon, 'agent-settings-device-icon');

	const labels = DOM.append(element, $('.agent-settings-device-labels'));
	const nameRow = DOM.append(labels, $('.agent-settings-device-name'));
	DOM.append(nameRow, $('span')).textContent = card.name;
	if (card.unavailable) {
		// "Orphaned" is a description of this app's own storage, not of the
		// user's device. What they can act on is that it is not usable.
		appendBadge(
			nameRow,
			localize('agentSettings.remoteHosts.unavailable', "Unavailable"),
			localize('agentSettings.remoteHosts.unavailableDetail', "This device is gone. Only data it left on this machine is left."),
		);
	}
	DOM.append(labels, $('.agent-settings-device-detail')).textContent = card.detail;

	const actions = DOM.append(element, $('.agent-settings-card-actions'));
	if (card.primaryAction === 'connect') {
		appendLinkButton(
			ctx.store,
			actions,
			localize('agentSettings.remoteHosts.connect', "Connect"),
			() => ctx.connect(entry, host),
		);
	} else if (card.primaryAction === 'disconnect') {
		appendLinkButton(
			ctx.store,
			actions,
			localize('agentSettings.remoteHosts.disconnect', "Disconnect"),
			() => ctx.disconnect(entry, host),
		);
	}

	appendOverflowMenu(
		ctx.store,
		actions,
		ctx.contextMenuService,
		localize('agentSettings.remoteHosts.deviceMore', "More actions for {0}", card.name),
		() => deviceMenuActions(ctx, entry, host, card),
	);
}

function deviceMenuActions(
	ctx: IRemoteHostsDevicesContext,
	entry: IRemoteAgentHostInventoryEntry,
	host: IAgentHostFilterEntry | undefined,
	card: IDeviceCard,
): IAction[] {
	const actions: IAction[] = [];
	for (const id of card.menu) {
		switch (id) {
			case 'rename':
				actions.push(new Action(
					'agentSettings.remoteHosts.rename',
					localize('agentSettings.remoteHosts.rename', "Rename"),
					undefined, true, async () => ctx.rename(entry)));
				break;
			case 'showSessions':
				if (host) {
					actions.push(new Action(
						'agentSettings.remoteHosts.showSessions',
						localize('agentSettings.remoteHosts.showSessions', "Show Sessions"),
						undefined, true, async () => ctx.showSessions(host)));
				}
				break;
			case 'remove':
				actions.push(new Action(
					'agentSettings.remoteHosts.remove',
					localize('agentSettings.remoteHosts.remove', "Remove"),
					undefined, true, async () => ctx.remove(entry)));
				break;
			case 'cleanUp':
				actions.push(new Action(
					'agentSettings.remoteHosts.cleanUp',
					localize('agentSettings.remoteHosts.cleanUp', "Clean up"),
					undefined, true, async () => ctx.remove(entry)));
				break;
		}
	}
	return actions;
}
