/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProductService } from '../../product/common/productService.js';

/**
 * The single composition point for the session-level host briefing
 * (`product.agentHostInstructions`): the static text telling a hosted agent it
 * runs inside this product. It is session-constant knowledge, delivered exactly
 * once per session through each provider's own system-prompt channel (Claude
 * `systemPrompt.append`, Codex `developer_instructions`, Copilot
 * `systemMessage`, DeepSeek persona, Kimi instruction file, Pi system prompt).
 * A provider whose protocol has no such channel (ACP v1) delivers nothing.
 *
 * It must never ride the per-operation host-instructions channel or otherwise
 * enter user content — that channel is for per-turn dynamic context only.
 * See docs/architecture.md.
 */
export function composeSessionHostContext(productService: IProductService): string | undefined {
	const instructions = productService.agentHostInstructions;
	return instructions?.length ? instructions.join('\n\n') : undefined;
}
