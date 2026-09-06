/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { IObservable } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ActionListItemKind, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ClaudeSessionConfigKey } from '../../../../../platform/agentHost/common/claudeSessionConfigKeys.js';
import { SessionConfigPropertySchema } from '../../../../../platform/agentHost/common/state/protocol/commands.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { AgentHostSessionEnumPicker, IAgentHostSessionEnumPickerItem } from './agentHostModePicker.js';
import { isWellKnownClaudePermissionModeSchema } from './agentHostPermissionPickerDelegate.js';

const CLAUDE_PERMISSION_MODE_LEARN_MORE_URL = 'https://code.claude.com/docs/en/permission-modes#available-modes';
const LEARN_MORE_VALUE = '__agentHostClaudePermissionModePicker.learnMore__';
const PRODUCT_PERMISSION_VALUES = ['default', 'auto', 'bypassPermissions'] as const;

function getClaudePermissionModeIcon(value: string | undefined): ThemeIcon | undefined {
	switch (value) {
		case 'default': return Codicon.shield;
		case 'acceptEdits': return Codicon.edit;
		case 'plan': return Codicon.lightbulb;
		case 'auto': return Codicon.sparkle;
		case 'bypassPermissions': return Codicon.warning;
		default: return undefined;
	}
}

export class AgentHostClaudePermissionModePicker extends AgentHostSessionEnumPicker {

	protected readonly _property = ClaudeSessionConfigKey.PermissionMode;
	protected readonly _pickerId = 'agentHostClaudePermissionModePicker';
	protected readonly _telemetryId = 'NewChatAgentHostClaudePermissionModePicker';

	constructor(
		session: IObservable<IActiveSession | undefined>,
		@IActionWidgetService actionWidgetService: IActionWidgetService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super(session, actionWidgetService, sessionsProvidersService, telemetryService, hoverService);
	}

	protected _isWellKnownSchema(schema: SessionConfigPropertySchema): boolean {
		return isWellKnownClaudePermissionModeSchema(schema);
	}

	protected override _getPickerItems(items: readonly IAgentHostSessionEnumPickerItem[], currentValue: string): readonly IAgentHostSessionEnumPickerItem[] {
		const byValue = new Map(items.map(item => [item.value, item]));
		const productItems = PRODUCT_PERMISSION_VALUES.flatMap(value => {
			const item = byValue.get(value);
			if (!item) {
				return [];
			}
			switch (value) {
				case 'default':
					return [{ ...item, label: localize('agentHostPermissionPicker.default.label', "Default Permissions"), description: localize('agentHostPermissionPicker.default.detail', "Ask when needed") }];
				case 'auto':
					return [{ ...item, label: localize('agentHostPermissionPicker.autoReview.label', "Auto-Review"), description: localize('agentHostClaudePermissionModePicker.autoReview.detail', "Claude decides whether each tool operation needs approval") }];
				case 'bypassPermissions':
					return [{ ...item, label: localize('agentHostPermissionPicker.fullAccess.label', "Full Access"), description: localize('agentHostPermissionPicker.fullAccess.detail', "Run tools without asking") }];
			}
		});
		const current = byValue.get(currentValue);
		return current && !PRODUCT_PERMISSION_VALUES.includes(currentValue as typeof PRODUCT_PERMISSION_VALUES[number])
			? [current, ...productItems]
			: productItems;
	}

	protected _getTriggerIcon(value: string | undefined): ThemeIcon | undefined {
		return getClaudePermissionModeIcon(value);
	}

	protected _getActionItemIcon(item: IAgentHostSessionEnumPickerItem): ThemeIcon | undefined {
		return getClaudePermissionModeIcon(item.value);
	}

	protected _getTriggerAriaLabel(label: string): string {
		return localize('agentHostClaudePermissionModePicker.triggerAriaLabel', "Pick Approvals, {0}", label);
	}

	protected _getWidgetAriaLabel(): string {
		return localize('agentHostClaudePermissionModePicker.ariaLabel', "Approvals Picker");
	}

	protected override _getFooterActionItems(): readonly IActionListItem<IAgentHostSessionEnumPickerItem>[] {
		const learnMoreLabel = localize('permissions.learnMore', "Learn more about permissions");
		return [
			{
				kind: ActionListItemKind.Separator,
				label: '',
			},
			{
				kind: ActionListItemKind.Action,
				label: learnMoreLabel,
				group: { title: '', icon: Codicon.blank },
				item: {
					value: LEARN_MORE_VALUE,
					label: learnMoreLabel,
				},
			},
		];
	}

	protected override _handleFooterActionItem(item: IAgentHostSessionEnumPickerItem): boolean {
		if (item.value !== LEARN_MORE_VALUE) {
			return false;
		}
		void this._openerService.open(URI.parse(CLAUDE_PERMISSION_MODE_LEARN_MORE_URL));
		return true;
	}
}
