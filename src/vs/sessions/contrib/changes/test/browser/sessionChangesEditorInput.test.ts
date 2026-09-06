/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event, ValueWithChangeEvent } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DocumentDiffItemViewModel, MultiDiffEditorViewModel } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { EditorInputCapabilities } from '../../../../../workbench/common/editor.js';
import { MultiDiffEditorInput } from '../../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IPartVisibilityChangeEvent, IWorkbenchLayoutService, Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { TestEditorGroupView, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';
import { SESSION_CHANGES_MODEL_RESOLVE_DELAY_MS, SessionChangesEditor } from '../../browser/sessionChangesEditor.js';
import { SessionChangesEditorInput } from '../../browser/sessionChangesEditorInput.js';
import { ISessionChangesService } from '../../browser/sessionChangesService.js';
import { IChangesViewService } from '../../common/changesViewService.js';

suite('SessionChangesEditorInput', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('releases resolved multi-diff models without disposing restorable input state', async () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IWorkbenchLayoutService, new class extends mock<IWorkbenchLayoutService>() {
			override readonly onDidChangePartVisibility = Event.None;
			override isVisible(): boolean {
				return true;
			}
		});
		const viewModel = disposables.add(new MultiDiffEditorViewModel({
			documents: ValueWithChangeEvent.const([]),
		}, instantiationService));

		let firstModelReferenceDisposed = false;
		instantiationService.stubInstance(MultiDiffEditorInput, {
			getViewModel: async () => viewModel,
			dispose: () => firstModelReferenceDisposed = true,
		});

		const input = disposables.add(instantiationService.createInstance(
			SessionChangesEditorInput,
			URI.parse('changes-multi-diff-source:?{"sessionResource":"agent-host-copilotcli:/session"}'),
		));
		await input.getViewModel();
		input.clear();

		let secondModelResolved = false;
		instantiationService.stubInstance(MultiDiffEditorInput, {
			getViewModel: async () => {
				secondModelResolved = true;
				return viewModel;
			},
			dispose: () => { },
		});
		await input.getViewModel();

		assert.deepStrictEqual({
			firstModelReferenceDisposed,
			outerInputDisposed: input.isDisposed(),
			secondModelResolved,
		}, {
			firstModelReferenceDisposed: true,
			outerInputDisposed: false,
			secondModelResolved: true,
		});
	});

	test('clearing the editor pane releases the resolved multi-diff model', () => {
		class TestSessionChangesEditor extends SessionChangesEditor {
			setCurrentInput(input: SessionChangesEditorInput): void {
				this._input = input;
			}
		}

		class TestSessionChangesEditorInput extends SessionChangesEditorInput {
			released = false;

			override clear(): void {
				this.released = true;
				super.clear();
			}
		}

		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IChangesViewService, {});
		instantiationService.stub(ISessionChangesService, {});
		// `IAgentWorkbenchLayoutService` refines `IWorkbenchLayoutService`, so this
		// single stub serves both decorators.
		instantiationService.stub(IAgentWorkbenchLayoutService, {
			onDidChangePartVisibility: Event.None,
			isVisible: () => true,
			isEditorPaneVisible: () => true,
		});

		const editor = disposables.add(instantiationService.createInstance(TestSessionChangesEditor, new TestEditorGroupView(1)));
		const input = disposables.add(instantiationService.createInstance(
			TestSessionChangesEditorInput,
			URI.parse('changes-multi-diff-source:?{"sessionResource":"agent-host-copilotcli:/session"}'),
		));
		editor.setCurrentInput(input);

		editor.clearInput();

		assert.deepStrictEqual({
			inputReleased: input.released,
			editorInput: editor.input,
		}, {
			inputReleased: true,
			editorInput: undefined,
		});
	});

	test('releases background Changes models and restores them when visible again', async () => {
		class TestSessionChangesEditor extends SessionChangesEditor {
			setCurrentInput(input: SessionChangesEditorInput): void {
				this._input = input;
			}
		}

		class TestSessionChangesEditorInput extends SessionChangesEditorInput {
			clearCalls = 0;
			resolveCalls = 0;

			override clear(): void {
				this.clearCalls++;
				super.clear();
			}

			override async getViewModel(options?: { readonly waitForDiffOr1s?: boolean }): Promise<MultiDiffEditorViewModel> {
				this.resolveCalls++;
				assert.strictEqual(options?.waitForDiffOr1s, false);
				return viewModel;
			}
		}

		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IChangesViewService, {});
		instantiationService.stub(ISessionChangesService, {});
		// `IAgentWorkbenchLayoutService` refines `IWorkbenchLayoutService`, so this
		// single stub serves both decorators.
		instantiationService.stub(IAgentWorkbenchLayoutService, {
			onDidChangePartVisibility: Event.None,
			isVisible: () => true,
			isEditorPaneVisible: () => true,
		});
		const viewModel = disposables.add(new MultiDiffEditorViewModel({
			documents: ValueWithChangeEvent.const([]),
		}, instantiationService));
		const editor = disposables.add(instantiationService.createInstance(TestSessionChangesEditor, new TestEditorGroupView(1)));
		const input = disposables.add(instantiationService.createInstance(
			TestSessionChangesEditorInput,
			URI.parse('changes-multi-diff-source:?{"sessionResource":"agent-host-copilotcli:/session"}'),
		));
		editor.setCurrentInput(input);

		editor.setVisible(false);
		editor.setVisible(true);
		await timeout(SESSION_CHANGES_MODEL_RESOLVE_DELAY_MS + 20);

		assert.deepStrictEqual({
			clearCalls: input.clearCalls,
			resolveCalls: input.resolveCalls,
		}, {
			clearCalls: 1,
			resolveCalls: 1,
		});
	});

	test('does not restore models after the editor pane is disposed during the stability window', async () => {
		class TestSessionChangesEditor extends SessionChangesEditor {
			setCurrentInput(input: SessionChangesEditorInput): void {
				this._input = input;
			}
		}

		class TestSessionChangesEditorInput extends SessionChangesEditorInput {
			resolveCalls = 0;
			clearCalls = 0;

			override clear(): void {
				this.clearCalls++;
				super.clear();
			}

			override async getViewModel(): Promise<MultiDiffEditorViewModel> {
				this.resolveCalls++;
				return viewModel;
			}
		}

		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IChangesViewService, {});
		instantiationService.stub(ISessionChangesService, {});
		// `IAgentWorkbenchLayoutService` refines `IWorkbenchLayoutService`, so this
		// single stub serves both decorators.
		instantiationService.stub(IAgentWorkbenchLayoutService, {
			onDidChangePartVisibility: Event.None,
			isVisible: () => true,
			isEditorPaneVisible: () => true,
		});
		const viewModel = disposables.add(new MultiDiffEditorViewModel({
			documents: ValueWithChangeEvent.const([]),
		}, instantiationService));
		const editor = disposables.add(instantiationService.createInstance(TestSessionChangesEditor, new TestEditorGroupView(1)));
		const input = disposables.add(instantiationService.createInstance(
			TestSessionChangesEditorInput,
			URI.parse('changes-multi-diff-source:?{"sessionResource":"agent-host-copilotcli:/disposed"}'),
		));
		editor.setCurrentInput(input);

		editor.setVisible(true);
		editor.dispose();
		await timeout(SESSION_CHANGES_MODEL_RESOLVE_DELAY_MS + 20);

		assert.deepStrictEqual({
			resolveCalls: input.resolveCalls,
			clearCalls: input.clearCalls,
		}, {
			resolveCalls: 0,
			clearCalls: 1,
		});
	});

	test('does not resolve hidden inputs or reject a load canceled while hiding', async () => {
		class TestSessionChangesEditorInput extends SessionChangesEditorInput {
			readonly started = new DeferredPromise<void>();
			readonly result = new DeferredPromise<MultiDiffEditorViewModel>();
			resolveCalls = 0;
			clearCalls = 0;

			override clear(): void {
				this.clearCalls++;
				super.clear();
			}

			override getViewModel(options?: { readonly waitForDiffOr1s?: boolean }): Promise<MultiDiffEditorViewModel> {
				this.resolveCalls++;
				assert.strictEqual(options?.waitForDiffOr1s, false);
				void this.started.complete();
				return this.result.p;
			}
		}

		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IChangesViewService, {});
		instantiationService.stub(ISessionChangesService, {
			getSessionResource: (resource: URI) => resource,
		});
		// `IAgentWorkbenchLayoutService` refines `IWorkbenchLayoutService`, so this
		// single stub serves both decorators.
		instantiationService.stub(IAgentWorkbenchLayoutService, {
			onDidChangePartVisibility: Event.None,
			isVisible: () => true,
			isEditorPaneVisible: () => true,
		});

		const editor = disposables.add(instantiationService.createInstance(SessionChangesEditor, new TestEditorGroupView(1)));
		const loadingInput = disposables.add(instantiationService.createInstance(
			TestSessionChangesEditorInput,
			URI.parse('changes-multi-diff-source:?{"sessionResource":"agent-host-copilotcli:/loading"}'),
		));
		editor.setVisible(true);
		const loading = editor.setInput(loadingInput, undefined, Object.create(null), CancellationToken.None);
		await loadingInput.started.p;

		editor.setVisible(false);
		await loadingInput.result.error(new CancellationError());
		await loading;

		const hiddenInput = disposables.add(instantiationService.createInstance(
			TestSessionChangesEditorInput,
			URI.parse('changes-multi-diff-source:?{"sessionResource":"agent-host-copilotcli:/hidden"}'),
		));
		await editor.setInput(hiddenInput, undefined, Object.create(null), CancellationToken.None);

		assert.deepStrictEqual({
			loadingResolveCalls: loadingInput.resolveCalls,
			loadingClearCalls: loadingInput.clearCalls,
			hiddenResolveCalls: hiddenInput.resolveCalls,
		}, {
			loadingResolveCalls: 1,
			loadingClearCalls: 1,
			hiddenResolveCalls: 0,
		});
	});

	test('does not start diff model work for an input superseded during the stability window', async () => {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IChangesViewService, {});
		instantiationService.stub(ISessionChangesService, {
			getSessionResource: (resource: URI) => resource,
		});
		// `IAgentWorkbenchLayoutService` refines `IWorkbenchLayoutService`, so this
		// single stub serves both decorators.
		instantiationService.stub(IAgentWorkbenchLayoutService, {
			onDidChangePartVisibility: Event.None,
			isVisible: () => true,
			isEditorPaneVisible: () => true,
		});
		const viewModel = disposables.add(new MultiDiffEditorViewModel({
			documents: ValueWithChangeEvent.const([]),
		}, instantiationService));

		class TestSessionChangesEditorInput extends SessionChangesEditorInput {
			resolveCalls = 0;

			override async getViewModel(options?: { readonly waitForDiffOr1s?: boolean }): Promise<MultiDiffEditorViewModel> {
				this.resolveCalls++;
				assert.strictEqual(options?.waitForDiffOr1s, false);
				return viewModel;
			}
		}

		const editor = disposables.add(instantiationService.createInstance(SessionChangesEditor, new TestEditorGroupView(1)));
		const first = disposables.add(instantiationService.createInstance(TestSessionChangesEditorInput, URI.parse('test-changes:first')));
		const second = disposables.add(instantiationService.createInstance(TestSessionChangesEditorInput, URI.parse('test-changes:second')));
		editor.setVisible(true);

		const firstLoad = editor.setInput(first, undefined, Object.create(null), CancellationToken.None);
		const secondLoad = editor.setInput(second, undefined, Object.create(null), CancellationToken.None);
		await Promise.all([firstLoad, secondLoad]);

		assert.deepStrictEqual({ first: first.resolveCalls, second: second.resolveCalls }, { first: 0, second: 1 });
	});

	test('retains a hidden reveal until its incremental target loads and consumes it once', async () => {
		const target = URI.parse('file:///target.ts');
		const items = observableValue<readonly DocumentDiffItemViewModel[]>('items', []);
		const viewModel = { items } as unknown as MultiDiffEditorViewModel;
		class TestSessionChangesEditorInput extends SessionChangesEditorInput {
			resolveCalls = 0;

			override async getViewModel(): Promise<MultiDiffEditorViewModel> {
				this.resolveCalls++;
				return viewModel;
			}
		}

		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IChangesViewService, {});
		instantiationService.stub(ISessionChangesService, {
			getSessionResource: (resource: URI) => resource,
		});
		// `IAgentWorkbenchLayoutService` refines `IWorkbenchLayoutService`, so this
		// single stub serves both decorators.
		instantiationService.stub(IAgentWorkbenchLayoutService, {
			onDidChangePartVisibility: Event.None,
			isVisible: () => true,
			isEditorPaneVisible: () => true,
		});

		let revealCalls = 0;
		const editor = disposables.add(instantiationService.createInstance(SessionChangesEditor, new TestEditorGroupView(1)));
		Object.defineProperty(editor, 'widget', {
			configurable: true,
			value: {
				getViewState: () => ({ scrollState: { top: 0, left: 0 } }),
				reveal: () => revealCalls++,
				setViewModel: () => { },
			},
		});
		const input = disposables.add(instantiationService.createInstance(
			TestSessionChangesEditorInput,
			URI.parse('changes-multi-diff-source:?{"sessionResource":"agent-host-copilotcli:/reveal"}'),
		));
		await editor.setInput(input, {
			viewState: { revealData: { resource: { original: undefined, modified: target } } },
		}, Object.create(null), CancellationToken.None);
		assert.strictEqual(input.resolveCalls, 0, 'hidden inputs must retain the reveal without resolving');

		editor.setVisible(true);
		await timeout(SESSION_CHANGES_MODEL_RESOLVE_DELAY_MS + 20);
		assert.strictEqual(revealCalls, 0, 'the target is not available yet');

		items.set([{ originalUri: undefined, modifiedUri: target } as DocumentDiffItemViewModel], undefined);
		await timeout(0);
		assert.strictEqual(revealCalls, 1);

		editor.setVisible(false);
		editor.setVisible(true);
		await timeout(SESSION_CHANGES_MODEL_RESOLVE_DELAY_MS + 20);
		assert.strictEqual(revealCalls, 1, 'a consumed reveal must not replay after hide/show');
	});

	test('updates managed Changes editor capabilities with editor area visibility', () => {
		const instantiationService = disposables.add(new TestInstantiationService());
		let editorVisible = false;
		const onDidChangePartVisibility = disposables.add(new Emitter<IPartVisibilityChangeEvent>());
		const layoutService = new class extends mock<IWorkbenchLayoutService>() {
			override readonly onDidChangePartVisibility = onDidChangePartVisibility.event;
			override isVisible(part: Parts): boolean {
				return part === Parts.EDITOR_PART && editorVisible;
			}
		};
		const input = disposables.add(new SessionChangesEditorInput(URI.parse('test-changes:session'), instantiationService, layoutService));
		let capabilitiesChanges = 0;
		disposables.add(input.onDidChangeCapabilities(() => capabilitiesChanges++));

		const hiddenCapabilities = input.capabilities;
		editorVisible = true;
		onDidChangePartVisibility.fire({ partId: Parts.EDITOR_PART, visible: true });

		assert.deepStrictEqual({
			hiddenCapabilities,
			visibleCapabilities: input.capabilities,
			capabilitiesChanges
		}, {
			hiddenCapabilities: EditorInputCapabilities.ExcludeFromEditorLimit |
				EditorInputCapabilities.Singleton |
				EditorInputCapabilities.Readonly |
				EditorInputCapabilities.CannotClose,
			visibleCapabilities: EditorInputCapabilities.ExcludeFromEditorLimit |
				EditorInputCapabilities.Singleton |
				EditorInputCapabilities.Readonly,
			capabilitiesChanges: 1
		});
	});

	test('defers changeset model resolution until the side pane is on screen', async () => {
		// The docked Changes tab is opened on every session switch, so the pane is
		// its group's active input long before the side pane is revealed. Resolving
		// there costs a read plus a stat per changed file over the Agent Host
		// connection for diffs with nowhere to render.
		class TestSessionChangesEditorInput extends SessionChangesEditorInput {
			resolveCalls = 0;

			override async getViewModel(): Promise<MultiDiffEditorViewModel> {
				this.resolveCalls++;
				return viewModel;
			}
		}

		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IChangesViewService, {});
		instantiationService.stub(ISessionChangesService, {
			getSessionResource: (resource: URI) => resource,
		});
		let editorPaneVisible = false;
		const onDidChangePartVisibility = disposables.add(new Emitter<IPartVisibilityChangeEvent>());
		// `IAgentWorkbenchLayoutService` refines `IWorkbenchLayoutService`, so this
		// single stub serves both decorators.
		instantiationService.stub(IAgentWorkbenchLayoutService, {
			onDidChangePartVisibility: onDidChangePartVisibility.event,
			isVisible: () => true,
			isEditorPaneVisible: () => editorPaneVisible,
		});
		const viewModel = disposables.add(new MultiDiffEditorViewModel({
			documents: ValueWithChangeEvent.const([]),
		}, instantiationService));

		const editor = disposables.add(instantiationService.createInstance(SessionChangesEditor, new TestEditorGroupView(1)));
		const input = disposables.add(instantiationService.createInstance(
			TestSessionChangesEditorInput,
			URI.parse('changes-multi-diff-source:?{"sessionResource":"agent-host-copilotcli:/collapsed"}'),
		));

		editor.setVisible(true);
		await editor.setInput(input, undefined, Object.create(null), CancellationToken.None);
		await timeout(SESSION_CHANGES_MODEL_RESOLVE_DELAY_MS + 20);
		const resolvedWhileCollapsed = input.resolveCalls;

		editorPaneVisible = true;
		onDidChangePartVisibility.fire({ partId: Parts.EDITOR_PART, visible: true });
		await timeout(SESSION_CHANGES_MODEL_RESOLVE_DELAY_MS + 20);

		assert.deepStrictEqual({
			resolvedWhileCollapsed,
			resolvedAfterReveal: input.resolveCalls,
		}, {
			resolvedWhileCollapsed: 0,
			resolvedAfterReveal: 1,
		});
	});
});
