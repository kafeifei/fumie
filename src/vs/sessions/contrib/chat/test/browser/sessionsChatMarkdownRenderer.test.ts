/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { IRenderedMarkdown, MarkdownRenderOptions } from '../../../../../base/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMarkdownCodeBlockRenderer, IMarkdownRendererExtraOptions, IMarkdownRendererService } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService, OpenOptions } from '../../../../../platform/opener/common/opener.js';
import { REVEAL_LOCAL_FILE_LINK_OPENER_ID, SessionsChatMarkdownRendererService } from '../../browser/sessionsChatMarkdownRenderer.js';

suite('SessionsChatMarkdownRendererService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('marks only local file links without selections for the native reveal opener', async () => {
		let renderedOptions: (MarkdownRenderOptions & IMarkdownRendererExtraOptions) | undefined;
		const openCalls: Array<{ target: string; options?: OpenOptions }> = [];
		const delegate = new class extends mock<IMarkdownRendererService>() {
			override render(_markdown: MarkdownString, options?: MarkdownRenderOptions & IMarkdownRendererExtraOptions): IRenderedMarkdown {
				renderedOptions = options;
				return { element: document.createElement('div'), dispose() { } };
			}
		};
		const openerService = new class extends mock<IOpenerService>() {
			override async open(target: string, options?: OpenOptions): Promise<boolean> {
				openCalls.push({ target, options });
				return false;
			}
		};
		const renderer = new SessionsChatMarkdownRendererService(delegate, openerService);
		const markdown = new MarkdownString('response');

		renderer.render(markdown);
		const actionHandler = renderedOptions?.actionHandler;
		assert.ok(actionHandler);
		actionHandler('file:///workspace/file.txt', markdown);
		actionHandler('file:///workspace/file.txt#L10', markdown);
		actionHandler('https://example.com', markdown);
		actionHandler('vscode-agent-host://remote/workspace/file.txt', markdown);
		await Promise.resolve();

		assert.deepStrictEqual(openCalls.map(call => call.target), [
			'file:///workspace/file.txt',
			'file:///workspace/file.txt#L10',
			'https://example.com',
			'vscode-agent-host://remote/workspace/file.txt',
		]);
		assert.deepStrictEqual(openCalls.map(call => call.options?.allowContributedOpeners), [
			REVEAL_LOCAL_FILE_LINK_OPENER_ID,
			true,
			true,
			true,
		]);
	});

	test('preserves custom action handlers and delegates code block configuration', () => {
		let renderedOptions: (MarkdownRenderOptions & IMarkdownRendererExtraOptions) | undefined;
		let delegatedCodeBlockRenderer: IMarkdownCodeBlockRenderer | undefined;
		const delegate = new class extends mock<IMarkdownRendererService>() {
			override render(_markdown: MarkdownString, options?: MarkdownRenderOptions & IMarkdownRendererExtraOptions): IRenderedMarkdown {
				renderedOptions = options;
				return { element: document.createElement('div'), dispose() { } };
			}

			override setDefaultCodeBlockRenderer(renderer: IMarkdownCodeBlockRenderer): void {
				delegatedCodeBlockRenderer = renderer;
			}
		};
		const renderer = new SessionsChatMarkdownRendererService(delegate, new class extends mock<IOpenerService>() { });
		const customActionHandler = () => { };
		const codeBlockRenderer = new class extends mock<IMarkdownCodeBlockRenderer>() { };

		renderer.render(new MarkdownString('response'), { actionHandler: customActionHandler });
		renderer.setDefaultCodeBlockRenderer(codeBlockRenderer);

		assert.strictEqual(renderedOptions?.actionHandler, customActionHandler);
		assert.strictEqual(delegatedCodeBlockRenderer, codeBlockRenderer);
	});
});
