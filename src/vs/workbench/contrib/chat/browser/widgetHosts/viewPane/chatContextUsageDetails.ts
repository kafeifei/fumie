/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatContextUsageDetails.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { toAction, type IAction } from '../../../../../../base/common/actions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../../../../../base/common/observable.js';
import { localize } from '../../../../../../nls.js';
import { IMenuService, MenuId } from '../../../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchButtonBar } from '../../../../../../platform/actions/browser/buttonbar.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { getActionBarActions } from '../../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { formatCopilotCredits, type IChatUsageModelTotal } from '../../../common/chatService/chatService.js';
import type { IChatWidget } from '../../chat.js';

const $ = dom.$;

const COMPACT_AGENT_HOST_CONVERSATION_ACTION_ID = 'workbench.action.chat.compactAgentHostConversation';

export interface IChatContextUsagePromptTokenDetail {
	category: string;
	label: string;
	percentageOfPrompt: number;
}

export interface IChatContextUsageData {
	usedTokens: number;
	completionTokens: number;
	totalContextWindow: number;
	percentage: number;
	outputBufferPercentage?: number;
	promptTokenDetails?: readonly IChatContextUsagePromptTokenDetail[];
	sessionCost?: number;
	/** Prompt-cache read hits of the most recent model call, when reported. */
	cachedPromptTokens?: number;
	/** Whole-turn token totals per model, when the provider reports them. */
	modelTotals?: readonly IChatUsageModelTotal[];
}

/**
 * Detailed widget that shows context usage breakdown.
 * Displayed when the user clicks on the ChatContextUsageIcon.
 */
export class ChatContextUsageDetails extends Disposable {

	readonly domNode: HTMLElement;

	private readonly sessionCostSection: HTMLElement;
	private readonly sessionCostValue: HTMLElement;
	private readonly quotaItem: HTMLElement;
	private readonly percentageLabel: HTMLElement;
	private readonly tokenCountLabel: HTMLElement;
	private readonly progressFill: HTMLElement;
	private readonly outputBufferFill: HTMLElement;
	private readonly outputBufferLegend: HTMLElement;
	private readonly tokenDetailsContainer: HTMLElement;
	private readonly callBreakdownContainer: HTMLElement;
	private readonly warningMessage: HTMLElement;
	private readonly noDataMessage: HTMLElement;
	private readonly actionsSection: HTMLElement;

