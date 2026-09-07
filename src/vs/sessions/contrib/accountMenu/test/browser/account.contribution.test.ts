/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { CHAT_SETUP_ACTION_ID } from '../../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ChatPetAchievementIds } from '../../../../../workbench/contrib/chat/browser/chatPetAchievements.js';
import { Menus } from '../../../../browser/menus.js';
import { IsPhoneLayoutContext } from '../../../../common/contextkeys.js';
import { AccountWidgetContribution, claudePlanLabel, getChatGPTRateLimitPresentations, getClaudeRateLimitPresentations, shouldShowAccountPanelSummary } from '../../browser/account.contribution.js';
import { getSessionsChatPetAchievementBadges } from '../../browser/chatPetAchievementBadges.js';

suite('Sessions - Account Menu', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('explains remote control on the GitHub sign-in action', () => {
		const signIn = MenuRegistry.getMenuItems(Menus.AccountMenu)
			.filter(isIMenuItem)
			.find(item => item.command.id === 'workbench.action.agenticSignIn');

		assert.ok(signIn);
		assert.strictEqual(typeof signIn.command.title === 'string' ? signIn.command.title : signIn.command.title.value, 'Sign in to GitHub to enable remote control');
	});

	function accountFooterItems() {
		const footerItems = MenuRegistry.getMenuItems(Menus.SidebarFooter).filter(isIMenuItem);
		return {
			sidebarAccount: footerItems.find(item => item.command.id === 'sessions.action.sidebarAccountWidget'),
			mobileSidebarAccount: footerItems.find(item => item.command.id === 'sessions.action.mobileSidebarAccountWidget'),
		};
	}

	function createWidgetContribution(disposables: DisposableStore, sessionsAccountUI: boolean | undefined): void {
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(IActionViewItemService, new class extends mock<IActionViewItemService>() {
			override register(): IDisposable { return Disposable.None; }
		});
		instantiationService.stub(IProductService, { sessionsAccountUI } as IProductService);
		disposables.add(instantiationService.createInstance(AccountWidgetContribution));
	}

	test('contributes the combined account status widget to the sidebar footer', () => {
		const disposables = new DisposableStore();
		createWidgetContribution(disposables, true);
		const { sidebarAccount, mobileSidebarAccount } = accountFooterItems();

		assert.ok(sidebarAccount);
		assert.ok(mobileSidebarAccount);
		assert.strictEqual(typeof sidebarAccount.command.title === 'string' ? sidebarAccount.command.title : sidebarAccount.command.title.value, 'Agents Account and Status');
		assert.deepStrictEqual({ group: sidebarAccount.group, order: sidebarAccount.order }, { group: 'navigation', order: 1 });
		assert.ok((sidebarAccount.when?.serialize() ?? '').includes(`!${IsPhoneLayoutContext.key}`));
		assert.ok((mobileSidebarAccount.when?.serialize() ?? '').includes(IsPhoneLayoutContext.key));
		assert.ok(!(mobileSidebarAccount.when?.serialize() ?? '').includes(`!${IsPhoneLayoutContext.key}`));
		assert.ok(!MenuRegistry.getMenuItems(Menus.TitleBarRightLayout)
			.filter(isIMenuItem)
			.some(item => item.command.id === 'sessions.action.titleBarAccountWidget'));
		disposables.dispose();
	});

	test('withholds the account row from a client whose product turns the account UI off', () => {
		// The client Fumie serves to a browser asks for `sessionsAccountUI:
		// false` in its `productConfiguration`, which only ever reaches
		// `IProductService`. Reading the built-in product instead is what kept
		// showing that client an account row — and its "Agents Signed Out" —
		// for accounts it has no way to see.
		const disposables = new DisposableStore();
		createWidgetContribution(disposables, false);
		const withAccountUIOff = accountFooterItems();
		disposables.dispose();

		assert.deepStrictEqual({
			sidebarAccount: withAccountUIOff.sidebarAccount,
			mobileSidebarAccount: withAccountUIOff.mobileSidebarAccount,
		}, { sidebarAccount: undefined, mobileSidebarAccount: undefined });
	});

	test('uses the shared Chat setup flow for Copilot sign-in', async () => {
		const executedCommands: string[] = [];
		const command = CommandsRegistry.getCommand('workbench.action.agenticSignIn');
		assert.ok(command);
		const accessor = {
			get: () => ({
				executeCommand: async (commandId: string) => {
					executedCommands.push(commandId);
				},
			}),
		} as ServicesAccessor;

		await command.handler(accessor);

		assert.deepStrictEqual(executedCommands, [CHAT_SETUP_ACTION_ID]);
	});

	test('omits the redundant signed-out summary', () => {
		assert.deepStrictEqual({
			signedOut: shouldShowAccountPanelSummary({ source: 'copilot', kind: 'prominent' }, false, false),
			unavailable: shouldShowAccountPanelSummary({ source: 'copilot', kind: 'warning' }, false, false),
			loading: shouldShowAccountPanelSummary({ source: 'account', kind: 'default' }, false, true),
		}, {
			signedOut: false,
			unavailable: true,
			loading: false,
		});
	});

	test('does not repeat the product name in an already-formatted Claude plan', () => {
		// The SDK's `accountInfo()` reports the display tier, not a bare one.
		assert.strictEqual(claudePlanLabel('Claude Max'), 'Claude Max');
		assert.strictEqual(claudePlanLabel('claude max'), 'Claude max');
		// A bare tier still gets the product name.
		assert.strictEqual(claudePlanLabel('max'), 'Claude Max');
		assert.strictEqual(claudePlanLabel('pro'), 'Claude Pro');
	});

	test('presents Claude rate limits in window order and preserves millisecond reset times', () => {
		const formattedResetTimes: number[] = [];
		const presentations = getClaudeRateLimitPresentations({
			status: 'signedIn',
			rateLimits: {
				fiveHour: { usedPercent: 13, resetsAt: 1_785_000_000_123 },
				sevenDay: { usedPercent: 47, resetsAt: 1_786_000_000_456 },
			},
		}, resetsAt => {
			formattedResetTimes.push(resetsAt);
			return `relative:${resetsAt}`;
		});

		assert.deepStrictEqual(presentations, [
			{
				label: '5-hour limit',
				percentageLabel: '13%',
				percentageAriaLabel: '13% used',
				resetLabel: 'Resets relative:1785000000123',
			},
			{
				label: '7-day limit',
				percentageLabel: '47%',
				percentageAriaLabel: '47% used',
				resetLabel: 'Resets relative:1786000000456',
			},
		]);
		assert.deepStrictEqual(formattedResetTimes, [1_785_000_000_123, 1_786_000_000_456]);
	});

	test('omits unavailable Claude rate limit windows', () => {
		assert.deepStrictEqual(getClaudeRateLimitPresentations({ status: 'signedIn' }), []);
		let formattedResetTime = false;
		assert.deepStrictEqual(getClaudeRateLimitPresentations({
			status: 'signedIn',
			rateLimits: {
				fiveHour: { usedPercent: 21 },
			},
		}, () => {
			formattedResetTime = true;
			return 'unused';
		}), [{
			label: '5-hour limit',
			percentageLabel: '21%',
			percentageAriaLabel: '21% used',
			resetLabel: undefined,
		}]);
		assert.strictEqual(formattedResetTime, false);
		assert.deepStrictEqual(getClaudeRateLimitPresentations({
			status: 'signedIn',
			rateLimits: {
				sevenDay: { usedPercent: 68, resetsAt: 1_786_000_000_456 },
			},
		}, () => 'in 2 days'), [{
			label: '7-day limit',
			percentageLabel: '68%',
			percentageAriaLabel: '68% used',
			resetLabel: 'Resets in 2 days',
		}]);
	});

	test('appends the scoped Claude windows after the plan-wide ones', () => {
		assert.deepStrictEqual(getClaudeRateLimitPresentations({
			status: 'signedIn',
			rateLimits: {
				fiveHour: { usedPercent: 13 },
				sevenDay: { usedPercent: 47 },
				sevenDayOpus: { usedPercent: 61 },
				sevenDaySonnet: { usedPercent: 7 },
				sevenDayOauthApps: { usedPercent: 3 },
				modelScoped: [{ displayName: 'Fable', usedPercent: 55 }],
			},
		}, () => 'unused').map(presentation => presentation.label), [
			'5-hour limit',
			'7-day limit',
			'7-day limit (Opus)',
			'7-day limit (Sonnet)',
			'7-day limit (Apps)',
			'7-day limit (Fable)',
		]);
	});

	test('presents both ChatGPT rate-limit windows and reads their resets as seconds', () => {
		const formattedResetTimes: number[] = [];
		const presentations = getChatGPTRateLimitPresentations({
			status: 'signedIn',
			rateLimit: {
				primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1_785_000_000 },
				secondary: { usedPercent: 42, windowDurationMins: 7 * 24 * 60 },
			},
		}, resetsAt => {
			formattedResetTimes.push(resetsAt);
			return `relative:${resetsAt}`;
		});

		assert.deepStrictEqual(presentations, [
			{
				label: '5-hour limit',
				percentageLabel: '21%',
				percentageAriaLabel: '21% used',
				resetLabel: 'Resets relative:1785000000000',
			},
			{
				label: 'Weekly limit',
				percentageLabel: '42%',
				percentageAriaLabel: '42% used',
				resetLabel: undefined,
			},
		]);
		assert.deepStrictEqual(formattedResetTimes, [1_785_000_000_000]);
	});

	test('omits unavailable ChatGPT rate limit windows and labels unknown durations', () => {
		assert.deepStrictEqual(getChatGPTRateLimitPresentations({ status: 'signedIn' }), []);
		assert.deepStrictEqual(getChatGPTRateLimitPresentations({
			status: 'signedIn',
			rateLimit: { secondary: { usedPercent: 68, windowDurationMins: 24 * 60 } },
		}, () => 'unused').map(presentation => presentation.label), ['Daily limit']);
		assert.deepStrictEqual(getChatGPTRateLimitPresentations({
			status: 'signedIn',
			rateLimit: { primary: { usedPercent: 68 } },
		}, () => 'unused').map(presentation => presentation.label), ['Usage limit']);
	});

	test('shows unlocked badges first while the pet is enabled', () => {
		assert.deepStrictEqual({
			disabled: getSessionsChatPetAchievementBadges(false, [ChatPetAchievementIds.FirstChatMessage]),
			empty: getSessionsChatPetAchievementBadges(true, [])?.map(badge => ({ id: badge.achievement.id, unlocked: badge.unlocked })),
			partial: getSessionsChatPetAchievementBadges(true, [
				ChatPetAchievementIds.IntegratedBrowserShared,
				ChatPetAchievementIds.FirstChatMessage,
			])?.map(badge => ({ id: badge.achievement.id, unlocked: badge.unlocked })),
		}, {
			disabled: undefined,
			empty: [
				{ id: ChatPetAchievementIds.RequestRevision, unlocked: false },
				{ id: ChatPetAchievementIds.FirstChatMessage, unlocked: false },
				{ id: ChatPetAchievementIds.IntegratedBrowserShared, unlocked: false },
				{ id: ChatPetAchievementIds.ModelSwitch, unlocked: false },
				{ id: ChatPetAchievementIds.McpServerPresent, unlocked: false },
				{ id: ChatPetAchievementIds.CustomSkillPresent, unlocked: false },
			],
			partial: [
				{ id: ChatPetAchievementIds.FirstChatMessage, unlocked: true },
				{ id: ChatPetAchievementIds.IntegratedBrowserShared, unlocked: true },
				{ id: ChatPetAchievementIds.RequestRevision, unlocked: false },
				{ id: ChatPetAchievementIds.ModelSwitch, unlocked: false },
				{ id: ChatPetAchievementIds.McpServerPresent, unlocked: false },
				{ id: ChatPetAchievementIds.CustomSkillPresent, unlocked: false },
			],
		});
	});
});
