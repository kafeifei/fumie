/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentSdkRetryRequestConfigKey, AgentSdkStatusConfigKey, type AgentSdkStatusMap } from '../../../common/agentHostSchema.js';
import type { IAgentConfigurationService } from '../../../node/agentConfigurationService.js';
import type { IAgentSdkPackage } from '../../../node/agentSdkDownloader.js';
import { AgentSdkManager } from '../../../node/fumie/agentSdkManager.js';

suite('AgentSdkManager', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const TEST_ENV_VAR = 'VSCODE_AGENT_HOST_SDKMGRTEST_SDK_ROOT';
	const TEST_FUMIE_ENV_VAR = 'FUMIE_SDKMGRTEST_SDK_ROOT';
	const pkg: IAgentSdkPackage = {
		id: 'sdkmgrtest',
		displayName: 'SdkMgrTest',
		devOverrideEnvVar: TEST_ENV_VAR,
		hasSeparateMuslLinuxPackage: false,
	};

	let agentsDir: string;
	let published: AgentSdkStatusMap[];
	let retryValue: string | undefined;
	let onDidRootConfigChange: Emitter<void>;

	setup(() => {
		agentsDir = mkdtempSync(join(tmpdir(), 'agent-sdk-manager-test-'));
		published = [];
		retryValue = undefined;
		onDidRootConfigChange = store.add(new Emitter<void>());
		delete process.env[TEST_ENV_VAR];
		delete process.env[TEST_FUMIE_ENV_VAR];
	});

	teardown(() => {
		rmSync(agentsDir, { recursive: true, force: true });
		delete process.env[TEST_ENV_VAR];
		delete process.env[TEST_FUMIE_ENV_VAR];
	});

	function configService(): IAgentConfigurationService {
		return {
			onDidRootConfigChange: onDidRootConfigChange.event,
			updateRootConfig: (patch: Record<string, unknown>) => {
				const statuses = patch[AgentSdkStatusConfigKey];
				if (statuses) {
					published.push(structuredClone(statuses) as AgentSdkStatusMap);
				}
			},
			getRootValue: (_schema: unknown, key: string) => key === AgentSdkRetryRequestConfigKey ? retryValue : undefined,
		} as unknown as IAgentConfigurationService;
	}

	function createManager(options?: { hasProductSdk?: boolean; runInstaller?: (id: string, installDir: string) => Promise<void>; noAgentsDir?: boolean }): AgentSdkManager {
		const manager = new AgentSdkManager({
			agentsDir: options?.noAgentsDir ? undefined : agentsDir,
			hasProductSdk: () => options?.hasProductSdk ?? false,
			runInstaller: options?.runInstaller,
		}, configService(), new NullLogService());
		store.add(manager);
		return manager;
	}

	function writeDescriptor(dependencies: Record<string, string> = { 'test-sdk-dep': '1.0.0' }): string {
		const root = join(agentsDir, pkg.id);
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', private: true, dependencies }));
		return root;
	}

	function installDependency(root: string, name = 'test-sdk-dep'): void {
		mkdirSync(join(root, 'node_modules', name), { recursive: true });
	}

	function whenRegistered(): { promise: Promise<void>; register: () => void; count: () => number } {
		let calls = 0;
		let resolve!: () => void;
		const promise = new Promise<void>(r => { resolve = r; });
		return { promise, register: () => { calls++; resolve(); }, count: () => calls };
	}

	async function settled(): Promise<void> {
		// _ensure resolves within a few microtask turns when no installer runs.
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
	}

	test('adopts an existing install and exports the dev override', async () => {
		const root = writeDescriptor();
		installDependency(root);
		const manager = createManager();
		const registered = whenRegistered();
		manager.manage(pkg, registered.register);
		await registered.promise;
		assert.strictEqual(process.env[TEST_ENV_VAR], root);
		assert.strictEqual(manager.getStatuses()[pkg.id].state, 'ready');
	});

	test('installs a missing SDK, then registers', async () => {
		const root = writeDescriptor();
		let installedInto: string | undefined;
		const manager = createManager({
			runInstaller: async (_id, installDir) => {
				installedInto = installDir;
				installDependency(installDir);
			},
		});
		const registered = whenRegistered();
		manager.manage(pkg, registered.register);
		await registered.promise;
		assert.strictEqual(installedInto, root);
		assert.strictEqual(manager.getStatuses()[pkg.id].state, 'ready');
		assert.strictEqual(process.env[TEST_ENV_VAR], root);
		// The installing state was published before ready.
		assert.deepStrictEqual(published.map(p => p[pkg.id].state), ['installing', 'ready']);
	});

	test('a failed install is reported, never registers, and can be retried', async () => {
		const root = writeDescriptor();
		let attempts = 0;
		const manager = createManager({
			runInstaller: async () => {
				attempts++;
				if (attempts === 1) {
					throw new Error('registry unreachable');
				}
				installDependency(root);
			},
		});
		const registered = whenRegistered();
		manager.manage(pkg, registered.register);
		await settled();
		assert.strictEqual(manager.getStatuses()[pkg.id].state, 'failed');
		assert.match(manager.getStatuses()[pkg.id].error ?? '', /registry unreachable/);
		assert.strictEqual(registered.count(), 0);

		manager.retry(pkg.id);
		await registered.promise;
		assert.strictEqual(manager.getStatuses()[pkg.id].state, 'ready');
		assert.strictEqual(registered.count(), 1);
	});

	test('an incomplete explicit override fails without installing', async () => {
		const overrideRoot = join(agentsDir, 'override-root');
		mkdirSync(overrideRoot, { recursive: true });
		writeFileSync(join(overrideRoot, 'package.json'), JSON.stringify({ dependencies: { 'test-sdk-dep': '1.0.0' } }));
		process.env[TEST_FUMIE_ENV_VAR] = overrideRoot;
		let installerRan = false;
		const manager = createManager({ runInstaller: async () => { installerRan = true; } });
		const registered = whenRegistered();
		manager.manage(pkg, registered.register);
		await settled();
		assert.strictEqual(manager.getStatuses()[pkg.id].state, 'failed');
		assert.match(manager.getStatuses()[pkg.id].error ?? '', /incomplete/);
		assert.strictEqual(installerRan, false);
		assert.strictEqual(registered.count(), 0);
	});

	test('a complete explicit override is adopted as ready', async () => {
		const overrideRoot = join(agentsDir, 'override-root');
		mkdirSync(overrideRoot, { recursive: true });
		writeFileSync(join(overrideRoot, 'package.json'), JSON.stringify({ dependencies: { 'test-sdk-dep': '1.0.0' } }));
		installDependency(overrideRoot);
		process.env[TEST_FUMIE_ENV_VAR] = overrideRoot;
		const manager = createManager();
		const registered = whenRegistered();
		manager.manage(pkg, registered.register);
		await registered.promise;
		assert.strictEqual(manager.getStatuses()[pkg.id].state, 'ready');
		assert.strictEqual(process.env[TEST_ENV_VAR], overrideRoot);
	});

	test('a product-provided SDK is ready without touching the agents dir', async () => {
		const manager = createManager({ hasProductSdk: true, noAgentsDir: true });
		const registered = whenRegistered();
		manager.manage(pkg, registered.register);
		await registered.promise;
		assert.strictEqual(manager.getStatuses()[pkg.id].state, 'ready');
		assert.strictEqual(process.env[TEST_ENV_VAR], undefined);
	});

	test('no agents dir and no product SDK fails with a pointer', async () => {
		const manager = createManager({ noAgentsDir: true });
		const registered = whenRegistered();
		manager.manage(pkg, registered.register);
		await settled();
		assert.strictEqual(manager.getStatuses()[pkg.id].state, 'failed');
		assert.strictEqual(registered.count(), 0);
	});

	test('a retry request on root config re-runs a failed install', async () => {
		const root = writeDescriptor();
		let attempts = 0;
		const manager = createManager({
			runInstaller: async () => {
				attempts++;
				if (attempts === 1) {
					throw new Error('offline');
				}
				installDependency(root);
			},
		});
		const registered = whenRegistered();
		manager.manage(pkg, registered.register);
		await settled();
		assert.strictEqual(manager.getStatuses()[pkg.id].state, 'failed');

		retryValue = `1:${pkg.id}`;
		onDidRootConfigChange.fire();
		await registered.promise;
		assert.strictEqual(manager.getStatuses()[pkg.id].state, 'ready');

		// The same request value is not consumed twice.
		onDidRootConfigChange.fire();
		await settled();
		assert.strictEqual(attempts, 2);
	});
});