	constructor(
		private _chatWidget: IChatWidget | undefined,
		private readonly _dataObservable: IObservable<IChatContextUsageData | undefined>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();

		this.domNode = $('.chat-context-usage-details');

		// Top-level header
		const topHeader = this.domNode.appendChild($('div.header'));
		topHeader.textContent = localize('sessionInfo', "Session Info");

		// Session cost section (hidden until cost data is available)
		this.sessionCostSection = this.domNode.appendChild($('.session-cost-section'));
		this.sessionCostSection.style.display = 'none';
		const sessionCostRow = this.sessionCostSection.appendChild($('.session-cost-row'));
		const sessionCostLabel = sessionCostRow.appendChild($('span.session-cost-label'));
		sessionCostLabel.textContent = localize('sessionCost', "Session Cost");
		this.sessionCostValue = sessionCostRow.appendChild($('span.session-cost-value'));

		// Quota indicator — using same structure as ChatStatusDashboard
		this.quotaItem = this.domNode.appendChild($('.quota-indicator'));

		// Context Window header
		const header = this.domNode.insertBefore($('div.header'), this.quotaItem);
		header.textContent = localize('contextWindow', "Context Window");

		// Quota label row with token count + percentage
		const quotaLabel = this.quotaItem.appendChild($('.quota-label'));
		this.tokenCountLabel = quotaLabel.appendChild($('span'));
		this.percentageLabel = quotaLabel.appendChild($('span.quota-value'));

		// Progress bar
		const progressBar = this.quotaItem.appendChild($('.quota-bar'));
		this.progressFill = progressBar.appendChild($('.quota-bit'));
		this.outputBufferFill = progressBar.appendChild($('.quota-bit.output-buffer'));

		// Output buffer legend (shown only when outputBuffer is provided)
		this.outputBufferLegend = this.quotaItem.appendChild($('.output-buffer-legend'));
		this.outputBufferLegend.appendChild($('.output-buffer-swatch'));
		const legendLabel = this.outputBufferLegend.appendChild($('span'));
		legendLabel.textContent = localize('outputReserved', "Reserved for response");
		this.outputBufferLegend.style.display = 'none';

		// Token details container (for category breakdown)
		this.tokenDetailsContainer = this.domNode.appendChild($('.token-details-container'));

		// Provider-agnostic breakdown: last call's prompt composition and
		// whole-turn per-model totals. Rendered from data every provider
		// reports, unlike the category breakdown above (Copilot-only).
		this.callBreakdownContainer = this.domNode.appendChild($('.token-details-container'));

		// Warning message (shown when usage is high)
		this.warningMessage = this.domNode.appendChild($('div.description'));
		this.warningMessage.textContent = localize('qualityWarning', "Quality may decline as limit nears.");
		this.warningMessage.style.display = 'none';

		// Placeholder hint (shown before the session has reported any usage)
		this.noDataMessage = this.domNode.appendChild($('div.description'));
		this.noDataMessage.textContent = localize('noUsageYet', "Token usage appears once the model's first response completes.");
		this.noDataMessage.style.display = 'none';

		// Actions section with button bar
		this.actionsSection = this.domNode.appendChild($('.actions-section'));
		const buttonBarContainer = this.actionsSection.appendChild($('.button-bar-container'));
		const buttonBar = this._register(this.instantiationService.createInstance(WorkbenchButtonBar, buttonBarContainer, {
			buttonConfigProvider: () => ({ isSecondary: true })
		}));

		// Listen to menu changes to show/hide actions section
		const menu = this._register(this.menuService.createMenu(MenuId.ChatContextUsageActions, this.contextKeyService));
		const updateActions = () => {
			const actions = getActionBarActions(menu.getActions({ shouldForwardArgs: true }), () => true);
			const primaryActions = actions.primary.map(action => this.withActionContext(action));
			const secondaryActions = actions.secondary.map(action => this.withActionContext(action));
			buttonBar.update(primaryActions, secondaryActions);
			this.actionsSection.style.display = primaryActions.length > 0 || secondaryActions.length > 0 ? '' : 'none';
		};
		this._register(menu.onDidChange(updateActions));
		updateActions();

		this._register(autorun(reader => {
			const data = this._dataObservable.read(reader);
			// `undefined` is a deliberate state — the session has not reported
			// usage yet (new session, or a turn still in flight) — rendered as
			// an explicit placeholder rather than keeping stale numbers.
			if (data) {
				this._render(data);
			} else {
				this._renderPlaceholder();
			}
		}));
	}

	setChatWidget(widget: IChatWidget): void {
		this._chatWidget = widget;
	}

	private withActionContext(action: IAction): IAction {
		// Only the workbench-owned compact action can receive the in-memory widget.
		// Extension-contributed commands must stay argument-free because widgets are not serializable across the extension host boundary.
		if (action.id !== COMPACT_AGENT_HOST_CONVERSATION_ACTION_ID) {
			return action;
		}

		return toAction({
			id: action.id,
			label: action.label,
			tooltip: action.tooltip,
			class: action.class,
			enabled: action.enabled,
			checked: action.checked,
			run: () => action.run(this._chatWidget),
		});
	}

	/** Empty state: no usage reported yet. `–` in place of numbers, plus a hint. */
	private _renderPlaceholder(): void {
		this.sessionCostSection.style.display = 'none';
		this.tokenCountLabel.textContent = localize('tokenCountUnknown', "– tokens");
		this.percentageLabel.textContent = '–';
		this.progressFill.style.width = '0';
		this.outputBufferFill.style.width = '0';
		this.outputBufferFill.style.display = 'none';
		this.outputBufferLegend.style.display = 'none';
		this.quotaItem.classList.remove('warning', 'error');
		dom.clearNode(this.tokenDetailsContainer);
		this.tokenDetailsContainer.style.display = 'none';
		dom.clearNode(this.callBreakdownContainer);
		this.callBreakdownContainer.style.display = 'none';
		this.warningMessage.style.display = 'none';
		this.noDataMessage.style.display = '';
	}

