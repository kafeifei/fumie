/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IMobileClientInfo, ITunnelHostInfo } from '../../../../../platform/agentHost/common/tunnelAgentHost.js';
import type { IConfirmation } from '../../../../../platform/dialogs/common/dialogs.js';
import { connectedDeviceRows, renderThisMachine } from '../../browser/remoteHostsThisMachine.js';

/**
 * The pairing card: the address, as something a phone can act on.
 *
 * The remote address is the only one worth scanning, so the code appears with
 * it and nowhere else — and when it is missing the card still has to say why
 * rather than fall silent.
 */
suite('Sessions - Agent Settings This Machine card', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const remoteUrl = 'https://abcdefgh-9999.usw2.devtunnels.ms/?pairing=0123456789abcdef0123456789abcdef';

	interface IRenderOptions {
		readonly sharing?: boolean;
		readonly sharingInfo?: ITunnelHostInfo;
		/**
		 * Left out entirely, the page supplied no way to list clients and the
		 * card must draw no list at all — which is not the same as an empty one.
		 */
		readonly clients?: readonly IMobileClientInfo[];
		readonly confirm?: boolean;
		readonly disconnectError?: Error;
	}

	function render(options: IRenderOptions = {}) {
		const store = disposables.add(new DisposableStore());
		const container = document.createElement('div');
		const copied: string[] = [];
		const opened: string[] = [];
		const confirmations: IConfirmation[] = [];
		const disconnected: string[] = [];
		const errors: string[] = [];
		const listed = options.clients ?? [];
		const onDidChangeClients = store.add(new Emitter<readonly IMobileClientInfo[]>());

		renderThisMachine(container, {
			store,
			sharing: options.sharing ?? true,
			connecting: false,
			sharingInfo: options.sharingInfo,
			contextMenuService: { showContextMenu: () => { } } as never,
			clients: options.clients === undefined ? undefined : {
				tunnelHostService: {
					onDidChangeClients: onDidChangeClients.event,
					listClients: async () => listed,
					disconnectClient: async (id: string) => {
						disconnected.push(id);
						if (options.disconnectError) {
							throw options.disconnectError;
						}
					},
				} as never,
				dialogService: {
					confirm: async (confirmation: IConfirmation) => {
						confirmations.push(confirmation);
						return { confirmed: options.confirm ?? true };
					},
					error: async (message: string) => { errors.push(message); },
				} as never,
			},
			setSharing: () => { },
			copy: text => copied.push(text),
			open: url => opened.push(url),
			resetAccessLink: () => { },
		});

		return {
			container,
			copied,
			opened,
			confirmations,
			disconnected,
			errors,
			fireClients: (clients: readonly IMobileClientInfo[]) => onDidChangeClients.fire(clients),
		};
	}

	/**
	 * The list is drawn when `listClients` answers, and Disconnect acts only
	 * once the dialog has — both a handful of microtasks after the call.
	 */
	async function settle(): Promise<void> {
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}
	}

	function clientRows(container: HTMLElement): { name: string; detail: string }[] {
		return Array.from(container.querySelectorAll('.agent-settings-client-row')).map(row => ({
			name: row.querySelector('.agent-settings-client-name')?.textContent ?? '',
			detail: row.querySelector('.agent-settings-client-detail')?.textContent ?? '',
		}));
	}

	function buttons(container: HTMLElement): string[] {
		return Array.from(container.querySelectorAll('.monaco-button')).map(button => button.textContent ?? '');
	}

	function clickButton(container: HTMLElement, label: string): void {
		const button = Array.from(container.querySelectorAll('.monaco-button'))
			.find(candidate => candidate.textContent === label);
		assert.ok(button, `expected a '${label}' button, got: ${buttons(container).join(' | ')}`);
		(button as HTMLElement).click();
	}

	test('the remote address is offered as a code to scan and a link to copy', () => {
		const { container, copied } = render({ sharingInfo: { tunnelName: 'this-mac', mobileUrl: remoteUrl } });

		const figure = container.querySelector('.agent-settings-qr');
		assert.ok(figure, 'expected the pairing code');
		assert.ok(figure.querySelector('svg'), 'the code is drawn here, not fetched');
		assert.strictEqual(
			container.querySelector('.agent-settings-qr-row .agent-settings-link-title')?.textContent,
			'Scan with your phone, or copy the link');

		clickButton(container, 'Copy Link');
		assert.deepStrictEqual(copied, [remoteUrl]);
	});

	test('the address itself is not spelled across the card, only hidden in reach', () => {
		// A capability URL read out in full teaches nobody anything and is the
		// one thing a shoulder-surfer can use.
		const { container } = render({ sharingInfo: { tunnelName: 'this-mac', mobileUrl: remoteUrl } });

		assert.strictEqual(container.querySelector('.agent-settings-link-url'), null);
		assert.strictEqual(container.querySelector('.agent-settings-qr svg title')?.textContent, remoteUrl);
	});

	test('a local-only address keeps the rows that say why, and draws no code', () => {
		const { container, copied } = render({
			sharingInfo: {
				tunnelName: 'this-mac',
				mobileLocalUrl: 'http://127.0.0.1:4321/',
				mobileUrlUnavailableReason: 'tunnel quota reached',
			},
		});

		assert.strictEqual(container.querySelector('.agent-settings-qr'), null, 'a loopback address is not worth scanning');
		const detail = Array.from(container.querySelectorAll('.agent-settings-link-detail')).map(node => node.textContent);
		assert.ok(
			detail.some(text => text?.includes('tunnel quota reached')),
			`expected the reason to survive, got: ${detail.join(' | ')}`);
		assert.ok(detail.some(text => text?.includes('http://127.0.0.1:4321/')), 'the local address is still offered');

		clickButton(container, 'Copy local link');
		assert.deepStrictEqual(copied, ['http://127.0.0.1:4321/']);
	});

	test('sharing that is off draws no address at all', () => {
		const { container } = render({ sharing: false, sharingInfo: undefined });

		assert.strictEqual(container.querySelector('.agent-settings-card-body'), null);
		assert.strictEqual(container.querySelector('.agent-settings-qr'), null);
		assert.strictEqual(
			container.querySelector('.agent-settings-card-subline')?.textContent,
			'Off. No other device can reach this machine.');
	});

	/**
	 * The connected devices list: who is holding this machine right now.
	 *
	 * The list is the only place a user finds out that something is connected
	 * at all, so what it says about each device has to be enough to decide with
	 * — what it is, how it got in, and how long it has been there.
	 */
	suite('connected devices', () => {

		function client(overrides: Partial<IMobileClientInfo> & Pick<IMobileClientInfo, 'id'>): IMobileClientInfo {
			return {
				label: 'iPhone (Safari)',
				connectedAt: Date.now() - 5 * 60 * 1000,
				transport: 'tunnel',
				...overrides,
			};
		}

		test('the newest device leads, and each row says how it got in', () => {
			const rows = connectedDeviceRows([
				client({ id: 'client-1', label: 'Chrome', transport: 'local', connectedAt: Date.now() - 2 * 60 * 60 * 1000 }),
				client({ id: 'client-2', label: 'iPhone (Safari)', transport: 'tunnel', connectedAt: Date.now() - 5 * 60 * 1000 }),
			]);

			assert.deepStrictEqual(rows.map(row => row.id), ['client-2', 'client-1']);
			assert.deepStrictEqual(rows.map(row => row.label), ['iPhone (Safari)', 'Chrome']);
			assert.deepStrictEqual(rows.map(row => row.detail), [
				'Through the link · connected 5 mins ago',
				'On this machine · connected 2 hrs ago',
			]);
		});

		test('devices that arrived in the same millisecond keep a fixed order', () => {
			// Two tabs opened together share a timestamp; a list that reshuffles
			// between redraws is one you press the wrong Disconnect in.
			const connectedAt = Date.now() - 60 * 1000;
			const first = connectedDeviceRows([client({ id: 'client-9', connectedAt }), client({ id: 'client-3', connectedAt })]);
			const second = connectedDeviceRows([client({ id: 'client-3', connectedAt }), client({ id: 'client-9', connectedAt })]);

			assert.deepStrictEqual(first.map(row => row.id), ['client-3', 'client-9']);
			assert.deepStrictEqual(second.map(row => row.id), first.map(row => row.id));
		});

		test('every connected device is listed with a way to cut it off', async () => {
			const { container } = render({
				sharingInfo: { tunnelName: 'this-mac', mobileUrl: remoteUrl },
				clients: [
					client({ id: 'client-1', label: 'Chrome', transport: 'local', connectedAt: Date.now() - 2 * 60 * 60 * 1000 }),
					client({ id: 'client-2', connectedAt: Date.now() - 5 * 60 * 1000 }),
				],
			});
			await settle();

			assert.strictEqual(
				container.querySelector('.agent-settings-clients-title')?.textContent,
				'Connected devices');
			assert.deepStrictEqual(clientRows(container), [
				{ name: 'iPhone (Safari)', detail: 'Through the link · connected 5 mins ago' },
				{ name: 'Chrome', detail: 'On this machine · connected 2 hrs ago' },
			]);
			assert.strictEqual(
				buttons(container).filter(label => label === 'Disconnect').length,
				2,
				'each row is actionable on its own');
		});

		test('disconnecting names the device, says what it costs, and only then cuts it off', async () => {
			const { container, confirmations, disconnected } = render({
				sharingInfo: { tunnelName: 'this-mac', mobileUrl: remoteUrl },
				clients: [client({ id: 'client-2' })],
			});
			await settle();

			clickButton(container, 'Disconnect');
			await settle();

			assert.strictEqual(confirmations.length, 1);
			assert.strictEqual(confirmations[0].message, `Disconnect 'iPhone (Safari)'?`);
			assert.strictEqual(
				confirmations[0].detail,
				'That device stops controlling this machine until someone opens the link on it again.');
			assert.strictEqual(confirmations[0].primaryButton, 'Disconnect');
			assert.deepStrictEqual(disconnected, ['client-2']);
		});

		test('a confirmation that is refused leaves the device connected', async () => {
			const { container, disconnected } = render({
				sharingInfo: { tunnelName: 'this-mac', mobileUrl: remoteUrl },
				clients: [client({ id: 'client-2' })],
				confirm: false,
			});
			await settle();

			clickButton(container, 'Disconnect');
			await settle();

			assert.deepStrictEqual(disconnected, []);
		});

		test('a disconnect that fails is reported rather than swallowed', async () => {
			// A control that silently does nothing leaves the user believing a
			// device is off this machine when it is still on it.
			const { container, errors } = render({
				sharingInfo: { tunnelName: 'this-mac', mobileUrl: remoteUrl },
				clients: [client({ id: 'client-2' })],
				disconnectError: new Error('the host went away'),
			});
			await settle();

			clickButton(container, 'Disconnect');
			await settle();

			assert.deepStrictEqual(errors, [`Could not disconnect 'iPhone (Safari)'.`]);
		});

		test('sharing with nobody on it says so once, quietly', async () => {
			const { container } = render({
				sharingInfo: { tunnelName: 'this-mac', mobileUrl: remoteUrl },
				clients: [],
			});
			await settle();

			assert.deepStrictEqual(clientRows(container), []);
			const empty = container.querySelectorAll('.agent-settings-client-empty');
			assert.strictEqual(empty.length, 1);
			assert.strictEqual(empty[0].textContent, 'No devices connected');
			assert.strictEqual(buttons(container).includes('Disconnect'), false);
		});

		test('a device that arrives while the page sits still joins the list', async () => {
			const { container, fireClients } = render({
				sharingInfo: { tunnelName: 'this-mac', mobileUrl: remoteUrl },
				clients: [],
			});
			await settle();
			assert.strictEqual(container.querySelectorAll('.agent-settings-client-empty').length, 1);

			fireClients([client({ id: 'client-1', connectedAt: Date.now() })]);

			assert.deepStrictEqual(clientRows(container).map(row => row.name), ['iPhone (Safari)']);
			assert.strictEqual(container.querySelector('.agent-settings-client-empty'), null);

			fireClients([]);

			assert.deepStrictEqual(clientRows(container), []);
			assert.strictEqual(container.querySelectorAll('.agent-settings-client-empty').length, 1);
		});

		test('sharing that is off lists nobody', async () => {
			const { container } = render({ sharing: false, clients: [client({ id: 'client-1' })] });
			await settle();

			assert.strictEqual(container.querySelector('.agent-settings-clients'), null);
			assert.deepStrictEqual(clientRows(container), []);
		});

		test('a page that cannot list clients draws no list, not an empty one', async () => {
			const { container } = render({ sharingInfo: { tunnelName: 'this-mac', mobileUrl: remoteUrl } });
			await settle();

			assert.strictEqual(container.querySelector('.agent-settings-clients'), null);
			assert.strictEqual(container.querySelector('.agent-settings-client-empty'), null);
		});
	});
});
