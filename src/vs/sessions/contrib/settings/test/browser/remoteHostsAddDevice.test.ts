/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ITunnelHostInfo, ITunnelInfo } from '../../../../../platform/agentHost/common/tunnelAgentHost.js';
import type { IWSLDistro } from '../../../../../platform/agentHost/common/wslRemoteAgentHost.js';
import type { DevTunnelAccount, DevTunnelList } from '../../browser/remoteHostsAdvanced.js';
import {
	accountBlock,
	addDeviceChoices,
	emptyAddDeviceFields,
	planAddressDevice,
	planSshDevice,
	renderAddDevice,
	selectAddableTunnels,
	wslDistroDetail,
	type AddDeviceSshPlan,
	type AddDeviceStep,
	type AddDeviceType,
	type IAddDeviceAddressPlan,
	type IAddDeviceCapabilities,
	type IAddDeviceFields,
	type WslDistroList,
} from '../../browser/remoteHostsAddDevice.js';

/**
 * Adding a device without leaving the page.
 *
 * The decisions are exported and asserted on their own because each of them is
 * a way to reach a machine that this client may not have: a browser cannot open
 * an SSH socket, only Windows has WSL, and an SSH host that is not in the
 * user's config needs a user name that nothing else can supply. The rendering
 * tests then check the one property the panel exists for — that every failure
 * lands in the panel, beside the form, rather than in a dialog over it.
 */
