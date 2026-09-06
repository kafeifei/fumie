/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { type AgentSettingsNavId } from './agentSettings.js';

/*
 * Declaration only, deliberately kept out of `agentSettingsOverlay.ts`.
 *
 * That module imports the settings widget, and pages inside the widget need to
 * ask the overlay to close — a cycle that leaves the service decorator in its
 * temporal dead zone when a page's constructor decorators run, and takes the
 * whole window down with it. Nothing here imports the widget, so the cycle
 * cannot form.
 */

export const IAgentSettingsOverlayService = createDecorator<IAgentSettingsOverlayService>('agentSettingsOverlayService');

/**
 * Set while the Settings overlay is shown. Drives the Escape / Cmd+W close
 * keybindings, which must not depend on DOM focus being inside the overlay —
 * right after startup the workbench routinely steals focus from it.
 */
export const AgentSettingsOverlayVisibleContext = new RawContextKey<boolean>('agentSettingsOverlayVisible', false, localize('agentSettingsOverlayVisible', "Whether the Agents Settings overlay is open"));

/**
 * Owns the Settings overlay: a modal surface centered over the Agents
 * workbench that hosts the settings widget. Unlike the custom view grid it does
 * not rearrange the workbench parts underneath — the session layout stays
 * intact and the overlay closes on Esc, backdrop click or Done.
 */
export interface IAgentSettingsOverlayService {

	readonly _serviceBrand: undefined;

	/** Opens the overlay (or refocuses it), optionally selecting a nav entry. */
	open(navId?: AgentSettingsNavId): void;

	close(): void;
}
