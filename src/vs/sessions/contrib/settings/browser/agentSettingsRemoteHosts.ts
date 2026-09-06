/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSettingsRemoteHosts.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isWeb, isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IRemoteAgentHostService, RemoteAgentHostEntryType, RemoteAgentHostsEnabledSettingId } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ISSHRemoteAgentHostService, SSHAuthMethod, type ISSHAgentHostConfig } from '../../../../platform/agentHost/common/sshRemoteAgentHost.js';
import { IWSLRemoteAgentHostService } from '../../../../platform/agentHost/common/wslRemoteAgentHost.js';
import { IRemoteAgentHostInventoryEntry, IRemoteAgentHostInventoryService } from '../../../services/remoteAgentHostInventory/common/remoteAgentHostInventory.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { URI } from '../../../../base/common/uri.js';
import { isTunnelHosted, ITunnelAgentHostService, type ITunnelInfo } from '../../../../platform/agentHost/common/tunnelAgentHost.js';
import { ITunnelHostService } from '../../../../workbench/contrib/chat/common/tunnelHost.js';
import { AuthenticationSession, IAuthenticationService } from '../../../../workbench/services/authentication/common/authentication.js';
import { IAgentHostFilterEntry, IAgentHostFilterService } from '../../../services/agentHostFilter/common/agentHostFilter.js';
import { CLOSE_AGENT_SETTINGS_COMMAND_ID } from './agentSettings.js';
import { emptyAddDeviceFields, type AddDeviceSshPlan, type AddDeviceStep, type AddDeviceType, type IAddDeviceFields, type WslDistroList } from './remoteHostsAddDevice.js';
import { renderDevices } from './remoteHostsDevices.js';
import { renderThisMachine } from './remoteHostsThisMachine.js';
import {
	providerLabel,
	renderAdvanced,
	TUNNEL_AUTH_PROVIDERS,
	type DevTunnelAccount,
	type DevTunnelLimits,
	type DevTunnelList,
	type TunnelAuthProvider,
} from './remoteHostsAdvanced.js';

const $ = DOM.$;

export { selectOfflineTunnels, selectReportableLimits, tunnelDetail, tunnelPurpose } from './remoteHostsAdvanced.js';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Remote Connections: what this machine lets in, what it reaches out to, and —
 * folded away — the dev tunnel account both depend on.
 *
 * The page reads the stores rather than the live providers, so a device that
 * has stopped producing a provider, or never had one, is still something the
 * user can see, rename and delete. This class owns the lookups and every
 * confirmation dialog; the three sections only draw.
 */
export class AgentSettingsRemoteHosts extends Disposable {

	private readonly _renderStore = this._register(new DisposableStore());
	private _container: HTMLElement | undefined;

	/** See {@link renderAdvanced}: all three are looked up once and re-used across renders. */
	private _account: DevTunnelAccount = { kind: 'unknown' };
	private _tunnels: DevTunnelList = { kind: 'unknown' };
	private _limits: DevTunnelLimits = { kind: 'unknown' };
	/** Guards {@link _rerender}: a lookup started while drawing must not redraw into a half-built page. */
	private _rendering = false;
	private _disposed = false;

	/**
	 * The Add Device panel's state, held here because the page redraws itself
	 * wholesale on every inventory / provider / tunnel-host event — a form kept
	 * only in the DOM would be emptied by something the user never did.
	 * `_addTunnels` is the connectable list, distinct from Advanced's
	 * `_tunnels`, which counts every tunnel on the account.
	 */
	private _addStep: AddDeviceStep = { kind: 'closed' };
	private readonly _addFields: IAddDeviceFields = emptyAddDeviceFields();
	private _addTunnels: DevTunnelList = { kind: 'unknown' };
	private _addDistros: WslDistroList = { kind: 'unknown' };
	private _sshAliases: readonly string[] = [];

