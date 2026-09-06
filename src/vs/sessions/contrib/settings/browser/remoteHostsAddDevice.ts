/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { parseRemoteAgentHostInput, RemoteAgentHostInputValidationError } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { isTunnelHosted, type ITunnelHostInfo, type ITunnelInfo } from '../../../../platform/agentHost/common/tunnelAgentHost.js';
import type { IWSLDistro } from '../../../../platform/agentHost/common/wslRemoteAgentHost.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { appendCard, appendIcon, appendLinkButton } from './agentSettingsForm.js';
import { providerLabel, type DevTunnelAccount, type DevTunnelList, type TunnelAuthProvider } from './remoteHostsAdvanced.js';

const $ = DOM.$;

/** How a device is reached — the only question step 1 asks. */
export type AddDeviceType = 'tunnel' | 'ssh' | 'wsl' | 'address';

/**
 * Where the panel is.
 *
 * `busy` and `error` live here rather than in the panel's own DOM because the
 * page redraws itself whenever the inventory, a provider or the tunnel host
 * changes — which can happen while a form is on screen. A message the user has
 * not read yet has to survive that.
 */
export type AddDeviceStep =
	| { readonly kind: 'closed' }
	| { readonly kind: 'type' }
	| { readonly kind: 'form'; readonly type: AddDeviceType; readonly busy?: boolean; readonly error?: string };

/** The half-filled forms, kept by the page for the same reason. */
export interface IAddDeviceFields {
	sshHost: string;
	sshUser: string;
	sshPort: string;
	address: string;
	token: string;
}

export function emptyAddDeviceFields(): IAddDeviceFields {
	return { sshHost: '', sshUser: '', sshPort: '', address: '', token: '' };
}

/**
 * What this client can add at all.
 *
 * SSH and WSL dial out of the client process itself — a raw socket, a local
 * `wsl.exe` — which a browser cannot do, so those two are offered on exactly
 * the same terms as the commands behind them (see `DialsOutFromClientContext`
 * in `remoteAgentHostActions.ts`).
 */
export interface IAddDeviceCapabilities {
	readonly dialsOutFromClient: boolean;
	readonly isWindows: boolean;
}

export interface IAddDeviceChoice {
	readonly type: AddDeviceType;
	readonly icon: ThemeIcon;
	readonly label: string;
	readonly detail: string;
}

export function addDeviceTypeLabel(type: AddDeviceType): string {
	switch (type) {
		case 'tunnel':
			return localize('agentSettings.remoteHosts.addTypeTunnel', "Remote device");
		case 'ssh':
			return localize('agentSettings.remoteHosts.addTypeSsh', "SSH");
		case 'wsl':
			return localize('agentSettings.remoteHosts.addTypeWsl', "WSL");
		case 'address':
			return localize('agentSettings.remoteHosts.addTypeAddress', "Address");
	}
}

/** The ways of reaching a device this client can actually offer, in order. */
export function addDeviceChoices(capabilities: IAddDeviceCapabilities): IAddDeviceChoice[] {
	const choices: IAddDeviceChoice[] = [{
		type: 'tunnel',
		icon: Codicon.cloud,
		label: addDeviceTypeLabel('tunnel'),
		detail: localize('agentSettings.remoteHosts.addTypeTunnelDetail', "A computer accepting connections through a dev tunnel."),
	}];
	if (capabilities.dialsOutFromClient) {
		choices.push({
			type: 'ssh',
			icon: Codicon.remote,
			label: addDeviceTypeLabel('ssh'),
			detail: localize('agentSettings.remoteHosts.addTypeSshDetail', "A machine you can already reach over SSH."),
		});
		if (capabilities.isWindows) {
			choices.push({
				type: 'wsl',
				icon: Codicon.terminalLinux,
				label: addDeviceTypeLabel('wsl'),
				detail: localize('agentSettings.remoteHosts.addTypeWslDetail', "A Linux distribution installed on this machine."),
			});
		}
	}
	choices.push({
		type: 'address',
		icon: Codicon.link,
		label: addDeviceTypeLabel('address'),
		detail: localize('agentSettings.remoteHosts.addTypeAddressDetail', "A host and port an agent host is already listening on."),
	});
	return choices;
}