suite('Sessions - Agent Settings Add Device', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const signedIn: DevTunnelAccount = { kind: 'signedIn', providerId: 'github', sessionId: 's1', label: 'octocat' };

	function tunnel(overrides: Partial<ITunnelInfo> & Pick<ITunnelInfo, 'tunnelId' | 'name'>): ITunnelInfo {
		return {
			clusterId: 'use',
			tags: ['vscode-server-launcher', 'protocolv6'],
			protocolVersion: 6,
			hostConnectionCount: 0,
			...overrides,
		};
	}

	function distro(name: string, overrides: Partial<IWSLDistro> = {}): IWSLDistro {
		return { name, isDefault: false, isRunning: false, version: 2, ...overrides };
	}

	interface IRenderOptions {
		readonly step: AddDeviceStep;
		readonly fields?: Partial<IAddDeviceFields>;
		readonly capabilities?: IAddDeviceCapabilities;
		readonly account?: DevTunnelAccount;
		readonly tunnels?: DevTunnelList;
		readonly distros?: WslDistroList;
		readonly sshAliases?: readonly string[];
		readonly sharingInfo?: ITunnelHostInfo;
	}

	function render(options: IRenderOptions) {
		const store = disposables.add(new DisposableStore());
		const container = document.createElement('div');
		const fields: IAddDeviceFields = { ...emptyAddDeviceFields(), ...(options.fields ?? {}) };
		const chosen: AddDeviceType[] = [];
		const events: string[] = [];
		const loads: string[] = [];
		const failures: string[] = [];
		const signIns: string[] = [];
		const connected: string[] = [];
		const ssh: AddDeviceSshPlan[] = [];
		const wsl: string[] = [];
		const addresses: IAddDeviceAddressPlan[] = [];

		renderAddDevice(container, {
			store,
			step: options.step,
			fields,
			capabilities: options.capabilities ?? { dialsOutFromClient: true, isWindows: true },
			account: options.account ?? signedIn,
			tunnels: options.tunnels ?? { kind: 'unknown' },
			distros: options.distros ?? { kind: 'unknown' },
			sshAliases: options.sshAliases ?? [],
			sharingInfo: options.sharingInfo,
			chooseType: type => chosen.push(type),
			back: () => events.push('back'),
			cancel: () => events.push('cancel'),
			setField: (name, value) => { fields[name] = value; },
			fail: message => failures.push(message),
			loadAccount: () => loads.push('account'),
			signIn: providerId => signIns.push(providerId),
			loadTunnels: () => loads.push('tunnels'),
			loadDistros: () => loads.push('distros'),
			connectTunnel: picked => connected.push(picked.tunnelId),
			addSsh: plan => ssh.push(plan),
			addWsl: picked => wsl.push(picked.name),
			addAddress: plan => addresses.push(plan),
		});

		return { container, fields, chosen, events, loads, failures, signIns, connected, ssh, wsl, addresses };
	}

	function buttons(container: HTMLElement): string[] {
		return Array.from(container.querySelectorAll('.monaco-button')).map(button => button.textContent ?? '');
	}

	function clickButton(container: HTMLElement, label: string, index = 0): void {
		const matches = Array.from(container.querySelectorAll('.monaco-button'))
			.filter(candidate => candidate.textContent === label);
		assert.ok(matches[index], `expected a '${label}' button at ${index}, got: ${buttons(container).join(' | ')}`);
		(matches[index] as HTMLElement).click();
	}

	function notes(container: HTMLElement): string[] {
		return Array.from(container.querySelectorAll('.agent-settings-add-note')).map(note => note.textContent ?? '');
	}

	function pickRows(container: HTMLElement): { name: string; detail: string }[] {
		return Array.from(container.querySelectorAll('.agent-settings-add-row')).map(row => ({
			name: row.querySelector('.agent-settings-add-row-name')?.textContent ?? '',
			detail: row.querySelector('.agent-settings-add-row-detail')?.textContent ?? '',
		}));
	}

	function typeInto(container: HTMLElement, index: number, value: string): void {
		const input = container.querySelectorAll('.agent-settings-add-field input')[index] as HTMLInputElement | undefined;
		assert.ok(input, `expected a field at ${index}`);
		input.value = value;
		input.dispatchEvent(new Event('input'));
	}

	test('a browser is offered only the two ways it can reach out', () => {
		// SSH and WSL dial out of the client process itself, which a browser
		// cannot do; the commands behind them are gated the same way.
		assert.deepStrictEqual(
			addDeviceChoices({ dialsOutFromClient: false, isWindows: false }).map(choice => choice.type),
			['tunnel', 'address'],
		);
	});

	test('WSL is offered on Windows and nowhere else', () => {
		assert.deepStrictEqual(
			addDeviceChoices({ dialsOutFromClient: true, isWindows: false }).map(choice => choice.type),
			['tunnel', 'ssh', 'address'],
		);
		assert.deepStrictEqual(
			addDeviceChoices({ dialsOutFromClient: true, isWindows: true }).map(choice => choice.type),
			['tunnel', 'ssh', 'wsl', 'address'],
		);
	});

	test('an SSH host is planned from what the fields say, in either place', () => {
		const fields = (overrides: Partial<IAddDeviceFields>): IAddDeviceFields => ({ ...emptyAddDeviceFields(), ...overrides });

		assert.deepStrictEqual(
			planSshDevice(fields({ sshHost: 'build-box', sshUser: 'ada' }), []).plan,
			{ kind: 'host', host: 'build-box', username: 'ada', port: undefined, name: 'ada@build-box' },
		);
		assert.deepStrictEqual(
			planSshDevice(fields({ sshHost: 'ada@build-box:2222' }), []).plan,
			{ kind: 'host', host: 'build-box', username: 'ada', port: 2222, name: 'ada@build-box' },
		);
		// The field the user just answered wins over the one carried in the host.
		assert.deepStrictEqual(
			planSshDevice(fields({ sshHost: 'ada@build-box:2222', sshPort: '2200' }), []).plan?.port,
			2200,
		);
	});

	test('a host from the SSH config is left to the config, which knows the rest', () => {
		assert.deepStrictEqual(
			planSshDevice({ ...emptyAddDeviceFields(), sshHost: 'build-box' }, ['build-box', 'ci']).plan,
			{ kind: 'alias', alias: 'build-box', username: undefined, port: undefined, name: 'build-box' },
		);
	});

	test('an SSH host that is nobody in particular is refused, in the panel', () => {
		// A connection cannot be opened without a user name, and the config has
		// no answer for a host it has never heard of.
		assert.strictEqual(planSshDevice({ ...emptyAddDeviceFields(), sshHost: 'build-box' }, []).plan, undefined);
		assert.ok(planSshDevice({ ...emptyAddDeviceFields(), sshHost: 'build-box' }, []).error?.includes('build-box'));
		assert.ok(planSshDevice(emptyAddDeviceFields(), []).error);
		assert.ok(
			planSshDevice({ ...emptyAddDeviceFields(), sshHost: 'build-box', sshUser: 'ada', sshPort: '70000' }, []).error?.includes('65535'),
		);
	});

	test('an address is parsed exactly as the command parses it', () => {
		const plan = planAddressDevice({ ...emptyAddDeviceFields(), address: 'ws://127.0.0.1:8089' }).plan;
		assert.deepStrictEqual(plan, { address: '127.0.0.1:8089', connectionToken: undefined, name: '127.0.0.1:8089' });

		assert.strictEqual(
			planAddressDevice({ ...emptyAddDeviceFields(), address: 'ws://127.0.0.1:8089?tkn=from-url' }).plan?.connectionToken,
			'from-url',
		);
		// The token field is the answer the user just gave.
		assert.strictEqual(
			planAddressDevice({ ...emptyAddDeviceFields(), address: 'ws://127.0.0.1:8089?tkn=from-url', token: ' typed ' }).plan?.connectionToken,
			'typed',
		);
		assert.ok(planAddressDevice(emptyAddDeviceFields()).error);
		// 'ws://' has no host in every URL implementation. A hostname with
		// spaces is NOT a safe invalid vector: Chromium percent-encodes the
		// spaces and parses it, though Node throws.
		assert.ok(planAddressDevice({ ...emptyAddDeviceFields(), address: 'ws://' }).error);
	});

	test('the tunnel this machine hosts is not a device to add', () => {
		const tunnels = [
			tunnel({ tunnelId: 'aaa', name: 'this-mac' }),
			tunnel({ tunnelId: 'bbb', name: 'old-laptop' }),
		];
		assert.deepStrictEqual(
			selectAddableTunnels(tunnels, { tunnelName: 'this-mac', tunnelId: 'aaa' }).map(t => t.tunnelId),
			['bbb'],
		);
		assert.deepStrictEqual(selectAddableTunnels(tunnels, undefined).map(t => t.tunnelId), ['aaa', 'bbb']);
	});

	test('every account state the page can be in says something', () => {
		assert.strictEqual(accountBlock(signedIn), undefined);
		assert.deepStrictEqual(
			[
				accountBlock({ kind: 'unknown' })?.kind,
				accountBlock({ kind: 'loading' })?.kind,
				accountBlock({ kind: 'signedOut', providerId: 'github', scopes: ['read:user'] })?.kind,
				accountBlock({ kind: 'unconfigured' })?.kind,
				accountBlock({ kind: 'unsupported' })?.kind,
				accountBlock({ kind: 'failed', message: '403 forbidden' })?.kind,
			],
			['checking', 'checking', 'signIn', 'unavailable', 'unavailable', 'retry'],
		);
		assert.strictEqual(accountBlock({ kind: 'failed', message: '403 forbidden' })?.message, '403 forbidden');
		assert.ok(accountBlock({ kind: 'signedOut', providerId: 'github', scopes: ['read:user'] })?.message.includes('GitHub'));
	});

	test('a stopped distribution says so, and the default one says that too', () => {
		assert.strictEqual(wslDistroDetail(distro('Ubuntu')), 'Stopped');
		assert.strictEqual(wslDistroDetail(distro('Ubuntu', { isRunning: true, isDefault: true })), 'Running · Default');
	});

	test('a shut panel draws nothing at all', () => {
		const { container } = render({ step: { kind: 'closed' } });
		assert.strictEqual(container.querySelector('.agent-settings-add-device'), null);
	});

	test('step one asks how the device is reached, and reports the answer', () => {
		const { container, chosen } = render({ step: { kind: 'type' } });

		const labels = Array.from(container.querySelectorAll('.agent-settings-add-choice-label')).map(node => node.textContent);
		assert.deepStrictEqual(labels, ['Remote device', 'SSH', 'WSL', 'Address']);

		(container.querySelectorAll('.agent-settings-add-choice')[1] as HTMLElement).click();
		assert.deepStrictEqual(chosen, ['ssh']);
	});

	test('cancelling collapses the panel rather than opening anything', () => {
		const { container, events } = render({ step: { kind: 'form', type: 'ssh' } });

		clickButton(container, 'Cancel');
		clickButton(container, 'Back');
		assert.deepStrictEqual(events, ['cancel', 'back']);
	});

	test('a signed-out account offers the sign-in and never asks for tunnels', () => {
		const { container, loads, signIns } = render({
			step: { kind: 'form', type: 'tunnel' },
			account: { kind: 'signedOut', providerId: 'github', scopes: ['read:user'] },
		});

		assert.ok(notes(container).some(note => note.includes('GitHub')), notes(container).join(' | '));
		clickButton(container, 'Sign in');
		assert.deepStrictEqual(signIns, ['github']);
		assert.ok(!loads.includes('tunnels'), 'a signed-out panel must not call the tunnel service');
	});

	test('a signed-in account is asked for its devices once, then lists the ones worth adding', () => {
		const { loads } = render({ step: { kind: 'form', type: 'tunnel' } });
		assert.deepStrictEqual(loads, ['tunnels']);

		const listed = render({
			step: { kind: 'form', type: 'tunnel' },
			sharingInfo: { tunnelName: 'this-mac', tunnelId: 'aaa' },
			tunnels: {
				kind: 'loaded',
				tunnels: [
					tunnel({ tunnelId: 'aaa', name: 'this-mac', hostConnectionCount: 1 }),
					tunnel({ tunnelId: 'bbb', name: 'old-laptop' }),
					tunnel({ tunnelId: 'ccc', name: 'ci-box', hostConnectionCount: 2 }),
				],
			},
		});

		assert.deepStrictEqual(pickRows(listed.container), [
			{ name: 'old-laptop', detail: 'Offline' },
			{ name: 'ci-box', detail: 'Online' },
		]);
		clickButton(listed.container, 'Connect', 1);
		assert.deepStrictEqual(listed.connected, ['ccc']);
	});

	test('an account with nothing on it says so, and keeps the way to look again', () => {
		const { container, loads } = render({
			step: { kind: 'form', type: 'tunnel' },
			tunnels: { kind: 'loaded', tunnels: [] },
		});

		assert.ok(notes(container).some(note => note.includes('accepting connections')), notes(container).join(' | '));
		clickButton(container, 'Refresh');
		assert.deepStrictEqual(loads, ['tunnels']);
	});

	test('a listing that failed keeps its reason in the panel', () => {
		const { container } = render({
			step: { kind: 'form', type: 'tunnel' },
			tunnels: { kind: 'failed', message: 'tunnel service unreachable' },
		});

		assert.ok(notes(container).includes('tunnel service unreachable'), notes(container).join(' | '));
		assert.deepStrictEqual(buttons(container), ['Back', 'Cancel', 'Try again']);
	});

	test('WSL lists the distributions this machine has', () => {
		const { container, wsl } = render({
			step: { kind: 'form', type: 'wsl' },
			distros: { kind: 'loaded', distros: [distro('Ubuntu', { isRunning: true, isDefault: true }), distro('Debian')] },
		});

		assert.deepStrictEqual(pickRows(container), [
			{ name: 'Ubuntu', detail: 'Running · Default' },
			{ name: 'Debian', detail: 'Stopped' },
		]);
		clickButton(container, 'Connect');
		assert.deepStrictEqual(wsl, ['Ubuntu']);
	});

	test('WSL that is not installed is said, not listed as empty', () => {
		const { container } = render({ step: { kind: 'form', type: 'wsl' }, distros: { kind: 'unavailable' } });

		assert.ok(notes(container).some(note => note.includes('not installed')), notes(container).join(' | '));
		assert.deepStrictEqual(pickRows(container), []);
	});

	test('what is typed goes back to the page, which is what redraws the form', () => {
		// The page redraws whenever a provider, the inventory or the tunnel host
		// changes; a half-filled form that lived only in these elements would be
		// emptied by an event the user never caused.
		const { container, fields } = render({ step: { kind: 'form', type: 'ssh' } });

		typeInto(container, 0, 'build-box');
		typeInto(container, 1, 'ada');
		assert.strictEqual(fields.sshHost, 'build-box');
		assert.strictEqual(fields.sshUser, 'ada');
	});

	test('a filled SSH form submits the plan the fields make', () => {
		const { container, ssh, failures } = render({
			step: { kind: 'form', type: 'ssh' },
			fields: { sshHost: 'build-box', sshUser: 'ada' },
		});

		clickButton(container, 'Connect');
		assert.deepStrictEqual(failures, []);
		assert.deepStrictEqual(ssh, [{ kind: 'host', host: 'build-box', username: 'ada', port: undefined, name: 'ada@build-box' }]);
	});

	test('a form that cannot be submitted says why in the panel, and adds nothing', () => {
		const ssh = render({ step: { kind: 'form', type: 'ssh' } });
		clickButton(ssh.container, 'Connect');
		assert.strictEqual(ssh.ssh.length, 0);
		assert.strictEqual(ssh.failures.length, 1, 'the reason belongs beside the field, not in a dialog');

		const address = render({ step: { kind: 'form', type: 'address' }, fields: { address: 'ws://' } });
		clickButton(address.container, 'Add');
		assert.strictEqual(address.addresses.length, 0);
		assert.strictEqual(address.failures.length, 1);
	});

	test('the reason a submit failed is drawn where the form is', () => {
		const { container } = render({
			step: { kind: 'form', type: 'address', error: 'Could not connect to 127.0.0.1:8089.' },
		});

		assert.strictEqual(
			container.querySelector('.agent-settings-add-error')?.textContent,
			'Could not connect to 127.0.0.1:8089.');
	});

	test('a submit in flight cannot be started twice', () => {
		const { container, addresses } = render({
			step: { kind: 'form', type: 'address', busy: true },
			fields: { address: '127.0.0.1:8089' },
		});

		assert.strictEqual(container.querySelector('.agent-settings-add-busy')?.textContent, 'Connecting…');
		clickButton(container, 'Add');
		assert.deepStrictEqual(addresses, []);
	});
});