	constructor(
		@IRemoteAgentHostInventoryService private readonly _inventoryService: IRemoteAgentHostInventoryService,
		@IDialogService private readonly _dialogService: IDialogService,
		@ITunnelHostService private readonly _tunnelHostService: ITunnelHostService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ITunnelAgentHostService private readonly _tunnelAgentHostService: ITunnelAgentHostService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IProductService private readonly _productService: IProductService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@ICommandService private readonly _commandService: ICommandService,
		@IAgentHostFilterService private readonly _agentHostFilterService: IAgentHostFilterService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@ISSHRemoteAgentHostService private readonly _sshService: ISSHRemoteAgentHostService,
		@IWSLRemoteAgentHostService private readonly _wslService: IWSLRemoteAgentHostService,
	) {
		super();

		this._register(this._inventoryService.onDidChange(() => this._rerender()));
		this._register(this._tunnelHostService.onDidChangeStatus(() => this._rerender()));
		// The inventory only hears about connections the host service owns; a
		// provider that manages its own transport reaches this page through the
		// filter service, which watches every provider's status.
		this._register(this._agentHostFilterService.onDidChange(() => this._rerender()));
		// An auth provider arriving late — its extension only just activated —
		// turns "no sign-in here" into a real account, so look again.
		this._register(this._authenticationService.onDidChangeDeclaredProviders(() => {
			this._account = { kind: 'unknown' };
			this._rerender();
		}));
	}

	override dispose(): void {
		this._disposed = true;
		super.dispose();
	}

	render(container: HTMLElement): void {
		this._rendering = true;
		try {
			this._render(container);
		} finally {
			this._rendering = false;
		}
	}

	private _render(container: HTMLElement): void {
		this._container = container;
		this._renderStore.clear();
		DOM.clearNode(container);

		DOM.append(container, $('h1.agent-settings-title')).textContent =
			localize('agentSettings.remoteHosts.title', "Remote Connections");
		DOM.append(container, $('p.agent-settings-intro')).textContent =
			localize('agentSettings.remoteHosts.intro', "Let your other devices reach this machine, and manage the devices this one connects to.");

		this._renderThisMachine(container);
		this._renderDevices(container);
		this._renderAdvanced(container);
	}

	private _renderThisMachine(container: HTMLElement): void {
		renderThisMachine(container, {
			store: this._renderStore,
			sharing: this._tunnelHostService.isSharing,
			connecting: this._tunnelHostService.isConnecting,
			sharingInfo: this._tunnelHostService.sharingInfo,
			contextMenuService: this._contextMenuService,
			clients: { tunnelHostService: this._tunnelHostService, dialogService: this._dialogService },
			setSharing: enabled => {
				const run = enabled ? this._tunnelHostService.startSharing() : this._tunnelHostService.stopSharing();
				run.catch(error => {
					this._dialogService.error(
						localize('agentSettings.remoteHosts.shareFailed', "Could not change remote access."),
						errorMessage(error));
				});
			},
			copy: text => { this._clipboardService.writeText(text); },
			open: url => { this._openerService.open(URI.parse(url), { openExternal: true }); },
			resetAccessLink: () => { this._confirmAndResetPairing(); },
		});
	}

	private _renderDevices(container: HTMLElement): void {
		renderDevices(container, {
			store: this._renderStore,
			entries: this._inventoryService.list(),
			hosts: this._agentHostFilterService.hosts,
			contextMenuService: this._contextMenuService,
			addDevice: () => this._addDevice(),
			addDevicePanel: {
				store: this._renderStore,
				step: this._addStep,
				fields: this._addFields,
				capabilities: { dialsOutFromClient: !isWeb, isWindows },
				account: this._account,
				tunnels: this._addTunnels,
				distros: this._addDistros,
				sshAliases: this._sshAliases,
				sharingInfo: this._tunnelHostService.sharingInfo,
				chooseType: type => this._chooseAddType(type),
				back: () => { this._addStep = { kind: 'type' }; this._rerender(); },
				cancel: () => this._closeAddPanel(),
				// No rerender: the input the user is typing into IS the store of
				// this value until something else redraws the page.
				setField: (name, value) => { this._addFields[name] = value; },
				fail: message => {
					if (this._addStep.kind === 'form') {
						this._addStep = { kind: 'form', type: this._addStep.type, error: message };
						this._rerender();
					}
				},
				loadAccount: () => this._loadAccount(),
				signIn: (providerId, scopes) => this._signIn(providerId, scopes),
				loadTunnels: () => this._loadAddTunnels(),
				loadDistros: () => this._loadAddDistros(),
				connectTunnel: tunnel => this._submitAdd(() => this._tunnelAgentHostService.connect(tunnel, 'github', { userInitiated: true })),
				addSsh: plan => this._submitAdd(() => this._connectSshPlan(plan)),
				addWsl: distro => this._submitAdd(() => this._wslService.connect({ distro: distro.name, name: distro.name })),
				addAddress: plan => this._submitAdd(() => this._remoteAgentHostService.addRemoteAgentHost({
					name: plan.name,
					connectionToken: plan.connectionToken,
					connection: { type: RemoteAgentHostEntryType.WebSocket, address: plan.address },
				})),
			},
			connect: (entry, host) => this._connect(entry, host),
			disconnect: (_entry, host) => {
				if (host) {
					this._agentHostFilterService.disconnect(host.providerId);
				}
			},
			rename: entry => { this._promptRename(entry); },
			showSessions: host => this._showSessions(host),
			remove: entry => { this._confirmAndForget(entry); },
		});
	}

