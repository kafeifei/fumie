/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CHATGPT_SUBSCRIPTION_MODELS, type IChatGptSubscriptionCredentials, type IChatGptSubscriptionService } from '../../node/chatGptSubscription.js';

/**
 * An {@link IChatGptSubscriptionService} for tests that never signs anyone in
 * and holds no disposables, so a suite can stub it without owning its lifetime.
 * Pass `credentials` for the signed-in case.
 */
export function createTestChatGptSubscriptionService(credentials?: IChatGptSubscriptionCredentials): IChatGptSubscriptionService {
	return {
		_serviceBrand: undefined,
		onDidChangeSignedIn: Event.None,
		registerSource: () => Disposable.None,
		getModels: () => credentials ? CHATGPT_SUBSCRIPTION_MODELS : [],
		isSignedIn: () => !!credentials,
		readCredentials: async () => {
			if (!credentials) {
				throw new Error('No ChatGPT subscription is available in this agent host.');
			}
			return credentials;
		},
	};
}
