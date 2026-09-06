/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { LogLevel, NullLoggerService, NullLogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IAgentHostSharingRequest, ITunnelProcessCoordinator, ITunnelProcessMachineStatus, ITunnelProcessOutput, ITunnelProcessStatus } from '../../../remoteTunnel/node/tunnelProcessCoordinator.js';
import { TunnelMode, TunnelStatus } from '../../../remoteTunnel/common/remoteTunnel.js';
import { TunnelHostMainService, withMobileAddresses } from '../../node/tunnelHostMainService.js';

class TestTunnelProcessCoordinator implements ITunnelProcessCoordinator {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = new Emitter<ITunnelProcessStatus>();
	readonly onDidChangeStatus = this._onDidChangeStatus.event;
	readonly onDidOutput = Event.None as Event<ITunnelProcessOutput>;
	readonly onDidMachineStatus = Event.None as Event<ITunnelProcessMachineStatus>;

	constructor(private _status: ITunnelProcessStatus) {
	}

	lastSharingRequest: IAgentHostSharingRequest | undefined;
	sharingRequests: (IAgentHostSharingRequest | undefined)[] = [];
	failNextSharingRequest = false;

	getStatus(): ITunnelProcessStatus {
		return this._status;
	}

	getIntendedTunnelName(): string {
		return this._status.tunnelName ?? 'test_host';
	}

	setRemoteAccess(_mode: TunnelMode, _logLevel: LogLevel): Promise<void> {
		return Promise.resolve();
	}

	setAgentHostSharing(request: IAgentHostSharingRequest | undefined): Promise<void> {
		this.lastSharingRequest = request;
		this.sharingRequests.push(request);
		if (this.failNextSharingRequest) {
			this.failNextSharingRequest = false;
			return Promise.reject(new Error('coordinator refused the sharing intent'));
		}
		return Promise.resolve();
	}

	restart(): Promise<void> {
		return Promise.resolve();
	}

	setRemoteAccessStatus(_status: TunnelStatus): void {
	}

	setStatus(status: ITunnelProcessStatus): void {
		this._status = status;
		this._onDidChangeStatus.fire(status);
	}

	dispose(): void {
		this._onDidChangeStatus.dispose();
	}
}