	private _renderAdvanced(container: HTMLElement): void {
		renderAdvanced(container, {
			store: this._renderStore,
			account: this._account,
			tunnels: this._tunnels,
			limits: this._limits,
			remoteAgentHostsEnabled: !!this._configurationService.getValue<boolean>(RemoteAgentHostsEnabledSettingId),
			sharingInfo: this._tunnelHostService.sharingInfo,
			loadAccount: () => this._loadAccount(),
			loadTunnels: () => this._loadTunnels(),
			loadLimits: () => this._loadLimits(),
			signIn: (providerId, scopes) => this._signIn(providerId, scopes),
			signOut: (providerId, sessionId, label) => { this._confirmAndSignOut(providerId, sessionId, label); },
			deleteTunnels: tunnels => { this._confirmAndDeleteTunnels(tunnels); },
		});
	}

	private _addDevice(): void {
		this._addStep = { kind: 'type' };
		this._rerender();
	}

	private _closeAddPanel(): void {
		this._addStep = { kind: 'closed' };
		// A stale listing must not greet the next opening of the panel.
		this._addTunnels = { kind: 'unknown' };
		this._addDistros = { kind: 'unknown' };
		this._rerender();
	}

	private _chooseAddType(type: AddDeviceType): void {
		this._addStep = { kind: 'form', type };
		if (type === 'ssh') {
			this._loadSshAliases();
		}
		this._rerender();
	}

	private _loadSshAliases(): void {
		this._sshService.listSSHConfigHosts().then(
			aliases => { this._sshAliases = aliases; this._rerender(); },
			() => { /* no config to read — the form still takes user@host */ },
		);
	}

	private _loadAddTunnels(): void {
		this._addTunnels = { kind: 'loading' };
		this._rerender();
		// Narrow listing, unlike Advanced's: the panel offers devices to connect
		// to, not an audit of the account's allowance.
		this._tunnelAgentHostService.listTunnels({ silent: true }).then(
			tunnels => { this._addTunnels = { kind: 'loaded', tunnels }; },
			error => { this._addTunnels = { kind: 'failed', message: errorMessage(error) }; },
		).finally(() => this._rerender());
	}

	private _loadAddDistros(): void {
		this._addDistros = { kind: 'loading' };
		this._rerender();
		(async (): Promise<WslDistroList> => {
			if (!await this._wslService.isWSLAvailable()) {
				return { kind: 'unavailable' };
			}
			return { kind: 'loaded', distros: await this._wslService.listDistros() };
		})().then(
			state => { this._addDistros = state; },
			error => { this._addDistros = { kind: 'failed', message: errorMessage(error) }; },
		).finally(() => this._rerender());
	}

	/**
	 * Runs a connect/add with the panel flattened. Success closes the panel —
	 * the new device appears in the list right below where the form was;
	 * failure keeps the form with the reason inline.
	 */
	private _submitAdd(run: () => Promise<unknown>): void {
		if (this._addStep.kind !== 'form') {
			return;
		}
		this._addStep = { kind: 'form', type: this._addStep.type, busy: true };
		this._rerender();
		run().then(
			() => { this._addStep = { kind: 'closed' }; },
			error => {
				if (this._addStep.kind === 'form') {
					this._addStep = { kind: 'form', type: this._addStep.type, error: errorMessage(error) };
				}
			},
		).finally(() => this._rerender());
	}

