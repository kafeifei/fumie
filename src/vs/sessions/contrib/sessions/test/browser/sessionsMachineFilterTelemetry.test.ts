/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryServiceShape } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { AgentHostFilterConnectionStatus, AgentHostFilterScope, IAgentHostFilterEntry, IAgentHostFilterService } from '../../../../services/agentHostFilter/common/agentHostFilter.js';
import { SELECT_ALL_MACHINES_COMMAND_ID, SELECT_HOST_MACHINE_COMMAND_ID, SELECT_LOCAL_MACHINE_COMMAND_ID } from '../../browser/views/sessionsMachineFilter.js';

const MACHINE_FILTER_CHANGE_EVENT = 'vscodeAgents.sessionsList/machineFilterChange';

const ONLINE_HOST: IAgentHostFilterEntry = {
	providerId: 'agenthost-desk.internal:4321',
	label: 'Example',
	address: 'desk.internal:4321',
	status: AgentHostFilterConnectionStatus.Connected,
	hasLiveConnection: true,
};

const OFFLINE_HOST: IAgentHostFilterEntry = {
	providerId: 'agenthost-build.internal:4321',
	label: 'build-box',
	address: 'build.internal:4321',
	status: AgentHostFilterConnectionStatus.Disconnected,
	hasLiveConnection: false,
};

class StubAgentHostFilterService implements Partial<IAgentHostFilterService> {
	declare readonly _serviceBrand: undefined;

	scope: AgentHostFilterScope = { kind: 'all' };
	readonly reconnected: string[] = [];

	constructor(readonly hosts: readonly IAgentHostFilterEntry[]) { }

	setScope(scope: AgentHostFilterScope): void {
		if (scope.kind === 'host' && !this.hosts.some(host => host.providerId === scope.providerId)) {
			return;
		}
		this.scope = scope;
	}

	reconnect(providerId: string): void {
		this.reconnected.push(providerId);
	}
}

class TestTelemetryService extends NullTelemetryServiceShape {
	readonly events: { readonly eventName: string; readonly data: unknown }[] = [];

	override publicLog2(eventName?: string, data?: unknown): void {
		if (eventName === MACHINE_FILTER_CHANGE_EVENT) {
			this.events.push({ eventName, data });
		}
	}
}

suite('sessions machine filter telemetry', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHarness(hosts: readonly IAgentHostFilterEntry[] = [ONLINE_HOST, OFFLINE_HOST]) {
		const instantiationService = store.add(new TestInstantiationService());
		const filterService = new StubAgentHostFilterService(hosts);
		const telemetryService = new TestTelemetryService();
		instantiationService.stub(IAgentHostFilterService, filterService as unknown as IAgentHostFilterService);
		instantiationService.stub(ITelemetryService, telemetryService);

		return {
			filterService,
			telemetryService,
			async run(commandId: string, ...args: unknown[]): Promise<void> {
				const handler = CommandsRegistry.getCommand(commandId)?.handler;
				assert.ok(handler, `${commandId} is registered`);
				await instantiationService.invokeFunction(accessor => handler(accessor, ...args));
			},
		};
	}

	test('reports the new scope kind and how many hosts were known', async () => {
		const harness = createHarness();

		await harness.run(SELECT_LOCAL_MACHINE_COMMAND_ID);
		await harness.run(SELECT_HOST_MACHINE_COMMAND_ID, ONLINE_HOST.providerId);
		await harness.run(SELECT_ALL_MACHINES_COMMAND_ID);

		assert.deepStrictEqual(harness.telemetryService.events, [
			{ eventName: MACHINE_FILTER_CHANGE_EVENT, data: { scopeKind: 'local', hostCount: 2 } },
			{ eventName: MACHINE_FILTER_CHANGE_EVENT, data: { scopeKind: 'host', hostCount: 2 } },
			{ eventName: MACHINE_FILTER_CHANGE_EVENT, data: { scopeKind: 'all', hostCount: 2 } },
		]);
	});

	test('never reports the machine identity of the scoped host', async () => {
		const harness = createHarness();

		await harness.run(SELECT_HOST_MACHINE_COMMAND_ID, ONLINE_HOST.providerId);

		const payload = harness.telemetryService.events[0].data as Record<string, unknown>;
		assert.deepStrictEqual(Object.keys(payload).sort(), ['hostCount', 'scopeKind']);
		const serialized = JSON.stringify(payload);
		for (const identifier of [ONLINE_HOST.providerId, ONLINE_HOST.address, ONLINE_HOST.label]) {
			assert.ok(!serialized.includes(identifier), `payload must not carry ${identifier}`);
		}
	});

	test('picking the scope that is already active reports nothing', async () => {
		const harness = createHarness();

		await harness.run(SELECT_ALL_MACHINES_COMMAND_ID);
		await harness.run(SELECT_HOST_MACHINE_COMMAND_ID, ONLINE_HOST.providerId);
		await harness.run(SELECT_HOST_MACHINE_COMMAND_ID, ONLINE_HOST.providerId);

		assert.deepStrictEqual(harness.telemetryService.events.map(event => event.data), [
			{ scopeKind: 'host', hostCount: 2 },
		]);
	});

	test('a scope the service rejects reports nothing', async () => {
		const harness = createHarness();

		await harness.run(SELECT_HOST_MACHINE_COMMAND_ID, 'agenthost-unknown.internal:4321');
		await harness.run(SELECT_HOST_MACHINE_COMMAND_ID, 42);

		assert.deepStrictEqual({
			events: harness.telemetryService.events,
			scope: harness.filterService.scope,
		}, {
			events: [],
			scope: { kind: 'all' },
		});
	});

	test('scoping to an offline host still reconnects', async () => {
		const harness = createHarness();

		await harness.run(SELECT_HOST_MACHINE_COMMAND_ID, OFFLINE_HOST.providerId);

		assert.deepStrictEqual({
			reconnected: harness.filterService.reconnected,
			scope: harness.filterService.scope,
			events: harness.telemetryService.events.map(event => event.data),
		}, {
			reconnected: [OFFLINE_HOST.providerId],
			scope: { kind: 'host', providerId: OFFLINE_HOST.providerId },
			events: [{ scopeKind: 'host', hostCount: 2 }],
		});
	});
});