/**
 * What stands between this panel and a list of remote devices, when something
 * does. The account is the Advanced section's — every state it distinguishes
 * is one the user can land in, and a panel that only drew a list when it had
 * one would leave a signed-out user staring at nothing.
 */
export type AddDeviceAccountBlock =
	| { readonly kind: 'checking'; readonly message: string }
	| { readonly kind: 'signIn'; readonly providerId: TunnelAuthProvider; readonly scopes: readonly string[]; readonly message: string }
	| { readonly kind: 'unavailable'; readonly message: string }
	| { readonly kind: 'retry'; readonly message: string };

export function accountBlock(account: DevTunnelAccount): AddDeviceAccountBlock | undefined {
	switch (account.kind) {
		case 'signedIn':
			return undefined;
		case 'unknown':
		case 'loading':
			return {
				kind: 'checking',
				message: localize('agentSettings.remoteHosts.addAccountLoading', "Checking which account this app is signed in as…"),
			};
		case 'signedOut':
			return {
				kind: 'signIn',
				providerId: account.providerId,
				scopes: account.scopes,
				message: localize(
					'agentSettings.remoteHosts.addAccountSignedOut',
					"Sign in with {0} to find the devices on your account.",
					providerLabel(account.providerId)),
			};
		case 'unconfigured':
			return {
				kind: 'unavailable',
				message: localize('agentSettings.remoteHosts.addAccountUnconfigured', "This build has no sign-in for remote devices, so none can be found from here."),
			};
		case 'unsupported':
			return {
				kind: 'unavailable',
				message: localize('agentSettings.remoteHosts.addAccountUnsupported', "Signing in is not available in this client. Add this device from the desktop app."),
			};
		case 'failed':
			return { kind: 'retry', message: account.message };
	}
}

/**
 * The remote devices worth offering: every one but this machine's own. A
 * tunnel this machine is hosting is not a device to add — connecting to it
 * would be connecting to the page the user is looking at.
 */
export function selectAddableTunnels(tunnels: readonly ITunnelInfo[], sharingInfo: ITunnelHostInfo | undefined): ITunnelInfo[] {
	return tunnels.filter(tunnel => !isTunnelHosted(sharingInfo, tunnel));
}

/** Whether a remote device is answering right now. Its ids stay in Advanced. */
export function tunnelRowDetail(tunnel: ITunnelInfo): string {
	return tunnel.hostConnectionCount > 0
		? localize('agentSettings.remoteHosts.addTunnelOnline', "Online")
		: localize('agentSettings.remoteHosts.addTunnelOffline', "Offline");
}

export function wslDistroDetail(distro: IWSLDistro): string {
	return [
		distro.isRunning
			? localize('agentSettings.remoteHosts.addWslRunning', "Running")
			: localize('agentSettings.remoteHosts.addWslStopped', "Stopped"),
		distro.isDefault ? localize('agentSettings.remoteHosts.addWslDefault', "Default") : undefined,
	].filter((part): part is string => !!part).join(' · ');
}

/** The WSL distributions this machine has, as far as the panel has got asking. */
export type WslDistroList =
	| { readonly kind: 'unknown' }
	| { readonly kind: 'loading' }
	/** WSL itself is missing or turned off, so there is nothing to list. */
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'loaded'; readonly distros: readonly IWSLDistro[] }
	| { readonly kind: 'failed'; readonly message: string };

/** A form that either says what to do next, or why it cannot. */
export type AddDevicePlan<T> =
	| { readonly plan: T; readonly error?: undefined }
	| { readonly plan?: undefined; readonly error: string };

export type AddDeviceSshPlan =
	/** A `Host` block in the user's SSH config; the service resolves the rest. */
	| { readonly kind: 'alias'; readonly alias: string; readonly username?: string; readonly port?: number; readonly name: string }
	| { readonly kind: 'host'; readonly host: string; readonly username: string; readonly port?: number; readonly name: string };

export interface IAddDeviceAddressPlan {
	readonly address: string;
	readonly connectionToken?: string;
	readonly name: string;
}

/**
 * What the SSH form asks for is what an SSH user already knows: where the
 * machine is. An alias out of their own config is answer enough — the service
 * resolves the user, the port and the key from it — and anything else needs
 * the user name, because a connection cannot be opened without one.
 */