	/**
	 * The same call `sessions.remoteAgentHost.addSSH`'s flows end in: an alias
	 * resolves user/port/key out of the SSH config, an explicit host brings its
	 * own. Auth is the agent — the panel asks where the machine is, not how to
	 * unlock it; key and password prompts stay with the command.
	 */
	private async _connectSshPlan(plan: AddDeviceSshPlan): Promise<void> {
		let config: ISSHAgentHostConfig;
		if (plan.kind === 'alias') {
			const resolved = await this._sshService.resolveSSHConfig(plan.alias);
			const username = plan.username ?? resolved.user;
			if (!username) {
				throw new Error(localize(
					'agentSettings.remoteHosts.addSshAliasNoUser',
					"'{0}' does not name a user in your SSH config. Enter one in the User field.",
					plan.alias));
			}
			config = {
				host: resolved.hostname,
				port: plan.port ?? (resolved.port !== 22 ? resolved.port : undefined),
				username,
				authMethod: SSHAuthMethod.Agent,
				privateKeyPath: resolved.identityFile[0],
				identityAgent: resolved.identityAgent,
				agentForward: resolved.forwardAgent || undefined,
				name: plan.name,
				sshConfigHost: plan.alias,
			};
		} else {
			config = {
				host: plan.host,
				port: plan.port,
				username: plan.username,
				authMethod: SSHAuthMethod.Agent,
				name: plan.name,
			};
		}
		await this._sshService.connect(config);
	}

	/**
	 * Connecting goes through the provider when there is one, which is the same
	 * path the sessions list uses; the host service is the fallback for a device
	 * that is remembered but has no provider right now.
	 */
	private _connect(entry: IRemoteAgentHostInventoryEntry, host: IAgentHostFilterEntry | undefined): void {
		if (host) {
			this._agentHostFilterService.reconnect(host.providerId);
			return;
		}
		if (entry.address) {
			this._remoteAgentHostService.reconnect(entry.address);
		}
	}

	private _showSessions(host: IAgentHostFilterEntry): void {
		this._agentHostFilterService.setScope({ kind: 'host', providerId: host.providerId });
		this._commandService.executeCommand(CLOSE_AGENT_SETTINGS_COMMAND_ID);
	}

	/**
	 * The name is this app's own, not the host's: it is stored beside the
	 * inventory, so every kind of device can be renamed and an empty answer
	 * puts the store's own name back.
	 */
	private async _promptRename(entry: IRemoteAgentHostInventoryEntry): Promise<void> {
		const name = await this._quickInputService.input({
			title: localize('agentSettings.remoteHosts.renameTitle', "Rename '{0}'", entry.label),
			prompt: localize('agentSettings.remoteHosts.renamePrompt', "Enter a name for this device, or leave it empty to use its original name."),
			value: entry.label,
			valueSelection: [0, entry.label.length],
			ignoreFocusLost: true,
		});
		if (name === undefined) {
			return;
		}
		this._inventoryService.rename(entry, name);
	}

