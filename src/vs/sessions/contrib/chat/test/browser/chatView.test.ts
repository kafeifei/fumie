/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { stub } from 'sinon';
import * as dom from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CHAT_WIDGET_VIEW_STATE_CACHE_LIMIT } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ChatInputNoticeHost, ChatInputNoticeLane } from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputNoticeHost.js';
import { isChatInputStackSlotShowing } from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStack.js';
import { ChatView, createFumieAgentsChatWidgetViewOptions, findTranscriptContextEntry, getTranscriptProgress, NewChatView, shouldShowSessionChatTip, shouldShowTranscriptPreparationProgress } from '../../browser/chatView.js';
import { SessionsChatViewStateService } from '../../browser/chatViewStateService.js';
import { NewChatInSessionWidget } from '../../browser/newChatInSessionWidget.js';
import { NewChatWidget } from '../../browser/newChatWidget.js';
import { IChatRequestTranscriptContextVariableEntry } from '../../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { IChat, ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { installMobileChatKeyboardDismissal } from '../../browser/mobile/mobileChatKeyboard.js';

suite('Sessions - Chat View', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createReadTrackingView() {
		const targetWindow = dom.getWindow(document);
		const focused = stub(document, 'hasFocus').returns(true);
		const visibility = stub(document, 'visibilityState').get(() => 'visible');
		disposables.add(toDisposable(() => { focused.restore(); visibility.restore(); }));
		const resource = URI.parse('test:///unread');
		const isRead = observableValue('isRead', true);
		const chats = observableValue<readonly IChat[]>('chats', [{ resource } as IChat]);
		const session = { resource, isRead, chats } as unknown as ISession;
		const currentSession = observableValue<ISession | undefined>('session', session);
		const currentResource = observableValue<URI | undefined>('resource', resource);
		const active = observableValue('active', true);
		const visible = observableValue('visible', true);
		const onDidChangeViewModel = disposables.add(new Emitter<void>());
		const onDidScroll = disposables.add(new Emitter<void>());
		const onDidChangeContentHeight = disposables.add(new Emitter<void>());
		let atBottom = true;
		const marked: ISession[] = [];
		const widget = {
			viewModel: { sessionResource: resource } as { sessionResource: URI } | undefined,
			viewportHeight: 500,
			getViewState: () => ({ isAtBottom: atBottom }),
			onDidChangeViewModel: onDidChangeViewModel.event,
			onDidScroll: onDidScroll.event,
			onDidChangeContentHeight: onDidChangeContentHeight.event,
		};
		const view = Object.assign(Object.create(ChatView.prototype), {
			element: dom.$('.chat-view-read-test'),
			_register: <T extends { dispose(): void }>(value: T) => disposables.add(value),
			_currentSessionObs: currentSession,
			_currentChatResourceObs: currentResource,
			_isActiveObs: active,
			_isVisibleObs: visible,
			_widget: widget,
			sessionsManagementService: { markRead: async (value: ISession) => { marked.push(value); isRead.set(true, undefined); } },
			logService: { error: (err: unknown) => { throw err; } },
		}) as { _setupReadTracking(): void };
		view._setupReadTracking();
		return {
			isRead, focused, visibility, active, visible, widget, marked, resource, chats, currentSession, currentResource,
			onDidChangeViewModel, onDidChangeContentHeight,
			scroll: (bottom: boolean) => { atBottom = bottom; onDidScroll.fire(); },
			focus: () => { focused.returns(true); targetWindow.dispatchEvent(new FocusEvent('focus')); },
			flush: () => new Promise<void>(resolve => dom.scheduleAtNextAnimationFrame(targetWindow, () => resolve(), -100)),
		};
	}

	test('keeps a completed selected session unread in a background window until returning', async () => {
		const view = createReadTrackingView();
		view.focused.returns(false);
		view.isRead.set(false, undefined);
		await view.flush();
		assert.strictEqual(view.isRead.get(), false);
		view.focus();
		await view.flush();
		assert.strictEqual(view.isRead.get(), true);
		assert.strictEqual(view.marked.length, 1);
	});

	test('keeps new output unread while reading older content and clears it after scrolling down', async () => {
		const view = createReadTrackingView();
		view.scroll(false);
		view.isRead.set(false, undefined);
		await view.flush();
		assert.strictEqual(view.isRead.get(), false);
		view.scroll(true);
		await view.flush();
		assert.strictEqual(view.isRead.get(), true);
	});

	test('requires an active visible transcript, including when visibility changes without a scroll', async () => {
		const view = createReadTrackingView();
		view.active.set(false, undefined);
		view.isRead.set(false, undefined);
		await view.flush();
		assert.strictEqual(view.isRead.get(), false);
		view.visible.set(false, undefined);
		view.active.set(true, undefined);
		await view.flush();
		assert.strictEqual(view.isRead.get(), false);
		view.visible.set(true, undefined);
		await view.flush();
		assert.strictEqual(view.isRead.get(), true);
	});

	test('waits for the correct model and restored scroll position before marking read', async () => {
		const view = createReadTrackingView();
		view.widget.viewModel = undefined;
		view.isRead.set(false, undefined);
		await view.flush();
		assert.strictEqual(view.isRead.get(), false);
		view.widget.viewModel = { sessionResource: view.resource };
		view.onDidChangeViewModel.fire();
		view.scroll(false);
		await view.flush();
		assert.strictEqual(view.isRead.get(), false);
		view.scroll(true);
		await view.flush();
		assert.strictEqual(view.isRead.get(), true);
	});

	test('requires a bound chat belonging to the session and preserves session-wide read semantics', async () => {
		const view = createReadTrackingView();
		const sideChat = URI.parse('test:///side-chat');
		view.currentResource.set(sideChat, undefined);
		view.widget.viewModel = { sessionResource: sideChat };
		view.isRead.set(false, undefined);
		await view.flush();
		assert.strictEqual(view.isRead.get(), false);
		view.chats.set([...view.chats.get(), { resource: sideChat } as IChat], undefined);
		await view.flush();
		assert.strictEqual(view.isRead.get(), true);
	});

	test('acknowledges new output already visible at the bottom', async () => {
		const view = createReadTrackingView();
		view.isRead.set(false, undefined);
		await view.flush();
		assert.strictEqual(view.isRead.get(), true);
		view.onDidChangeContentHeight.fire();
		await view.flush();
		assert.strictEqual(view.marked.length, 1);
	});

	/** Reaches the banner without standing up the widget's whole service graph. */
	interface ISubSessionTipRenderer {
		_renderSubSessionTip(container: HTMLElement): void;
	}

	test('forwards new chat visibility to the aquarium host', () => {
		const forwarded: boolean[] = [];
		const isVisible = observableValue(disposables, true);
		const view: NewChatView = Object.assign(Object.create(NewChatView.prototype), {
			_isVisibleObs: isVisible,
			_widget: Object.assign(Object.create(NewChatWidget.prototype), {
				setHostVisible: (visible: boolean) => forwarded.push(visible),
			}),
		});

		view.setVisible(false);
		view.setVisible(true);

		assert.deepStrictEqual({ forwarded, petHostVisible: isVisible.get() }, { forwarded: [false, true], petHostVisible: true });
	});

	test('does not forward aquarium visibility to the peer chat composer', () => {
		const isVisible = observableValue(disposables, true);
		const view: NewChatView = Object.assign(Object.create(NewChatView.prototype), {
			_isVisibleObs: isVisible,
			_widget: Object.create(NewChatInSessionWidget.prototype),
		});

		assert.doesNotThrow(() => view.setVisible(false));
		assert.strictEqual(isVisible.get(), false);
	});

	test('stores view state independently by chat resource', () => {
		const service = new SessionsChatViewStateService();
		const first = URI.parse('test:///first');
		const second = URI.parse('test:///second');

		service.set(first, { scrollTop: 120, isAtBottom: false });
		service.set(second, { scrollTop: 700, isAtBottom: true });
		assert.deepStrictEqual({
			first: service.get(first),
			second: service.get(second),
		}, {
			first: { scrollTop: 120, isAtBottom: false },
			second: { scrollTop: 700, isAtBottom: true },
		});
	});

	test('bounds stored view state', () => {
		const service = new SessionsChatViewStateService();
		for (let index = 0; index <= CHAT_WIDGET_VIEW_STATE_CACHE_LIMIT; index++) {
			service.set(URI.parse(`test:///${index}`), { scrollTop: index });
		}

		assert.deepStrictEqual({
			evicted: service.get(URI.parse('test:///0')),
			retained: service.get(URI.parse(`test:///${CHAT_WIDGET_VIEW_STATE_CACHE_LIMIT}`)),
		}, {
			evicted: undefined,
			retained: { scrollTop: CHAT_WIDGET_VIEW_STATE_CACHE_LIMIT },
		});
	});


	test('allows transcript progress until a hidden bootstrap completes or visible content appears', () => {
		assert.deepStrictEqual({
			empty: shouldShowTranscriptPreparationProgress(0, 0, undefined),
			hiddenPending: shouldShowTranscriptPreparationProgress(1, 0, true),
			hiddenComplete: shouldShowTranscriptPreparationProgress(1, 0, false),
			visiblePending: shouldShowTranscriptPreparationProgress(2, 1, true),
		}, {
			empty: true,
			hiddenPending: true,
			hiddenComplete: false,
			visiblePending: false,
		});
	});

	test('shows the session-list status message in the pre-request progress surface', () => {
		assert.deepStrictEqual({
			fallback: getTranscriptProgress(true, 'Working...'),
			activity: getTranscriptProgress(true, 'Creating isolated worktree (42%)'),
			noActivity: getTranscriptProgress(true, undefined),
			visibleRequest: getTranscriptProgress(false, 'Creating isolated worktree (42%)'),
		}, {
			fallback: 'Working...',
			activity: 'Creating isolated worktree (42%)',
			noActivity: undefined,
			visibleRequest: undefined,
		});
	});

	test('does not show chat tips while the initial request is active', () => {
		assert.deepStrictEqual({
			unbound: shouldShowSessionChatTip(undefined),
			untitled: shouldShowSessionChatTip(SessionStatus.Untitled),
			inProgress: shouldShowSessionChatTip(SessionStatus.InProgress),
			needsInput: shouldShowSessionChatTip(SessionStatus.NeedsInput),
			completed: shouldShowSessionChatTip(SessionStatus.Completed),
		}, {
			unbound: true,
			untitled: true,
			inProgress: false,
			needsInput: false,
			completed: true,
		});
	});

	test('finds transcript context in hidden request attachments', () => {
		const attachment: IChatRequestTranscriptContextVariableEntry = {
			kind: 'transcriptContext',
			id: 'pr',
			name: 'PR',
			value: '{}',
			uri: URI.parse('https://github.com/owner/repo/pull/42'),
		};

		assert.strictEqual(findTranscriptContextEntry([{
			variableData: { variables: [] },
			attachedContext: [attachment],
		}]), attachment);
	});

	test('Agents chat composer does not expose Copilot Agent/Ask/Plan modes', () => {
		const options = createFumieAgentsChatWidgetViewOptions();
		assert.strictEqual(options.supportsChangingModes, false);
		assert.strictEqual(options.isSessionsWindow, true);
		assert.strictEqual(typeof options.modelPickerDelegateAdapter, 'function');
	});

	test('dismisses a phone keyboard only after an accepted input is reset', async () => {
		const host = dom.append(document.body, dom.$('.mobile-keyboard-test-host'));
		const composer = dom.append(host, dom.$('.mobile-keyboard-test-composer'));
		const input = dom.append(composer, dom.$('textarea'));
		const outside = dom.append(host, dom.$('button'));
		disposables.add(toDisposable(() => host.remove()));

		const accepted = disposables.add(new Emitter<void>());
		const loaded = disposables.add(new Emitter<void>());
		const changed = disposables.add(new Emitter<void>());
		let value = 'message';
		let phoneLayout = true;
		disposables.add(installMobileChatKeyboardDismissal({
			onDidAcceptInput: accepted.event,
			onDidLoadInputState: loaded.event,
			onDidChangeInput: changed.event,
			getInputValue: () => value,
			inputContainer: composer,
			isPhoneLayout: () => phoneLayout,
		}));

		input.focus();
		accepted.fire();
		loaded.fire();
		value = '';
		changed.fire();
		await Promise.resolve();
		const phoneAcceptedCleared = document.activeElement !== input;

		input.focus();
		phoneLayout = false;
		value = 'message';
		accepted.fire();
		loaded.fire();
		value = '';
		changed.fire();
		await Promise.resolve();
		const desktopAcceptedCleared = document.activeElement === input;

		input.focus();
		phoneLayout = true;
		value = 'message';
		accepted.fire();
		value = '';
		changed.fire();
		loaded.fire();
		await Promise.resolve();
		const failedSubmissionStayedFocused = document.activeElement === input;

		outside.focus();
		value = 'message';
		accepted.fire();
		loaded.fire();
		value = '';
		changed.fire();
		await Promise.resolve();
		const outsideFocusPreserved = document.activeElement === outside;

		assert.deepStrictEqual({
			phoneAcceptedCleared,
			desktopAcceptedCleared,
			failedSubmissionStayedFocused,
			outsideFocusPreserved,
		}, {
			phoneAcceptedCleared: true,
			desktopAcceptedCleared: true,
			failedSubmissionStayedFocused: true,
			outsideFocusPreserved: true,
		});
	});

	test('the sub-session tip yields the space to a notification and comes back', () => {
		const store = disposables.add(new DisposableStore());
		const noticeHost = store.add(new ChatInputNoticeHost(() => { }));
		const container = dom.$('div');
		store.add(toDisposable(() => container.remove()));

		// Built through the prototype: the banner only needs its storage key, the
		// input's notice host, and somewhere to keep its listeners.
		const widget = Object.create(NewChatInSessionWidget.prototype) as ISubSessionTipRenderer;
		Object.assign(widget, {
			storageService: { getBoolean: () => false, store: () => { } },
			_newChatInput: { noticeHost, focus: () => { } },
			_tipDisposable: store.add(new MutableDisposable()),
		});
		widget._renderSubSessionTip(container);

		const showing = () => {
			const tip = container.querySelector<HTMLElement>('.sub-session-tip-container');
			return !!tip && isChatInputStackSlotShowing(tip);
		};
		const shownInitially = showing();
		// A notification owns the space outright, so the banner must not stack with it.
		noticeHost.setOccupied(ChatInputNoticeLane.Notification, true, { hasFocus: () => false, focus: () => { } });
		const shownUnderNotification = showing();
		noticeHost.setOccupied(ChatInputNoticeLane.Notification, false);

		assert.deepStrictEqual(
			{ shownInitially, shownUnderNotification, shownAfter: showing() },
			{ shownInitially: true, shownUnderNotification: false, shownAfter: true });
	});

});