export function planSshDevice(fields: IAddDeviceFields, aliases: readonly string[]): AddDevicePlan<AddDeviceSshPlan> {
	const raw = fields.sshHost.trim();
	if (!raw) {
		return { error: localize('agentSettings.remoteHosts.addSshEmpty', "Enter a host name, or an alias from your SSH config.") };
	}
	const target = splitSshTarget(raw);
	if (!target) {
		return { error: localize('agentSettings.remoteHosts.addSshInvalid', "Enter the host as 'host', 'user@host' or 'host:port'.") };
	}
	const typedPort = parsePortField(fields.sshPort);
	if (typedPort.error) {
		return { error: typedPort.error };
	}
	const username = fields.sshUser.trim() || target.username;
	const port = typedPort.port ?? target.port;
	if (aliases.includes(target.host)) {
		return { plan: { kind: 'alias', alias: target.host, username, port, name: target.host } };
	}
	if (!username) {
		return { error: localize('agentSettings.remoteHosts.addSshNoUser', "Enter the user name to sign in as on '{0}'.", target.host) };
	}
	return { plan: { kind: 'host', host: target.host, username, port, name: `${username}@${target.host}` } };
}

/**
 * The address form takes what the existing command takes, parsed by the same
 * function, so a link pasted into either lands on the same host. A token typed
 * into its own field wins over one carried in the address: the field is the
 * one the user just answered.
 */
export function planAddressDevice(fields: IAddDeviceFields): AddDevicePlan<IAddDeviceAddressPlan> {
	const result = parseRemoteAgentHostInput(fields.address);
	if (result.error === RemoteAgentHostInputValidationError.Empty) {
		return { error: localize('agentSettings.remoteHosts.addAddressEmpty', "Enter a host and port, for example {0}.", '127.0.0.1:8089') };
	}
	if (!result.parsed) {
		return { error: localize('agentSettings.remoteHosts.addAddressInvalid', "Enter a host, a host and port, or a WebSocket address.") };
	}
	const token = fields.token.trim();
	return {
		plan: {
			address: result.parsed.address,
			connectionToken: token || result.parsed.connectionToken,
			name: result.parsed.suggestedName,
		},
	};
}

/** `[user@]host[:port]`, as `parseSSHHostInput` reads it for the SSH command. */
function splitSshTarget(value: string): { readonly username?: string; readonly host: string; readonly port?: number } | undefined {
	const at = value.indexOf('@');
	if (at === 0 || at === value.length - 1) {
		return undefined;
	}
	const username = at === -1 ? undefined : value.substring(0, at);
	const rest = at === -1 ? value : value.substring(at + 1);
	const colon = rest.lastIndexOf(':');
	if (colon === -1) {
		return { username, host: rest };
	}
	const host = rest.substring(0, colon);
	if (!host) {
		return undefined;
	}
	const port = parsePortField(rest.substring(colon + 1));
	return port.error ? undefined : { username, host, port: port.port };
}

function parsePortField(value: string): { readonly port?: number; readonly error?: string } {
	const trimmed = value.trim();
	if (!trimmed) {
		return {};
	}
	const port = Number(trimmed);
	return Number.isInteger(port) && port > 0 && port <= 65535
		? { port }
		: { error: localize('agentSettings.remoteHosts.addPortInvalid', "Enter a port between 1 and 65535.") };
}

/**
 * What the panel needs from the page. As with the other sections, every piece
 * of state is the page's and every call goes back to it: the page owns the
 * services, so the panel reaches a device through exactly the paths the
 * `sessions.remoteAgentHost.*` commands do.
 */
export interface IRemoteHostsAddDeviceContext {
	readonly store: DisposableStore;
	readonly step: AddDeviceStep;
	readonly fields: IAddDeviceFields;
	readonly capabilities: IAddDeviceCapabilities;
	/** The dev tunnel account, as the Advanced section reads it. */
	readonly account: DevTunnelAccount;
	/** The connectable tunnels — not Advanced's list, which counts every tunnel on the account. */
	readonly tunnels: DevTunnelList;
	readonly distros: WslDistroList;
	/** `Host` blocks from the user's SSH config, if they have been read yet. */
	readonly sshAliases: readonly string[];
	readonly sharingInfo: ITunnelHostInfo | undefined;
	chooseType(type: AddDeviceType): void;
	/** Step 2 → step 1. */
	back(): void;
	cancel(): void;
	setField(name: keyof IAddDeviceFields, value: string): void;
	/** Report a form the panel will not submit; the page keeps the message. */
	fail(message: string): void;
	loadAccount(): void;
	signIn(providerId: TunnelAuthProvider, scopes: readonly string[]): void;
	loadTunnels(): void;
	loadDistros(): void;
	connectTunnel(tunnel: ITunnelInfo): void;
	addSsh(plan: AddDeviceSshPlan): void;
	addWsl(distro: IWSLDistro): void;
	addAddress(plan: IAddDeviceAddressPlan): void;
}

