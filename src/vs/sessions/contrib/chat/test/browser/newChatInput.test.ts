/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as dom from '../../../../../base/browser/dom.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore, IDisposable, IReference, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IResolvedTextEditorModel } from '../../../../../editor/common/services/resolverService.js';
import { NewChatInputWidget } from '../../browser/newChatInput.js';

interface IInputModelReferenceHarness {
	readonly _store: DisposableStore;
	readonly textModelService: {
		createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>>;
	};
	readonly logService: {
		error(message: string, error: Error): void;
	};
	_register<T extends IDisposable>(disposable: T): T;
}

const holdInputModelReference = Reflect.get(NewChatInputWidget.prototype, '_holdInputModelReference') as (this: IInputModelReferenceHarness, uri: URI, model: ITextModel) => void;
const sendInput = Reflect.get(NewChatInputWidget.prototype, '_send') as (this: INewChatSendHarness) => Promise<boolean>;

interface INewChatSendHarness {
	readonly _editor: {
		getModel(): { getValue(): string; setValue(value: string): void };
		updateOptions(options: { readOnly: boolean }): void;
	};
	readonly _contextAttachments: { readonly attachments: readonly never[]; clear(): void };
	readonly options: {
		readonly session: { get(): { readonly resource: URI; readonly providerId: string; readonly sessionId: string } | undefined };
		readonly sendRequest: () => Promise<boolean>;
	};
	readonly _canSendRequest: { get(): boolean };
	readonly chatSubmitRequestHandlerService: { tryHandle(): Promise<boolean> };
	readonly _agentHostInputCompletionHandler: undefined;
	readonly _draftState: undefined;
	_sending: boolean;
	readonly logService: { error(message: string, error: unknown): void };
	readonly layoutService: { readonly mainContainer: HTMLElement };
	readonly _editorContainer: HTMLElement;
	_clearDraftState(): void;
	_updateDraftState(): void;
	_updateSendButtonState(): void;
	_updateInputLoadingState(): void;
}

class InputModelReferenceHarness implements IInputModelReferenceHarness, IDisposable {
	readonly _store = new DisposableStore();

	constructor(
		readonly textModelService: IInputModelReferenceHarness['textModelService'],
		readonly logService: IInputModelReferenceHarness['logService'],
	) { }

	_register<T extends IDisposable>(disposable: T): T {
		return this._store.add(disposable);
	}

	dispose(): void {
		this._store.dispose();
	}
}

suite('NewChatInputWidget', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the input model alive until reference acquisition settles during disposal', async () => {
		const referenceDeferred = new DeferredPromise<IReference<IResolvedTextEditorModel>>();
		let modelDisposed = false;
		let referenceDisposed = false;
		const errors: { message: string; error: Error }[] = [];
		const model = new class extends mock<ITextModel>() {
			override dispose(): void {
				modelDisposed = true;
			}
		}();
		const resolvedModel = new class extends mock<IResolvedTextEditorModel>() {
			override readonly textEditorModel = model;
		}();
		const harness = disposables.add(new InputModelReferenceHarness(
			{
				createModelReference: () => referenceDeferred.p,
			},
			{
				error: (message, error) => errors.push({ message, error }),
			},
		));

		holdInputModelReference.call(harness, URI.from({ scheme: Schemas.sessionsChatInput, path: 'input-test' }), model);
		harness.dispose();
		const disposedBeforeReferenceSettled = modelDisposed;

		referenceDeferred.complete({
			object: resolvedModel,
			dispose: () => {
				referenceDisposed = true;
				model.dispose();
			},
		});
		await referenceDeferred.p;
		await Promise.resolve();

		assert.deepStrictEqual({
			disposedBeforeReferenceSettled,
			modelDisposed,
			referenceDisposed,
			errors,
		}, {
			disposedBeforeReferenceSettled: false,
			modelDisposed: true,
			referenceDisposed: true,
			errors: [],
		});
	});

	test('dismisses phone focus after a successful new-chat send only', async () => {
		const run = async (phoneLayout: boolean, sent: boolean, preHandled = false) => {
			const host = dom.append(document.body, dom.$('.new-chat-send-focus-test'));
			const mainContainer = dom.append(host, dom.$(phoneLayout ? '.phone-layout' : '.desktop-layout'));
			const editorContainer = dom.append(mainContainer, dom.$('.editor-container'));
			const input = dom.append(editorContainer, dom.$('textarea'));
			disposables.add(toDisposable(() => host.remove()));

			let value = 'message';
			const session = preHandled ? { resource: URI.parse('test://session/focus'), providerId: 'test', sessionId: 'focus' } : undefined;
			const harness: INewChatSendHarness = {
				_editor: {
					getModel: () => ({ getValue: () => value, setValue: newValue => value = newValue }),
					updateOptions: () => { },
				},
				_contextAttachments: {
					attachments: [],
					clear: () => input.focus(),
				},
				options: {
					session: { get: () => session },
					sendRequest: async () => sent,
				},
				_canSendRequest: { get: () => true },
				chatSubmitRequestHandlerService: { tryHandle: async () => preHandled },
				_agentHostInputCompletionHandler: undefined,
				_draftState: undefined,
				_sending: false,
				logService: { error: () => { } },
				layoutService: { mainContainer },
				_editorContainer: editorContainer,
				_clearDraftState: () => { },
				_updateDraftState: () => { },
				_updateSendButtonState: () => { },
				_updateInputLoadingState: () => { },
			};

			input.focus();
			const result = await sendInput.call(harness);
			return { result, focused: document.activeElement === input };
		};

		assert.deepStrictEqual({
			phoneSuccess: await run(true, true),
			phoneFailure: await run(true, false),
			desktopSuccess: await run(false, true),
			phonePreHandled: await run(true, false, true),
		}, {
			phoneSuccess: { result: true, focused: false },
			phoneFailure: { result: false, focused: true },
			desktopSuccess: { result: true, focused: true },
			phonePreHandled: { result: true, focused: false },
		});
	});
});