	private async _confirmAndResetPairing(): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			message: localize('agentSettings.remoteHosts.resetPairingConfirm', "Reset the address for this machine?"),
			detail: localize('agentSettings.remoteHosts.resetPairingConfirmDetail', "Any phone or link still on the old address stops working and has to be given the new one."),
			primaryButton: localize('agentSettings.remoteHosts.resetPairingConfirmYes', "Reset"),
			type: 'warning',
		});
		if (!confirmed) {
			return;
		}
		try {
			await this._tunnelHostService.rollPhonePairing();
		} catch (error) {
			this._dialogService.error(
				localize('agentSettings.remoteHosts.resetPairingFailed', "Could not reset the address."),
				errorMessage(error));
		}
	}

	private _rerender(): void {
		if (this._container && !this._rendering && !this._disposed) {
			this.render(this._container);
		}
	}

	/**
	 * Resolve which account the tunnel services would use, without ever asking
	 * for one. Every lookup here is silent: sign-in happens only when the user
	 * presses the button.
	 */
	private _loadAccount(): void {
		this._account = { kind: 'loading' };
		(async () => {
			const configured = this._productService.tunnelApplicationConfig?.authenticationProviders;
			const usable = TUNNEL_AUTH_PROVIDERS.filter(provider => (configured?.[provider]?.scopes ?? []).length > 0);
			if (usable.length === 0) {
				return { kind: 'unconfigured' } satisfies DevTunnelAccount;
			}
			// `declaredProviders`, not `isAuthenticationProviderRegistered`: a
			// declared provider is one an extension contributes in its
			// package.json, which is known before that extension activates.
			// Asking whether it is *registered* would report "no sign-in here"
			// on the desktop simply for opening Settings early.
			const declared = usable.filter(provider => this._authenticationService.declaredProviders.some(candidate => candidate.id === provider));
			if (declared.length === 0) {
				return { kind: 'unsupported' } satisfies DevTunnelAccount;
			}
			for (const providerId of declared) {
				const scopes = configured![providerId].scopes;
				const session = await this._findSession(providerId, scopes);
				if (session) {
					return { kind: 'signedIn', providerId, sessionId: session.id, label: session.account.label } satisfies DevTunnelAccount;
				}
			}
			return { kind: 'signedOut', providerId: declared[0], scopes: configured![declared[0]].scopes } satisfies DevTunnelAccount;
		})().then(
			account => { this._account = account; },
			error => { this._account = { kind: 'failed', message: errorMessage(error) }; },
		).finally(() => {
			this._tunnels = { kind: 'unknown' };
			this._limits = { kind: 'unknown' };
			this._rerender();
		});
	}

	/**
	 * The session the tunnel services would pick: an exact scope match first,
	 * then any session that already covers those scopes. Mirrors
	 * `_getTokenForProvider` in `tunnelHostService.ts` and
	 * `tunnelAgentHostServiceImpl.ts`, except that only the account label is
	 * read here — the access token never leaves those services.
	 */
	private async _findSession(providerId: TunnelAuthProvider, scopes: readonly string[]): Promise<AuthenticationSession | undefined> {
		const exact = await this._authenticationService.getSessions(providerId, [...scopes], {}, true);
		if (exact.length > 0) {
			return exact[0];
		}
		const all = await this._authenticationService.getSessions(providerId, undefined, {}, true);
		return all.find(session => scopes.every(scope => session.scopes.includes(scope)));
	}

	private _loadTunnels(): void {
		this._tunnels = { kind: 'loading' };
		this._rerender();
		// Silent: the account is already known to be signed in, and a listing
		// that is only refreshing the page must never raise a sign-in prompt.
		// `includeAllTunnels`: this page exists to show what is using the
		// account's allowance up, and the allowance counts every tunnel — not
		// only the ones this app could connect to.
		this._tunnelAgentHostService.listTunnels({ silent: true, includeAllTunnels: true }).then(
			tunnels => { this._tunnels = { kind: 'loaded', tunnels }; },
			error => { this._tunnels = { kind: 'failed', message: errorMessage(error) }; },
		).finally(() => this._rerender());
	}

	private _loadLimits(): void {
		this._limits = { kind: 'loading' };
		// Silent for the same reason the listing is: refreshing a settings page
		// must never raise a sign-in prompt of its own.
		this._tunnelAgentHostService.listUserLimits({ silent: true }).then(
			limits => { this._limits = limits ? { kind: 'loaded', limits } : { kind: 'unsupported' }; },
			error => { this._limits = { kind: 'failed', message: errorMessage(error) }; },
		).finally(() => this._rerender());
	}

	/** Hands off to the app's own sign-in flow; this page never handles a credential itself. */
	private _signIn(providerId: TunnelAuthProvider, scopes: readonly string[]): void {
		this._authenticationService.createSession(providerId, [...scopes], { activateImmediate: true }).then(
			() => { /* the reload below picks the new session up */ },
			error => this._dialogService.error(
				localize('agentSettings.remoteHosts.signInFailed', "Could not sign in."),
				errorMessage(error)),
		).finally(() => this._loadAccount());
	}

	private async _confirmAndSignOut(providerId: TunnelAuthProvider, sessionId: string, label: string): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			message: localize('agentSettings.remoteHosts.signOutConfirm', "Sign out of '{0}'?", label),
			detail: localize(
				'agentSettings.remoteHosts.signOutConfirmDetail',
				"This signs the whole app out of that {0} account, not just dev tunnels. No tunnel is deleted.",
				providerLabel(providerId)),
			primaryButton: localize('agentSettings.remoteHosts.signOutConfirmYes', "Sign out"),
			type: 'warning',
		});
		if (!confirmed) {
			return;
		}
		try {
			await this._authenticationService.removeSession(providerId, sessionId);
		} catch (error) {
			this._dialogService.error(
				localize('agentSettings.remoteHosts.signOutFailed', "Could not sign out."),
				errorMessage(error));
		}
		this._loadAccount();
	}

	/**
	 * Deleting a tunnel is outward-facing and cannot be undone, so it always
	 * confirms and always names what goes — one tunnel or a whole batch.
	 */
	private async _confirmAndDeleteTunnels(tunnels: readonly ITunnelInfo[]): Promise<void> {
		if (tunnels.length === 0) {
			return;
		}
		const sharingInfo = this._tunnelHostService.sharingInfo;
		const hosted = tunnels.filter(tunnel => isTunnelHosted(sharingInfo, tunnel));
		const recreated = localize('agentSettings.remoteHosts.tunnelDeleteRecreated', "A machine still hosting a deleted tunnel can register it again.");
		const hostedWarning = hosted.length > 0
			? localize(
				'agentSettings.remoteHosts.tunnelDeleteHosted',
				"'{0}' is the tunnel this machine is hosting right now. Deleting it takes away the address other devices use until sharing is started again.",
				hosted.map(tunnel => tunnel.name).join(', '))
			: undefined;

		const { confirmed } = await this._dialogService.confirm({
			message: tunnels.length === 1
				? localize('agentSettings.remoteHosts.tunnelDeleteConfirm', "Delete dev tunnel '{0}'?", tunnels[0].name)
				: localize('agentSettings.remoteHosts.tunnelDeleteConfirmMany', "Delete {0} dev tunnels?", tunnels.length),
			detail: [
				tunnels.length === 1 ? undefined : tunnels.map(tunnel => `• ${tunnel.name} (${tunnel.tunnelId})`).join('\n'),
				hostedWarning,
				recreated,
			].filter((part): part is string => !!part).join('\n\n'),
			primaryButton: localize('agentSettings.remoteHosts.tunnelDeleteConfirmYes', "Delete"),
			type: 'warning',
		});
		if (!confirmed) {
			return;
		}

		this._tunnels = { kind: 'loading' };
		this._rerender();

		const failures: string[] = [];
		for (const tunnel of tunnels) {
			try {
				await this._tunnelAgentHostService.deleteTunnel(tunnel);
			} catch (error) {
				failures.push(`${tunnel.name}: ${errorMessage(error)}`);
			}
		}
		if (failures.length > 0) {
			this._dialogService.error(
				localize('agentSettings.remoteHosts.tunnelDeleteFailed', "Could not delete every dev tunnel."),
				failures.join('\n'));
		}
		this._loadTunnels();
	}

	private async _confirmAndForget(entry: IRemoteAgentHostInventoryEntry): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			message: localize('agentSettings.remoteHosts.confirm', "Remove '{0}'?", entry.label),
			detail: entry.cachedSessionCount > 0
				? localize(
					'agentSettings.remoteHosts.confirmDetail',
					"Its {0} cached sessions are deleted from this machine. Sessions on the host itself are not touched.",
					entry.cachedSessionCount)
				: localize('agentSettings.remoteHosts.confirmDetailEmpty', "This host is removed from this machine. Sessions on the host itself are not touched."),
			primaryButton: localize('agentSettings.remoteHosts.confirmYes', "Remove"),
			type: 'warning',
		});
		if (!confirmed) {
			return;
		}
		await this._inventoryService.forget(entry);
	}
}