	private _render(data: IChatContextUsageData): void {
		const { percentage, usedTokens, totalContextWindow, outputBufferPercentage, promptTokenDetails, sessionCost } = data;
		this.noDataMessage.style.display = 'none';

		// Update session cost — hide section when no cost data is available
		if (typeof sessionCost === 'number' && sessionCost > 0) {
			const formatted = formatCopilotCredits(sessionCost);
			this.sessionCostValue.textContent = formatted === '1'
				? localize('sessionCostCredit', "{0} credit", formatted)
				: localize('sessionCostCredits', "{0} credits", formatted);
			this.sessionCostSection.style.display = '';
		} else {
			this.sessionCostSection.style.display = 'none';
		}

		// Update token count and percentage — reflects actual usage only
		this.tokenCountLabel.textContent = localize(
			'tokenCount',
			"{0} / {1} tokens",
			this.formatTokenCount(usedTokens, 1),
			this.formatTokenCount(totalContextWindow, 0)
		);
		this.percentageLabel.textContent = localize('quotaDisplay', "{0}%", Math.min(100, percentage).toFixed(0));

		// Progress bar: actual usage fill + remaining reserved output fill
		const usageBarWidth = Math.max(0, Math.min(100, percentage));
		this.progressFill.style.width = `${usageBarWidth}%`;

		if (outputBufferPercentage !== undefined && outputBufferPercentage > 0) {
			// Clamp so the reserve never overflows the bar
			this.outputBufferFill.style.width = `${Math.max(0, Math.min(100 - usageBarWidth, outputBufferPercentage))}%`;
			this.outputBufferFill.style.display = '';
			this.outputBufferLegend.style.display = '';
		} else {
			this.outputBufferFill.style.width = '0';
			this.outputBufferFill.style.display = 'none';
			this.outputBufferLegend.style.display = 'none';
		}

		// Color classes based on actual usage percentage
		this.quotaItem.classList.remove('warning', 'error');
		if (percentage >= 90) {
			this.quotaItem.classList.add('error');
		} else if (percentage >= 75) {
			this.quotaItem.classList.add('warning');
		}

		// Render token details breakdown if available
		this.renderTokenDetails(promptTokenDetails, percentage);
		this.renderCallBreakdown(data);

		// Show/hide warning message
		this.warningMessage.style.display = percentage >= 75 ? '' : 'none';
	}

	/**
	 * Renders the provider-agnostic breakdown: the last call's prompt
	 * composition (cached vs fresh) and whole-turn per-model totals.
	 */
	private renderCallBreakdown(data: IChatContextUsageData): void {
		dom.clearNode(this.callBreakdownContainer);
		const promptTokens = Math.max(0, data.usedTokens - data.completionTokens);
		const cached = data.cachedPromptTokens;
		const hasCacheRow = typeof cached === 'number' && cached > 0 && promptTokens > 0;
		const modelTotals = data.modelTotals?.filter(t => t.inputTokens + t.cachedTokens + t.outputTokens > 0) ?? [];
		if (!hasCacheRow && modelTotals.length === 0) {
			this.callBreakdownContainer.style.display = 'none';
			return;
		}
		this.callBreakdownContainer.style.display = '';

		if (hasCacheRow) {
			const section = this.callBreakdownContainer.appendChild($('.token-category'));
			section.appendChild($('.token-category-header')).textContent = localize('lastCall', "Last model call");
			const promptRow = section.appendChild($('.token-detail-item'));
			promptRow.appendChild($('.token-detail-label')).textContent = localize('lastCallPrompt', "Prompt");
			promptRow.appendChild($('.token-detail-value')).textContent = localize(
				'lastCallPromptValue', "{0} ({1}% cached)",
				this.formatTokenCount(promptTokens, 1),
				Math.min(100, Math.round((cached / promptTokens) * 100)),
			);
			const outputRow = section.appendChild($('.token-detail-item'));
			outputRow.appendChild($('.token-detail-label')).textContent = localize('lastCallOutput', "Output");
			outputRow.appendChild($('.token-detail-value')).textContent = this.formatTokenCount(data.completionTokens, 1);
		}

		if (modelTotals.length > 0) {
			const section = this.callBreakdownContainer.appendChild($('.token-category'));
			section.appendChild($('.token-category-header')).textContent = localize('turnTotals', "This turn by model");
			for (const total of modelTotals) {
				const row = section.appendChild($('.token-detail-item'));
				row.appendChild($('.token-detail-label')).textContent = total.model;
				row.appendChild($('.token-detail-value')).textContent = localize(
					'turnTotalValue', "in {0} · cached {1} · out {2}",
					this.formatTokenCount(total.inputTokens, 1),
					this.formatTokenCount(total.cachedTokens, 1),
					this.formatTokenCount(total.outputTokens, 1),
				);
			}
		}
	}