suite('TunnelHostMainService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('becomes ready when the coordinator reports a connected tunnel', async () => {
		const coordinator = new TestTunnelProcessCoordinator({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'connecting', serviceInstallFailed: false });
		const loggerService = new NullLoggerService();
		const service = new TunnelHostMainService(
			loggerService,
			{ logsHome: URI.file('logs') } as INativeEnvironmentService,
			new NullLogService(),
			coordinator,
			{ agentHostDefaultFumieHome: undefined } as IProductService,
		);
		try {
			const startHosting = service.startHosting('token', 'github');
			coordinator.setStatus({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'connected', serviceInstallFailed: false });
			assert.deepStrictEqual(await startHosting, { tunnelName: 'agent' });
		} finally {
			service.dispose();
			coordinator.dispose();
			loggerService.dispose();
		}
	});

	test('forwards the auth provider so Microsoft accounts can host', async () => {
		const coordinator = new TestTunnelProcessCoordinator({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'connecting', serviceInstallFailed: false });
		const loggerService = new NullLoggerService();
		const service = new TunnelHostMainService(
			loggerService,
			{ logsHome: URI.file('logs') } as INativeEnvironmentService,
			new NullLogService(),
			coordinator,
			{ agentHostDefaultFumieHome: undefined } as IProductService,
		);
		try {
			const startHosting = service.startHosting('token', 'microsoft');
			coordinator.setStatus({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'connected', serviceInstallFailed: false });
			await startHosting;
			assert.deepStrictEqual(
				{ token: coordinator.lastSharingRequest?.token, authProvider: coordinator.lastSharingRequest?.authProvider },
				{ token: 'token', authProvider: 'microsoft' },
			);
		} finally {
			service.dispose();
			coordinator.dispose();
			loggerService.dispose();
		}
	});

	test('fails when the agent host exits before reporting connected', async () => {
		const coordinator = new TestTunnelProcessCoordinator({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'connecting', serviceInstallFailed: false });
		const loggerService = new NullLoggerService();
		const service = new TunnelHostMainService(
			loggerService,
			{ logsHome: URI.file('logs') } as INativeEnvironmentService,
			new NullLogService(),
			coordinator,
			{ agentHostDefaultFumieHome: undefined } as IProductService,
		);
		try {
			const startHosting = service.startHosting('token', 'github');
			coordinator.setStatus({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'disconnected', serviceInstallFailed: false });
			await assert.rejects(startHosting, /exited before it became ready/);
		} finally {
			service.dispose();
			coordinator.dispose();
			loggerService.dispose();
		}
	});

	test('clears the sharing intent when the agent host fails to start', async () => {
		const coordinator = new TestTunnelProcessCoordinator({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'connecting', serviceInstallFailed: false });
		const loggerService = new NullLoggerService();
		const service = new TunnelHostMainService(
			loggerService,
			{ logsHome: URI.file('logs') } as INativeEnvironmentService,
			new NullLogService(),
			coordinator,
			{ agentHostDefaultFumieHome: undefined } as IProductService,
		);
		try {
			const startHosting = service.startHosting('token', 'github');
			coordinator.setStatus({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'disconnected', serviceInstallFailed: false });
			await assert.rejects(startHosting, /exited before it became ready/);

			// A stale intent would let a later reconcile bring hosting online
			// even though the caller was told it failed.
			assert.deepStrictEqual(coordinator.sharingRequests.at(-1), undefined);
		} finally {
			service.dispose();
			coordinator.dispose();
			loggerService.dispose();
		}
	});

	test('clears the sharing intent when the coordinator rejects the request', async () => {
		const coordinator = new TestTunnelProcessCoordinator({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'connecting', serviceInstallFailed: false });
		const loggerService = new NullLoggerService();
		const service = new TunnelHostMainService(
			loggerService,
			{ logsHome: URI.file('logs') } as INativeEnvironmentService,
			new NullLogService(),
			coordinator,
			{ agentHostDefaultFumieHome: undefined } as IProductService,
		);
		try {
			coordinator.failNextSharingRequest = true;
			await assert.rejects(service.startHosting('token', 'github'), /refused the sharing intent/);
			assert.deepStrictEqual(coordinator.sharingRequests.at(-1), undefined);
		} finally {
			service.dispose();
			coordinator.dispose();
			loggerService.dispose();
		}
	});

	test('derives public status from sharing intent and coordinator state', async () => {
		const coordinator = new TestTunnelProcessCoordinator({ mode: 'remoteAccess', tunnelName: 'remote', connectionState: 'connected', serviceInstallFailed: false });
		const loggerService = new NullLoggerService();
		const service = new TunnelHostMainService(
			loggerService,
			{ logsHome: URI.file('logs') } as INativeEnvironmentService,
			new NullLogService(),
			coordinator,
			{ agentHostDefaultFumieHome: undefined } as IProductService,
		);
		try {
			const withoutRequest = await service.getStatus();
			coordinator.setStatus({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'connected', serviceInstallFailed: false });
			await service.startHosting('token', 'github');
			const requestedAgentHost = await service.getStatus();
			coordinator.setStatus({ mode: 'agentHost', tunnelName: 'agent', connectionState: 'connecting', serviceInstallFailed: false });
			const requestedConnecting = await service.getStatus();
			coordinator.setStatus({ mode: 'agentHost', tunnelName: undefined, connectionState: 'connected', serviceInstallFailed: false });
			const requestedWithoutName = await service.getStatus();
			coordinator.setStatus({ mode: 'remoteAccess', tunnelName: 'remote', connectionState: 'connected', serviceInstallFailed: false });
			const requestedRemoteAccess = await service.getStatus();
			coordinator.setStatus({ mode: 'service', tunnelName: 'service', connectionState: 'connected', serviceInstallFailed: false });
			const requestedService = await service.getStatus();

			assert.deepStrictEqual({
				withoutRequest,
				requestedConnecting,
				requestedWithoutName,
				requestedAgentHost,
				requestedRemoteAccess,
				requestedService,
			}, {
				withoutRequest: { active: false },
				requestedConnecting: { active: false },
				requestedWithoutName: { active: false },
				requestedAgentHost: { active: true, info: { tunnelName: 'agent' } },
				requestedRemoteAccess: { active: true, info: { tunnelName: 'remote', viaRemoteTunnelAccess: true } },
				requestedService: { active: true, info: { tunnelName: 'service', viaRemoteTunnelAccess: true } },
			});
		} finally {
			service.dispose();
			coordinator.dispose();
			loggerService.dispose();
		}
	});

	test('offers the loopback and the tunnel address separately', () => {
		assert.deepStrictEqual(
			withMobileAddresses({ tunnelName: 'agent' }, {
				active: true,
				localUrl: 'http://127.0.0.1:5000/m/cap',
				publicUrl: 'https://x-5000.usw3.devtunnels.ms/m/cap',
			}),
			{
				tunnelName: 'agent',
				mobileUrl: 'https://x-5000.usw3.devtunnels.ms/m/cap',
				mobileLocalUrl: 'http://127.0.0.1:5000/m/cap',
			});
	});

	/**
	 * A loopback address once stood in for the remote one when the tunnel
	 * failed, which sent the user to copy 127.0.0.1 onto a phone.
	 */
	test('does not pass the loopback address off as the remote one', () => {
		assert.deepStrictEqual(
			withMobileAddresses({ tunnelName: 'agent' }, { active: true, localUrl: 'http://127.0.0.1:5000/m/cap' }),
			{ tunnelName: 'agent', mobileLocalUrl: 'http://127.0.0.1:5000/m/cap' });
	});

	test('reports no address at all when mobile hosting never started', () => {
		assert.deepStrictEqual(withMobileAddresses({ tunnelName: 'agent' }, undefined), { tunnelName: 'agent' });
		assert.deepStrictEqual(withMobileAddresses({ tunnelName: 'agent' }, { active: false }), { tunnelName: 'agent' });
	});

	/**
	 * The settings page cannot tell "the tunnel is still coming" from "the tunnel
	 * will never come" unless the failure travels with the addresses. Without the
	 * reason it dropped the remote row entirely, which read as the feature not
	 * existing rather than as one address being unavailable.
	 */
	test('carries why the remote address is missing when the tunnel failed', () => {
		assert.deepStrictEqual(
			withMobileAddresses({ tunnelName: 'agent' }, {
				active: true,
				localUrl: 'http://127.0.0.1:5000/m/cap',
				publicUrlError: 'Resource limit exceeded for TunnelsPerUserPerCluster (10).',
			}),
			{
				tunnelName: 'agent',
				mobileLocalUrl: 'http://127.0.0.1:5000/m/cap',
				mobileUrlUnavailableReason: 'Resource limit exceeded for TunnelsPerUserPerCluster (10).',
			});
	});

	test('a remote address that did arrive carries no failure reason', () => {
		assert.deepStrictEqual(
			withMobileAddresses({ tunnelName: 'agent' }, {
				active: true,
				localUrl: 'http://127.0.0.1:5000/m/cap',
				publicUrl: 'https://x-5000.usw3.devtunnels.ms/m/cap',
				publicUrlError: 'stale failure from an earlier attempt',
			}),
			{
				tunnelName: 'agent',
				mobileUrl: 'https://x-5000.usw3.devtunnels.ms/m/cap',
				mobileLocalUrl: 'http://127.0.0.1:5000/m/cap',
			});
	});
});
