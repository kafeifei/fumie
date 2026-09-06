/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse, ParseError } from '../../../../../base/common/json.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ILanguageModelsConfigurationService } from '../../../../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import { SUBSCRIPTION_PROVIDER_DEFINITIONS } from './subscriptionModelProviders.js';

export const SUBSCRIPTION_PROVIDER_DEFAULTS_STORAGE_KEY = 'sessions.subscriptionModels.defaultProvidersInitialized';

/** Add the subscriptions once per profile; subsequent deletion is a user choice. */
export async function initializeDefaultSubscriptionProviders(
	configurationService: ILanguageModelsConfigurationService,
	storageService: IStorageService,
	fileService: IFileService,
): Promise<void> {
	await configurationService.whenReady;
	if (storageService.getBoolean(SUBSCRIPTION_PROVIDER_DEFAULTS_STORAGE_KEY, StorageScope.PROFILE, false)) {
		return;
	}

	// Readiness only means the initial load was attempted. Do not overwrite a
	// malformed user file that the configuration service could not fully parse.
	const content = await fileService.readFile(configurationService.configurationFile);
	const errors: ParseError[] = [];
	const groups: unknown = parse(content.value.toString(), errors, { allowTrailingComma: true });
	if (errors.length || !Array.isArray(groups) || groups.some(group => !group || typeof group.name !== 'string' || typeof group.vendor !== 'string')) {
		throw new Error('Cannot initialize subscription providers in an invalid language models configuration.');
	}

	// Each add persists the whole catalog, so keep writes sequential. Vendor
	// identity preserves an existing entry even when its display name changed.
	for (const definition of SUBSCRIPTION_PROVIDER_DEFINITIONS) {
		if (!configurationService.getLanguageModelsProviderGroups().some(group => group.vendor === definition.vendor)) {
			await configurationService.addLanguageModelsProviderGroup({ vendor: definition.vendor, name: definition.displayName });
		}
	}
	storageService.store(SUBSCRIPTION_PROVIDER_DEFAULTS_STORAGE_KEY, true, StorageScope.PROFILE, StorageTarget.MACHINE);
}