/**
 * Adding a device, on the page it is added to.
 *
 * Step 1 asks how the device is reached; step 2 asks only what that way of
 * reaching it cannot work out for itself. Whatever goes wrong is said here,
 * next to the field that caused it — a modal error would take the answer away
 * from the form the user is still filling in.
 */
export function renderAddDevice(container: HTMLElement, ctx: IRemoteHostsAddDeviceContext): HTMLElement | undefined {
	const step = ctx.step;
	if (step.kind === 'closed') {
		return undefined;
	}

	const panel = appendCard(container, 'agent-settings-add-device');
	const header = DOM.append(panel, $('.agent-settings-add-header'));
	DOM.append(header, $('.agent-settings-add-title')).textContent = step.kind === 'type'
		? localize('agentSettings.remoteHosts.addTitle', "Add a device")
		: addDeviceTypeLabel(step.type);

	const headerActions = DOM.append(header, $('.agent-settings-inline-actions'));
	if (step.kind === 'form') {
		appendLinkButton(ctx.store, headerActions, localize('agentSettings.remoteHosts.addBack', "Back"), () => ctx.back());
	}
	appendLinkButton(ctx.store, headerActions, localize('agentSettings.remoteHosts.addCancel', "Cancel"), () => ctx.cancel());

	if (step.kind === 'type') {
		renderTypeChoices(panel, ctx);
		return panel;
	}

	const body = DOM.append(panel, $('.agent-settings-add-body'));
	const enabled = !step.busy;
	switch (step.type) {
		case 'tunnel':
			renderTunnelStep(body, ctx, enabled);
			break;
		case 'ssh':
			renderSshStep(body, ctx, enabled);
			break;
		case 'wsl':
			renderWslStep(body, ctx, enabled);
			break;
		case 'address':
			renderAddressStep(body, ctx, enabled);
			break;
	}

	if (step.busy) {
		DOM.append(panel, $('.agent-settings-add-busy')).textContent =
			localize('agentSettings.remoteHosts.addBusy', "Connecting…");
	}
	if (step.error) {
		DOM.append(panel, $('.agent-settings-add-error')).textContent = step.error;
	}
	return panel;
}

function renderTypeChoices(panel: HTMLElement, ctx: IRemoteHostsAddDeviceContext): void {
	DOM.append(panel, $('.agent-settings-add-detail')).textContent =
		localize('agentSettings.remoteHosts.addDetail', "Choose how this machine reaches it.");
	const list = DOM.append(panel, $('.agent-settings-add-choices'));
	for (const choice of addDeviceChoices(ctx.capabilities)) {
		const button = DOM.append(list, $('button.agent-settings-add-choice', { type: 'button' }));
		appendIcon(button, choice.icon, 'agent-settings-add-choice-icon');
		const labels = DOM.append(button, $('.agent-settings-add-choice-labels'));
		DOM.append(labels, $('.agent-settings-add-choice-label')).textContent = choice.label;
		DOM.append(labels, $('.agent-settings-add-choice-detail')).textContent = choice.detail;
		ctx.store.add(DOM.addDisposableListener(button, 'click', () => ctx.chooseType(choice.type)));
	}
}