	private formatTokenCount(count: number, decimals: number): string {
		// Use M when count is >= 1M, or when K representation would round to 1000K
		const mThreshold = 1000000 - 500 * Math.pow(10, -decimals);

		if (count >= mThreshold) {
			return `${(count / 1000000).toFixed(decimals)}M`;
		} else if (count >= 1000) {
			return `${(count / 1000).toFixed(decimals)}K`;
		}
		return count.toString();
	}

	private renderTokenDetails(details: readonly IChatContextUsagePromptTokenDetail[] | undefined, contextWindowPercentage: number): void {
		// Clear previous content
		dom.clearNode(this.tokenDetailsContainer);

		if (!details || details.length === 0) {
			this.tokenDetailsContainer.style.display = 'none';
			return;
		}

		this.tokenDetailsContainer.style.display = '';

		// Group details by category
		const categoryMap = new Map<string, { label: string; percentageOfPrompt: number }[]>();
		let totalPercentage = 0;

		for (const detail of details) {
			const existing = categoryMap.get(detail.category) || [];
			existing.push({ label: detail.label, percentageOfPrompt: detail.percentageOfPrompt });
			categoryMap.set(detail.category, existing);
			totalPercentage += detail.percentageOfPrompt;
		}

		// Add uncategorized if percentages don't sum to 100%
		if (totalPercentage < 100) {
			const uncategorizedPercentage = 100 - totalPercentage;
			categoryMap.set(localize('uncategorized', "Uncategorized"), [
				{ label: localize('other', "Other"), percentageOfPrompt: uncategorizedPercentage }
			]);
		}

		// Render each category
		for (const [category, items] of categoryMap) {
			// Filter out items with 0% usage
			const visibleItems = items.filter(item => {
				const contextRelativePercentage = (item.percentageOfPrompt / 100) * contextWindowPercentage;
				return contextRelativePercentage >= 0.05; // Show if at least 0.1% when rounded
			});

			if (visibleItems.length === 0) {
				continue;
			}

			const categorySection = this.tokenDetailsContainer.appendChild($('.token-category'));

			// Category header
			const categoryHeader = categorySection.appendChild($('.token-category-header'));
			categoryHeader.textContent = category;

			// Category items
			for (const item of visibleItems) {
				const itemRow = categorySection.appendChild($('.token-detail-item'));

				const itemLabel = itemRow.appendChild($('.token-detail-label'));
				itemLabel.textContent = item.label;

				// Calculate percentage relative to context window
				// E.g., if context window is at 10% and item uses 10% of prompt, show 1%
				const contextRelativePercentage = (item.percentageOfPrompt / 100) * contextWindowPercentage;

				const itemValue = itemRow.appendChild($('.token-detail-value'));
				itemValue.textContent = `${contextRelativePercentage.toFixed(1)}%`;
			}
		}
	}

	focus(): void {
		this.domNode.focus();
	}
}
