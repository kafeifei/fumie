/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../../test/common/workbenchTestServices.js';
import { Memento } from '../../../../../common/memento.js';
import { ChatTodoListStorage, type IChatTodo } from '../../../common/tools/chatTodoListService.js';

suite('ChatTodoListStorage', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => Memento.clear(StorageScope.WORKSPACE));

	test('removes legacy Codex plan todos once and preserves other providers', () => {
		const storageService = disposables.add(new TestStorageService());
		const seedMemento = new Memento<Record<string, IChatTodo[]>>('chat-todo-list', storageService);
		const seeded = seedMemento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE);
		seeded['agent-host-codex:/legacy'] = [{ id: 1, title: 'Old Codex plan', status: 'in-progress' }];
		seeded['agent-host-claude:/keep'] = [{ id: 2, title: 'Claude todo', status: 'not-started' }];
		seedMemento.saveMemento();

		const storage = new ChatTodoListStorage(storageService);
		assert.deepStrictEqual(storage.getTodoList(URI.parse('agent-host-codex:/legacy')), []);
		assert.deepStrictEqual(storage.getTodoList(URI.parse('agent-host-claude:/keep')), [{ id: 2, title: 'Claude todo', status: 'not-started' }]);

		storage.setTodoList(URI.parse('agent-host-codex:/new'), [{ id: 3, title: 'Post-migration value', status: 'in-progress' }]);
		const secondInstance = new ChatTodoListStorage(storageService);
		assert.deepStrictEqual(secondInstance.getTodoList(URI.parse('agent-host-codex:/new')), [{ id: 3, title: 'Post-migration value', status: 'in-progress' }]);
	});
});