function renderTunnelStep(body: HTMLElement, ctx: IRemoteHostsAddDeviceContext, enabled: boolean): void {
	const block = accountBlock(ctx.account);
	if (block) {
		appendNote(body, block.message);
		if (block.kind === 'signIn') {
			appendLinkButton(
				ctx.store,
				DOM.append(body, $('.agent-settings-add-actions')),
				localize('agentSettings.remoteHosts.addSignIn', "Sign in"),
				() => ctx.signIn(block.providerId, block.scopes),
			);
		} else if (block.kind === 'retry') {
			appendLinkButton(
				ctx.store,
				DOM.append(body, $('.agent-settings-add-actions')),
				localize('agentSettings.remoteHosts.addRetry', "Try again"),
				() => ctx.loadAccount(),
			);
		} else if (ctx.account.kind === 'unknown') {
			ctx.loadAccount();
		}
		return;
	}

	const state = ctx.tunnels;
	if (state.kind === 'unknown' || state.kind === 'loading') {
		appendNote(body, localize('agentSettings.remoteHosts.addTunnelsLoading', "Looking for devices on your account…"));
		if (state.kind === 'unknown') {
			ctx.loadTunnels();
		}
		return;
	}

	if (state.kind === 'failed') {
		appendNote(body, localize('agentSettings.remoteHosts.addTunnelsFailed', "Could not look for devices on your account."));
		appendNote(body, state.message);
		const actions = DOM.append(body, $('.agent-settings-add-actions'));
		appendLinkButton(ctx.store, actions, localize('agentSettings.remoteHosts.addRetry', "Try again"), () => ctx.loadTunnels());
		return;
	}

	const tunnels = selectAddableTunnels(state.tunnels, ctx.sharingInfo);
	if (tunnels.length === 0) {
		appendNote(body, localize('agentSettings.remoteHosts.addTunnelsNone', "No other device on your account is accepting connections."));
		appendNote(body, localize('agentSettings.remoteHosts.addTunnelsNoneDetail', "Open Fumie on that computer and let it accept connections, then refresh."));
	} else {
		const list = DOM.append(body, $('.agent-settings-add-list'));
		for (const tunnel of tunnels) {
			appendPickRow(ctx, list, Codicon.cloud, tunnel.name, tunnelRowDetail(tunnel), enabled, () => ctx.connectTunnel(tunnel));
		}
	}

	const actions = DOM.append(body, $('.agent-settings-add-actions'));
	appendLinkButton(ctx.store, actions, localize('agentSettings.remoteHosts.addRefresh', "Refresh"), () => ctx.loadTunnels());
}

function renderSshStep(body: HTMLElement, ctx: IRemoteHostsAddDeviceContext, enabled: boolean): void {
	const submit = () => {
		const result = planSshDevice(ctx.fields, ctx.sshAliases);
		if (result.error !== undefined) {
			ctx.fail(result.error);
			return;
		}
		ctx.addSsh(result.plan);
	};

	const form = DOM.append(body, $('.agent-settings-add-form'));
	appendField(ctx, form, 'sshHost', localize('agentSettings.remoteHosts.addSshHost', "Host"), 'user@host', submit);
	appendField(ctx, form, 'sshUser', localize('agentSettings.remoteHosts.addSshUser', "User"), localize('agentSettings.remoteHosts.addOptional', "Optional"), submit);
	appendField(ctx, form, 'sshPort', localize('agentSettings.remoteHosts.addSshPort', "Port"), '22', submit);
	if (ctx.sshAliases.length > 0) {
		appendNote(body, localize('agentSettings.remoteHosts.addSshAliases', "A host from your SSH config brings its own user, port and key."));
	}
	const actions = DOM.append(body, $('.agent-settings-add-actions'));
	appendFormButton(ctx.store, actions, localize('agentSettings.remoteHosts.addConnect', "Connect"), enabled, true, submit);
}

function renderWslStep(body: HTMLElement, ctx: IRemoteHostsAddDeviceContext, enabled: boolean): void {
	const state = ctx.distros;
	switch (state.kind) {
		case 'unknown':
		case 'loading':
			appendNote(body, localize('agentSettings.remoteHosts.addWslLoading', "Looking for Linux distributions…"));
			if (state.kind === 'unknown') {
				ctx.loadDistros();
			}
			return;
		case 'unavailable':
			appendNote(body, localize('agentSettings.remoteHosts.addWslUnavailable', "Windows Subsystem for Linux is not installed or not turned on."));
			return;
		case 'failed': {
			appendNote(body, localize('agentSettings.remoteHosts.addWslFailed', "Could not list the Linux distributions on this machine."));
			appendNote(body, state.message);
			const actions = DOM.append(body, $('.agent-settings-add-actions'));
			appendLinkButton(ctx.store, actions, localize('agentSettings.remoteHosts.addRetry', "Try again"), () => ctx.loadDistros());
			return;
		}
		case 'loaded': {
			if (state.distros.length === 0) {
				appendNote(body, localize('agentSettings.remoteHosts.addWslNone', "No WSL 2 distribution is installed."));
				return;
			}
			const list = DOM.append(body, $('.agent-settings-add-list'));
			for (const distro of state.distros) {
				appendPickRow(ctx, list, Codicon.terminalLinux, distro.name, wslDistroDetail(distro), enabled, () => ctx.addWsl(distro));
			}
			return;
		}
	}
}

