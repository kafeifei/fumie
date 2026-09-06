/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRenderedMarkdown, MarkdownRenderOptions } from '../../../../base/browser/markdownRenderer.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IMarkdownCodeBlockRenderer, IMarkdownRendererExtraOptions, IMarkdownRendererService, openLinkFromMarkdown } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';

export const REVEAL_LOCAL_FILE_LINK_OPENER_ID = 'sessions.revealLocalFileLinkOpener';

/**
 * Adds Agents Chat-specific link routing while delegating all rendering to the
 * native MarkdownRendererService. The instance is installed only in the
 * Agents ChatView's scoped service collection and inherited by its ChatWidget
 * subtree, so unrelated markdown surfaces retain the standard opener behavior.
 */
export class SessionsChatMarkdownRendererService implements IMarkdownRendererService {

	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly _delegate: IMarkdownRendererService,
		private readonly _openerService: IOpenerService,
	) { }

	render(markdown: IMarkdownString, options?: MarkdownRenderOptions & IMarkdownRendererExtraOptions, outElement?: HTMLElement): IRenderedMarkdown {
		const scopedOptions = options?.actionHandler
			? options
			: {
				...options,
				actionHandler: (link: string, mdStr: IMarkdownString) => {
					void openLinkFromSessionsChatMarkdown(this._openerService, link, mdStr);
				},
			};
		return this._delegate.render(markdown, scopedOptions, outElement);
	}

	setDefaultCodeBlockRenderer(renderer: IMarkdownCodeBlockRenderer): void {
		this._delegate.setDefaultCodeBlockRenderer(renderer);
	}
}

export async function openLinkFromSessionsChatMarkdown(openerService: IOpenerService, link: string, markdown: IMarkdownString): Promise<boolean> {
	let uri: URI;
	try {
		uri = URI.parse(link);
	} catch {
		return openLinkFromMarkdown(openerService, link, markdown.isTrusted);
	}

	if (uri.scheme === Schemas.file && !uri.fragment) {
		try {
			return await openerService.open(link, {
				fromUserGesture: true,
				allowContributedOpeners: REVEAL_LOCAL_FILE_LINK_OPENER_ID,
				allowCommands: false,
			});
		} catch (error) {
			onUnexpectedError(error);
			return false;
		}
	}

	return openLinkFromMarkdown(openerService, link, markdown.isTrusted);
}
