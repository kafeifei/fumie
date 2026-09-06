/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { ACP_CLAUDE_AGENT_PROVIDER_ID } from '../../../../../../platform/agentHost/common/agent.js';
import { ACP_CLAUDE_AGENT_SLUG, CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID } from '../../../../../../platform/agentHost/common/agentModelSource.js';
import { languageModelSourcePresentationRegistry } from '../../../common/languageModelSourcePresentation.js';

/**
 * Registers the model-source presentations an agent host provider publishes,
 * under the language model vendor its models were registered with.
 *
 * The same provider reaches the workbench under different vendors depending on
 * where its host runs — `agent-host-<provider>` locally, `remote-<authority>-<provider>`
 * over a connection — so the vendor is the caller's to supply. Without a
 * presentation the group falls back to the raw source id, which is why a remote
 * host used to head its Codex models with the vendor instead of "ChatGPT".
 */
export function registerAgentHostModelSourcePresentations(provider: string, vendor: string): IDisposable {
	const store = new DisposableStore();
	if (provider === 'codex') {
		store.add(languageModelSourcePresentationRegistry.register({
			ownerVendor: vendor,
			sourceId: CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID,
			label: localize('agentHostModelSource.chatGPT.label', "ChatGPT"),
			icon: Codicon.openai,
			description: localize('agentHostModelSource.chatGPT.description', "Models provided by your ChatGPT subscription"),
		}));
	}
	// An ACP model's group would otherwise be headed by the raw vendor id. Each
	// ACP agent is its own provider, so the source id and the vendor both name the
	// same agent; registering the pair is what puts its name and icon on the group.
	if (provider === ACP_CLAUDE_AGENT_PROVIDER_ID) {
		store.add(languageModelSourcePresentationRegistry.register({
			ownerVendor: vendor,
			sourceId: ACP_CLAUDE_AGENT_SLUG,
			label: localize('agentHostModelSource.claudeAcp.label', "Claude (ACPv1)"),
			icon: Codicon.claude,
			description: localize('agentHostModelSource.claudeAcp.description', "Models offered by Claude Code over the Agent Client Protocol"),
		}));
	}
	return store;
}