function renderAddressStep(body: HTMLElement, ctx: IRemoteHostsAddDeviceContext, enabled: boolean): void {
	const submit = () => {
		const result = planAddressDevice(ctx.fields);
		if (result.error !== undefined) {
			ctx.fail(result.error);
			return;
		}
		ctx.addAddress(result.plan);
	};

	const form = DOM.append(body, $('.agent-settings-add-form'));
	appendField(ctx, form, 'address', localize('agentSettings.remoteHosts.addAddressLabel', "Address"), '127.0.0.1:8089', submit);
	appendField(ctx, form, 'token', localize('agentSettings.remoteHosts.addTokenLabel', "Token"), localize('agentSettings.remoteHosts.addOptional', "Optional"), submit);
	const actions = DOM.append(body, $('.agent-settings-add-actions'));
	appendFormButton(ctx.store, actions, localize('agentSettings.remoteHosts.addSubmit', "Add"), enabled, true, submit);
}

function appendField(
	ctx: IRemoteHostsAddDeviceContext,
	parent: HTMLElement,
	name: keyof IAddDeviceFields,
	label: string,
	placeholder: string | undefined,
	submit: () => void,
): void {
	const field = DOM.append(parent, $('.agent-settings-add-field'));
	DOM.append(field, $('.agent-settings-add-field-label')).textContent = label;
	const host = DOM.append(field, $('.agent-settings-input'));
	// No context view: this panel reports its own failures inline, and an input
	// that popped its own message over the card would say it twice.
	const input = ctx.store.add(new InputBox(host, undefined, {
		inputBoxStyles: defaultInputBoxStyles,
		ariaLabel: label,
		placeholder,
	}));
	input.value = ctx.fields[name];
	// Every keystroke goes back to the page: this element is thrown away and
	// rebuilt whenever anything the page watches changes.
	ctx.store.add(input.onDidChange(value => ctx.setField(name, value)));
	ctx.store.add(DOM.addDisposableListener(input.inputElement, 'keydown', (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			submit();
		}
	}));
}

function appendPickRow(
	ctx: IRemoteHostsAddDeviceContext,
	list: HTMLElement,
	icon: ThemeIcon,
	name: string,
	detail: string,
	enabled: boolean,
	onPick: () => void,
): void {
	const row = DOM.append(list, $('.agent-settings-add-row'));
	appendIcon(row, icon, 'agent-settings-add-row-icon');
	const labels = DOM.append(row, $('.agent-settings-add-row-labels'));
	DOM.append(labels, $('.agent-settings-add-row-name')).textContent = name;
	DOM.append(labels, $('.agent-settings-add-row-detail')).textContent = detail;
	const actions = DOM.append(row, $('.agent-settings-inline-actions'));
	appendFormButton(ctx.store, actions, localize('agentSettings.remoteHosts.addConnect', "Connect"), enabled, false, onPick);
}

/**
 * A button that goes flat while a connection is being made.
 * {@link appendLinkButton} keeps no handle on its `Button`, and a control that
 * stays live during a connect invites a second one.
 */
function appendFormButton(
	store: DisposableStore,
	parent: HTMLElement,
	label: string,
	enabled: boolean,
	primary: boolean,
	onClick: () => void,
): void {
	const host = DOM.append(parent, $('.agent-settings-button-host'));
	const button = store.add(new Button(host, primary ? defaultButtonStyles : { ...defaultButtonStyles, secondary: true }));
	button.label = label;
	button.enabled = enabled;
	store.add(button.onDidClick(() => onClick()));
}

function appendNote(parent: HTMLElement, text: string): void {
	DOM.append(parent, $('.agent-settings-add-note')).textContent = text;
}
