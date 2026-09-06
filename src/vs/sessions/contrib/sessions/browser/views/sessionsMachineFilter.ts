/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Action, IAction, Separator, SubmenuAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { Action2, IMenuService, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { logSessionsMachineFilterChange } from '../../../../common/sessionsTelemetry.js';
import { AgentHostFilterConnectionStatus, AgentHostFilterScope, agentHostFilterScopeEquals, IAgentHostFilterService } from '../../../../services/agentHostFilter/common/agentHostFilter.js';
import { OPEN_AGENT_SETTINGS_COMMAND_ID, REMOTE_HOSTS_NAV_ID } from '../../../settings/browser/agentSettings.js';

const $ = DOM.$;

export const SELECT_ALL_MACHINES_COMMAND_ID = 'sessions.machineFilter.selectAll';
export const SELECT_LOCAL_MACHINE_COMMAND_ID = 'sessions.machineFilter.selectLocal';
export const SELECT_HOST_MACHINE_COMMAND_ID = 'sessions.machineFilter.selectHost';

/**
 * Applies a machine scope and reports the switch. The resulting scope is read
 * back from the service rather than assumed: a `host` scope naming an unknown
 * provider is rejected and web normalizes `all`/`local` onto a host, and
 * neither of those — nor re-picking the current scope — is a switch.
 */
function setScopeAndLog(accessor: ServicesAccessor, scope: AgentHostFilterScope): void {
	const filterService = accessor.get(IAgentHostFilterService);
	const previous = filterService.scope;
	filterService.setScope(scope);
	const current = filterService.scope;
	if (agentHostFilterScopeEquals(previous, current)) {
		return;
	}
	logSessionsMachineFilterChange(accessor.get(ITelemetryService), {
		scopeKind: current.kind,
		hostCount: filterService.hosts.length,
	});
}

registerAction2(class SelectAllMachinesAction extends Action2 {
	constructor() {
		super({
			id: SELECT_ALL_MACHINES_COMMAND_ID,
			title: localize2('machineFilter.selectAll', "Show Sessions From All Machines"),
			f1: false,
		});
	}
	override run(accessor: ServicesAccessor): void {
		setScopeAndLog(accessor, { kind: 'all' });
	}
});

registerAction2(class SelectLocalMachineAction extends Action2 {
	constructor() {
		super({
			id: SELECT_LOCAL_MACHINE_COMMAND_ID,
			title: localize2('machineFilter.selectLocal', "Show Sessions From This Machine"),
			f1: false,
		});
	}
	override run(accessor: ServicesAccessor): void {
		setScopeAndLog(accessor, { kind: 'local' });
	}
});

registerAction2(class SelectHostMachineAction extends Action2 {
	constructor() {
		super({
			id: SELECT_HOST_MACHINE_COMMAND_ID,
			title: localize2('machineFilter.selectHost', "Show Sessions From a Remote Machine"),
			f1: false,
		});
	}
	override run(accessor: ServicesAccessor, providerId?: unknown): void {
		if (typeof providerId !== 'string') {
			return;
		}
		setScopeAndLog(accessor, { kind: 'host', providerId });
		// Scoping to an offline host is also the natural moment to try to
		// reach it again — the list gates on reachability either way.
		const filterService = accessor.get(IAgentHostFilterService);
		const host = filterService.hosts.find(h => h.providerId === providerId);
		if (host?.status === AgentHostFilterConnectionStatus.Disconnected) {
			filterService.reconnect(providerId);
		}
	}
});

export interface ISessionsMachineFilterOptions {
	/**
	 * The menu the "Display Settings" entry unfolds — the same menu the
	 * header's funnel button shows, so the two entry points can never
	 * drift apart.
	 */
	readonly displayOptionsMenu: MenuId;
}

/**
 * The sessions-list header title as a machine-scope dropdown: "All Sessions" /
 * "This Machine" / one remote host by name, plus entries into the Remote
 * Connections settings page and the display-options menu.
 */
export class SessionsMachineFilter extends Disposable {

	private readonly _button: HTMLElement;
	private readonly _label: HTMLElement;

	constructor(
		container: HTMLElement,
		private readonly _options: ISessionsMachineFilterOptions,
		@IAgentHostFilterService private readonly _filterService: IAgentHostFilterService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@ICommandService private readonly _commandService: ICommandService,
		@IMenuService private readonly _menuService: IMenuService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
	) {
		super();

		this._button = DOM.append(container, $('button.agent-sessions-machine-filter'));
		this._button.setAttribute('type', 'button');
		this._button.setAttribute('aria-haspopup', 'menu');
		this._label = DOM.append(this._button, $('span.agent-sessions-machine-filter-label'));
		const chevron = DOM.append(this._button, $('span.agent-sessions-machine-filter-chevron'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));

		this._register(DOM.addDisposableListener(this._button, 'click', () => this._showMenu()));
		this._register(this._filterService.onDidChange(() => this._updateLabel()));
		this._updateLabel();
	}

	private _updateLabel(): void {
		const text = this._labelText();
		this._label.textContent = text;
		this._button.setAttribute('aria-label', localize('machineFilter.ariaLabel', "Filter sessions by machine. Current: {0}", text));
	}

	private _labelText(): string {
		const scope = this._filterService.scope;
		switch (scope.kind) {
			case 'local':
				return localize('machineFilter.title.local', "This Machine");
			case 'host':
				return this._filterService.hosts.find(h => h.providerId === scope.providerId)?.label
					?? localize('machineFilter.title.remote', "Remote Machine");
			default:
				return localize('machineFilter.title.all', "All Sessions");
		}
	}

	private _showMenu(): void {
		const scope = this._filterService.scope;
		const actions: IAction[] = [];

		actions.push(this._scopeAction('sessions.machineFilter.menu.all',
			localize('machineFilter.menu.all', "All Sessions"),
			scope.kind === 'all',
			() => this._commandService.executeCommand(SELECT_ALL_MACHINES_COMMAND_ID)));
		actions.push(this._scopeAction('sessions.machineFilter.menu.local',
			localize('machineFilter.menu.local', "This Machine"),
			scope.kind === 'local',
			() => this._commandService.executeCommand(SELECT_LOCAL_MACHINE_COMMAND_ID)));

		for (const host of this._filterService.hosts) {
			const label = host.status === AgentHostFilterConnectionStatus.Connected
				? host.label
				: host.status === AgentHostFilterConnectionStatus.Connecting
					? localize('machineFilter.hostConnecting', "{0} (connecting…)", host.label)
					: localize('machineFilter.hostDisconnected', "{0} (disconnected)", host.label);
			actions.push(this._scopeAction(`sessions.machineFilter.menu.host.${host.providerId}`,
				label,
				scope.kind === 'host' && scope.providerId === host.providerId,
				() => this._commandService.executeCommand(SELECT_HOST_MACHINE_COMMAND_ID, host.providerId)));
		}

		actions.push(new Separator());
		actions.push(new Action('sessions.machineFilter.menu.remoteSettings',
			localize('machineFilter.menu.remoteSettings', "Remote Connections…"),
			undefined, true,
			async () => this._commandService.executeCommand(OPEN_AGENT_SETTINGS_COMMAND_ID, REMOTE_HOSTS_NAV_ID)));

		// The display-options menu's checkbox state lives in context keys, so
		// the menu has to be materialized fresh per opening and kept alive
		// until the dropdown closes.
		const displayOptions = this._menuService.createMenu(this._options.displayOptionsMenu, this._contextKeyService);
		actions.push(new SubmenuAction('sessions.machineFilter.menu.displaySettings',
			localize('machineFilter.menu.displaySettings', "Display Settings"),
			getFlatContextMenuActions(displayOptions.getActions())));

		this._contextMenuService.showContextMenu({
			getAnchor: () => this._button,
			getActions: () => actions,
			onHide: () => displayOptions.dispose(),
		});
	}

	private _scopeAction(id: string, label: string, checked: boolean, run: () => unknown): IAction {
		const action = new Action(id, label, undefined, true, async () => { await run(); });
		action.checked = checked;
		return action;
	}
}
