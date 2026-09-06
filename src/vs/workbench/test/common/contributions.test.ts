/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { IdleDeadline, installFakeRunWhenIdle } from '../../../base/common/async.js';
import { IInstantiationService, ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IEnvironmentService } from '../../../platform/environment/common/environment.js';
import { ILogService, NullLogService } from '../../../platform/log/common/log.js';
import { IEditorPaneService } from '../../services/editor/common/editorPaneService.js';
import { ILifecycleService, LifecyclePhase } from '../../services/lifecycle/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { IWorkbenchContribution, WorkbenchContributionsRegistry, WorkbenchPhase } from '../../common/contributions.js';

/**
 * A window that never goes idle.
 *
 * `requestIdleCallback` still runs the callback once its timeout elapses, but
 * the deadline it hands over reports nothing left — that is what the browser
 * does for a timeout-driven callback, and what a phone busy through its whole
 * startup produces for every single slice.
 */
class NeverIdleWindow {

	private readonly _pending: Array<(idle: IdleDeadline) => void> = [];

	/** How many idle callbacks the registry has asked for. */
	slices = 0;

	install(): IDisposable {
		return installFakeRunWhenIdle((_target, runner) => {
			this.slices++;
			this._pending.push(runner);
			return { dispose: () => { /* the test drives the queue by hand */ } };
		});
	}

	/** Run every callback queued so far, and anything they queue in turn. */
	drain(limit = 1000): void {
		for (let guard = 0; guard < limit && this._pending.length > 0; guard++) {
			this._pending.shift()!({ didTimeout: true, timeRemaining: () => 0 });
		}
	}
}

suite('Workbench contributions', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createRegistry(store: DisposableStore, created: string[]): WorkbenchContributionsRegistry {
		const registry = store.add(new WorkbenchContributionsRegistry());

		const instantiationService: IInstantiationService = {
			createInstance: (ctor: new () => IWorkbenchContribution) => new ctor(),
		} as unknown as IInstantiationService;

		const lifecycleService: ILifecycleService = {
			phase: LifecyclePhase.Restored,
			onDidShutdown: new Emitter<void>().event,
			when: () => Promise.resolve(),
		} as unknown as ILifecycleService;

		const editorPaneService: IEditorPaneService = {
			didInstantiateEditorPane: () => false,
			onWillInstantiateEditorPane: new Emitter<{ typeId: string }>().event,
		} as unknown as IEditorPaneService;

		const services = new Map<unknown, unknown>([
			[IInstantiationService, instantiationService],
			[ILifecycleService, lifecycleService],
			[ILogService, store.add(new NullLogService())],
			[IEnvironmentService, { isBuilt: true } as IEnvironmentService],
			[IEditorPaneService, editorPaneService],
		]);

		for (let i = 0; i < 40; i++) {
			const id = `test.contribution.${i}`;
			registry.registerWorkbenchContribution2(id, class {
				constructor() {
					created.push(id);
				}
			} as never, WorkbenchPhase.AfterRestored);
		}

		registry.start({ get: (id: unknown) => services.get(id) } as ServicesAccessor);
		return registry;
	}

	/**
	 * The regression: the phase used to stop after a single contribution
	 * whenever the deadline reported no time left, which a timeout-driven idle
	 * callback always does. One contribution per callback turned a phase of a
	 * hundred-odd contributions into minutes on a phone, and the last of them —
	 * the wiring between a connected agent host and the session list — never
	 * ran at all, so the mobile client rendered and then sat there.
	 */
	test('a window that never goes idle still creates every Restored contribution, and not one per slice', () => {
		const store = disposables.add(new DisposableStore());
		const window = new NeverIdleWindow();
		store.add(window.install());

		const created: string[] = [];
		createRegistry(store, created);
		window.drain();

		assert.strictEqual(created.length, 40, 'every registered contribution should have been created');
		assert.ok(window.slices < 40, `expected fewer idle slices than contributions, got ${window.slices}`);
	});
});
