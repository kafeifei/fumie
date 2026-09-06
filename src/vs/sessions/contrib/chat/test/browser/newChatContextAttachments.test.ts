/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChatRequestVariableEntry } from '../../../../../workbench/contrib/chat/common/attachments/chatVariableEntries.js';
import { ChatAttachmentModel } from '../../../../../workbench/contrib/chat/browser/attachments/chatAttachmentModel.js';
import { NewChatContextAttachments } from '../../browser/newChatContextAttachments.js';

suite('NewChatContextAttachments', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('delegates attachment state to the native chat attachment model', () => {
		const calls: string[] = [];
		const nativeModel = {
			attachments: [],
			clearAndSetContext: (...entries: IChatRequestVariableEntry[]) => calls.push(`set:${entries.map(entry => entry.id).join(',')}`),
			addContext: (...entries: IChatRequestVariableEntry[]) => calls.push(`add:${entries.map(entry => entry.id).join(',')}`),
			delete: (...ids: string[]) => calls.push(`delete:${ids.join(',')}`),
			clear: (clearStickyAttachments?: boolean) => calls.push(`clear:${clearStickyAttachments}`),
		} as unknown as ChatAttachmentModel;
		const harness = { _attachmentModel: nativeModel };
		const file = { kind: 'file', id: 'file', name: 'file.ts', value: URI.file('/workspace/file.ts') } satisfies IChatRequestVariableEntry;

		Reflect.get(NewChatContextAttachments.prototype, 'setAttachments').call(harness, [file]);
		Reflect.get(NewChatContextAttachments.prototype, 'addAttachments').call(harness, file);
		Reflect.get(NewChatContextAttachments.prototype, 'removeAttachment').call(harness, file.id);
		Reflect.get(NewChatContextAttachments.prototype, 'clear').call(harness);

		assert.deepStrictEqual(calls, [
			'set:file',
			'add:file',
			'delete:file',
			'clear:true',
		]);
	});
});
