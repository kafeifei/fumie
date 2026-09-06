/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IFileContent, IFileService } from '../../../../../../platform/files/common/files.js';
import { InMemoryStorageService, StorageScope } from '../../../../../../platform/storage/common/storage.js';
import { ILanguageModelsConfigurationService, ILanguageModelsProviderGroup } from '../../../../../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import { initializeDefaultSubscriptionProviders, SUBSCRIPTION_PROVIDER_DEFAULTS_STORAGE_KEY } from '../../browser/subscriptionModelDefaults.js';

suite('subscriptionModelDefaults', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function fixture(groups: ILanguageModelsProviderGroup[] = [], content?: string) {
		const storage = store.add(new InMemoryStorageService());
		const configuration = new class extends mock<ILanguageModelsConfigurationService>() {
			override readonly configurationFile = URI.file('/profile/chatLanguageModels.json');
			override whenReady = Promise.resolve();
			groups = [...groups];
			readonly writes: string[] = [];
			failVendor: string | undefined;
			override getLanguageModelsProviderGroups() { return this.groups; }
			override async addLanguageModelsProviderGroup(group: ILanguageModelsProviderGroup) {
				if (group.vendor === this.failVendor) {
					throw new Error('save failed');
				}
				this.writes.push(group.vendor);
				this.groups.push(group);
				return group;
			}
		};
		const files = new class extends mock<IFileService>() {
			override async readFile() {
				return { value: VSBuffer.fromString(content ?? JSON.stringify(configuration.groups)) } as IFileContent;
			}
		};
		return {
			configuration,
			run: () => initializeDefaultSubscriptionProviders(configuration, storage, files),
			initialized: () => storage.getBoolean(SUBSCRIPTION_PROVIDER_DEFAULTS_STORAGE_KEY, StorageScope.PROFILE, false),
		};
	}

	test('a fresh profile gets both subscriptions without credentials or model overrides', async () => {
		const f = fixture();
		await f.run();
		assert.deepStrictEqual(f.configuration.groups, [
			{ vendor: 'claude-subscription', name: 'Claude Subscription' },
			{ vendor: 'codex-subscription', name: 'Codex Subscription' },
		]);
		assert.strictEqual(f.initialized(), true);
	});

	test('waits for the saved catalog and preserves renamed subscriptions and other providers', async () => {
		const f = fixture();
		const ready = new DeferredPromise<void>();
		f.configuration.whenReady = ready.p;
		const initialization = f.run();
		assert.deepStrictEqual(f.configuration.writes, []);
		const existing = [
			{ vendor: 'codex-subscription', name: 'My ChatGPT', settings: { model: { thinkingLevel: 'high' } } },
			{ vendor: 'customendpoint', name: 'Local endpoint', url: 'http://localhost:8080' },
		];
		f.configuration.groups = [...existing];
		await ready.complete();
		await initialization;
		assert.deepStrictEqual(f.configuration.groups.slice(0, 2), existing);
		assert.deepStrictEqual(f.configuration.writes, ['claude-subscription']);
	});

	test('does not add duplicate entries when both subscriptions already exist', async () => {
		const f = fixture([
			{ vendor: 'claude-subscription', name: 'My Claude' },
			{ vendor: 'codex-subscription', name: 'My ChatGPT' },
		]);
		await f.run();
		assert.deepStrictEqual(f.configuration.writes, []);
		assert.strictEqual(f.initialized(), true);
	});

	test('a later startup preserves a user deletion', async () => {
		const f = fixture();
		await f.run();
		f.configuration.groups = [];
		f.configuration.writes.length = 0;
		await f.run();
		assert.deepStrictEqual(f.configuration.groups, []);
		assert.deepStrictEqual(f.configuration.writes, []);
	});

	test('a failed save leaves initialization retryable without duplicating the successful entry', async () => {
		const f = fixture();
		f.configuration.failVendor = 'codex-subscription';
		await assert.rejects(f.run(), /save failed/);
		assert.strictEqual(f.initialized(), false);
		assert.deepStrictEqual(f.configuration.writes, ['claude-subscription']);
		f.configuration.failVendor = undefined;
		await f.run();
		assert.deepStrictEqual(f.configuration.writes, ['claude-subscription', 'codex-subscription']);
		assert.strictEqual(f.initialized(), true);
	});

	for (const content of ['[{', '{}', '[{"vendor":"customendpoint"}]']) {
		test(`does not overwrite an invalid configuration: ${content}`, async () => {
			const f = fixture([], content);
			await assert.rejects(f.run(), /invalid language models configuration/);
			assert.deepStrictEqual(f.configuration.writes, []);
			assert.strictEqual(f.initialized(), false);
		});
	}

	test('accepts the catalog JSONC format', async () => {
		const f = fixture([], '[/* providers */]');
		await f.run();
		assert.strictEqual(f.initialized(), true);
	});
});
