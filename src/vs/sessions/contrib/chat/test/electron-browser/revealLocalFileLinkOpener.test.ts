/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService, IFileStatWithMetadata, IFileStatWithPartialMetadata } from '../../../../../platform/files/common/files.js';
import { openLinkFromMarkdown } from '../../../../../platform/markdown/browser/markdownRenderer.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IOpener, IOpenerService, OpenOptions } from '../../../../../platform/opener/common/opener.js';
import { openLinkFromSessionsChatMarkdown, REVEAL_LOCAL_FILE_LINK_OPENER_ID } from '../../browser/sessionsChatMarkdownRenderer.js';
import { RevealLocalFileLinkOpenerContribution } from '../../electron-browser/revealLocalFileLinkOpener.js';

interface ITestEntry {
	readonly isDirectory: boolean;
	readonly children?: readonly URI[];
}

suite('RevealLocalFileLinkOpenerContribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHarness(entries: ReadonlyMap<string, ITestEntry>, failNativeReveal = false) {
		let registeredOpener: IOpener | undefined;
		const statCalls: URI[] = [];
		const resolveCalls: URI[] = [];
		const shownPaths: string[] = [];

		const openerService = new class extends mock<IOpenerService>() {
			override registerOpener(opener: IOpener): IDisposable {
				registeredOpener = opener;
				return Disposable.None;
			}

			override async open(resource: URI | string, options?: OpenOptions): Promise<boolean> {
				return registeredOpener?.open(resource, options) ?? false;
			}
		};
		const fileService = new class extends mock<IFileService>() {
			override async stat(resource: URI): Promise<IFileStatWithPartialMetadata> {
				statCalls.push(resource);
				const entry = entries.get(resource.toString());
				if (!entry) {
					throw new Error(`Missing test resource: ${resource.toString()}`);
				}
				return upcastPartial<IFileStatWithPartialMetadata>({
					resource,
					isFile: !entry.isDirectory,
					isDirectory: entry.isDirectory,
					isSymbolicLink: false,
				});
			}

			override async resolve(resource: URI): Promise<IFileStatWithMetadata> {
				resolveCalls.push(resource);
				const entry = entries.get(resource.toString());
				if (!entry) {
					throw new Error(`Missing test resource: ${resource.toString()}`);
				}
				return upcastPartial<IFileStatWithMetadata>({
					resource,
					isFile: !entry.isDirectory,
					isDirectory: entry.isDirectory,
					isSymbolicLink: false,
					children: entry.children?.map(child => upcastPartial<IFileStatWithMetadata>({
						resource: child,
						isFile: true,
						isDirectory: false,
						isSymbolicLink: false,
					})),
				});
			}
		};
		const nativeHostService = new class extends mock<INativeHostService>() {
			override async showItemInFolder(path: string): Promise<void> {
				shownPaths.push(path);
				if (failNativeReveal) {
					throw new Error('Native reveal failed');
				}
			}
		};

		store.add(new RevealLocalFileLinkOpenerContribution(openerService, fileService, nativeHostService));
		if (!registeredOpener) {
			throw new Error('Expected the contribution to register an opener');
		}

		return { openerService, opener: registeredOpener, statCalls, resolveCalls, shownPaths };
	}

	test('reveals scoped Chat markdown files and locates folders in the OS file manager', async () => {
		const file = URI.file('/workspace/file.txt');
		const folder = URI.file('/workspace/folder');
		const child = URI.file('/workspace/folder/child.txt');
		const emptyFolder = URI.file('/workspace/empty');
		const markdown = new MarkdownString('response');
		const harness = createHarness(new Map([
			[file.toString(), { isDirectory: false }],
			[folder.toString(), { isDirectory: true, children: [child] }],
			[emptyFolder.toString(), { isDirectory: true, children: [] }],
		]));

		assert.deepStrictEqual([
			await openLinkFromSessionsChatMarkdown(harness.openerService, file.toString(), markdown),
			await openLinkFromSessionsChatMarkdown(harness.openerService, folder.toString(), markdown),
			await openLinkFromSessionsChatMarkdown(harness.openerService, emptyFolder.toString(), markdown),
		], [true, true, true]);
		assert.deepStrictEqual(harness.shownPaths, [file.fsPath, child.fsPath, emptyFolder.fsPath]);
		assert.deepStrictEqual(harness.statCalls.map(resource => resource.toString()), [file, folder, emptyFolder].map(resource => resource.toString()));
		assert.deepStrictEqual(harness.resolveCalls.map(resource => resource.toString()), [folder, emptyFolder].map(resource => resource.toString()));
	});

	test('does not intercept generic markdown, programmatic opens, or editor-directed opens', async () => {
		const file = URI.file('/workspace/file.txt');
		const harness = createHarness(new Map([[file.toString(), { isDirectory: false }]]));
		const markedOptions: OpenOptions = {
			fromUserGesture: true,
			allowContributedOpeners: REVEAL_LOCAL_FILE_LINK_OPENER_ID,
			allowCommands: false,
		};
		const rejectedOptions: Array<OpenOptions | undefined> = [
			undefined,
			{ ...markedOptions, fromUserGesture: false },
			{ ...markedOptions, allowContributedOpeners: true },
			{ ...markedOptions, allowCommands: true },
			{ ...markedOptions, fromWorkspace: true },
			{ ...markedOptions, openExternal: true },
			{ ...markedOptions, openToSide: true },
			{ ...markedOptions, editorOptions: {} },
		];

		assert.strictEqual(await openLinkFromMarkdown(harness.openerService, file.toString(), false), false);
		assert.strictEqual(await harness.opener.open(file, markedOptions), false);
		for (const options of rejectedOptions) {
			assert.strictEqual(await harness.opener.open(file.toString(), options), false);
		}
		assert.deepStrictEqual(harness.statCalls, []);
		assert.deepStrictEqual(harness.resolveCalls, []);
		assert.deepStrictEqual(harness.shownPaths, []);
	});

	test('leaves selections, non-file schemes, and missing paths to later openers', async () => {
		const missing = URI.file('/workspace/missing.txt');
		const markdown = new MarkdownString('response');
		const harness = createHarness(new Map());

		assert.deepStrictEqual([
			await openLinkFromSessionsChatMarkdown(harness.openerService, `${missing.toString()}#L10`, markdown),
			await openLinkFromSessionsChatMarkdown(harness.openerService, 'https://example.com', markdown),
			await openLinkFromSessionsChatMarkdown(harness.openerService, 'vscode-remote://ssh-remote+host/workspace/file.txt', markdown),
			await openLinkFromSessionsChatMarkdown(harness.openerService, missing.toString(), markdown),
		], [false, false, false, false]);
		assert.deepStrictEqual(harness.statCalls.map(resource => resource.toString()), [missing.toString()]);
		assert.deepStrictEqual(harness.resolveCalls, []);
		assert.deepStrictEqual(harness.shownPaths, []);
	});

	test('falls through when the native file manager reveal fails', async () => {
		const file = URI.file('/workspace/file.txt');
		const harness = createHarness(new Map([[file.toString(), { isDirectory: false }]]), true);

		assert.strictEqual(await openLinkFromSessionsChatMarkdown(harness.openerService, file.toString(), new MarkdownString('response')), false);
		assert.deepStrictEqual(harness.statCalls.map(resource => resource.toString()), [file.toString()]);
		assert.deepStrictEqual(harness.shownPaths, [file.fsPath]);
	});
});
