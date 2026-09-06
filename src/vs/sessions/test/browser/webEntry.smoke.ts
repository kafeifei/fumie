/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Web-entry smoke test: the widgets a user touches in the Agents window must be
 * creatable in the web build, not only in the desktop one.
 *
 * `sessions.desktop.main.ts` and `sessions.web.main.ts` each import their own
 * registration files, so a service whose registration is reached only from the
 * desktop entry still compiles and still works on desktop. The web build gets an
 * empty or missing UI instead, and nothing says so until a human clicks it —
 * Settings shipped an empty panel because `IRemoteAgentHostInventoryService` was
 * imported only by the desktop entry and `createInstance(AgentSettingsRemoteHosts)`
 * threw `depends on UNKNOWN service`.
 *
 * This file imports the real web entry, so the singleton registry it reads is
 * exactly the one the web bundle ships, and then walks the constructor injection
 * graph of the surfaces below. It resolves that graph rather than running the
 * constructors: resolving dependencies is the first thing `createInstance` does
 * and is where the missing-service failure happens, while actually constructing
 * these widgets would need a booted workbench, a DOM and live agent hosts.
 *
 * Deliberately not named `*.test.ts`. Importing the web entry registers the real
 * file editor factory, which `workbench/test/browser/workbenchTestServices.ts`
 * also registers, and the second one to load throws. Sharing a browser page with
 * the normal suite would make one of them silently fail to load, so this file is
 * kept out of the default `**\/*.test.js` glob and runs on its own page:
 *
 *     npm run test-sessions-web-entry
 */

import assert from 'assert';

// Side-effect import: this is the registration set the web bundle ships.
import '../../sessions.web.main.js';

import { getSingletonServiceDescriptors } from '../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServiceIdentifier, _util } from '../../../platform/instantiation/common/instantiation.js';

import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IDefaultAccountService } from '../../../platform/defaultAccount/common/defaultAccount.js';
import { IEncryptionService } from '../../../platform/encryption/common/encryptionService.js';
import { IEnvironmentService } from '../../../platform/environment/common/environment.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { ILogService, ILoggerService } from '../../../platform/log/common/log.js';
import { IManagedSettingsService, INativeManagedSettingsService } from '../../../platform/policy/common/copilotManagedSettings.js';
import { IPolicyService } from '../../../platform/policy/common/policy.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { IRemoteAuthorityResolverService } from '../../../platform/remote/common/remoteAuthorityResolver.js';
import { IRemoteSocketFactoryService } from '../../../platform/remote/common/remoteSocketFactoryService.js';
import { IRequestService } from '../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../platform/secrets/common/secrets.js';
import { ISignService } from '../../../platform/sign/common/sign.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { IUserDataProfilesService } from '../../../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataSyncStoreManagementService } from '../../../platform/userDataSync/common/userDataSync.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustEnablementService, IWorkspaceTrustManagementService } from '../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchLayoutService } from '../../../workbench/services/layout/browser/layoutService.js';
import { IAccountPolicyGateService } from '../../../workbench/services/policies/common/accountPolicyService.js';
import { IRemoteAgentService } from '../../../workbench/services/remote/common/remoteAgentService.js';
import { IUserDataInitializationService } from '../../../workbench/services/userData/browser/userDataInit.js';
import { IUserDataProfileService } from '../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { IWorkspaceEditingService } from '../../../workbench/services/workspaces/common/workspaceEditing.js';

import { ModelPicker } from '../../contrib/chat/browser/modelPicker.js';
import { NewChatInputWidget } from '../../contrib/chat/browser/newChatInput.js';
import { INewChatModelPickerService } from '../../contrib/chat/browser/newChatModelPicker.js';
import { NewChatWidget } from '../../contrib/chat/browser/newChatWidget.js';
import { ISessionModelSelection } from '../../contrib/chat/browser/sessionModelSelection.js';
import { WorkspacePicker } from '../../contrib/chat/browser/sessionWorkspacePicker.js';
import { WebWorkspacePicker } from '../../contrib/chat/browser/webWorkspacePicker.js';
import { AgentSettingsCustomizationsHost } from '../../contrib/settings/browser/agentSettingsCustomizationsHost.js';
import { AgentSettingsModelsHost } from '../../contrib/settings/browser/agentSettingsModelsHost.js';
import { AgentSettingsOverlayService } from '../../contrib/settings/browser/agentSettingsOverlay.js';
import { AgentSettingsRemoteHosts } from '../../contrib/settings/browser/agentSettingsRemoteHosts.js';
import { AgentSettingsWidget } from '../../contrib/settings/browser/agentSettingsWidget.js';
import { SessionsList } from '../../contrib/sessions/browser/views/sessionsList.js';
import { SessionsView } from '../../contrib/sessions/browser/views/sessionsView.js';

/**
 * Services the workbench bootstrap puts in the collection itself instead of
 * registering as singletons — see `serviceCollection.set(...)` in
 * `workbench/browser/web.main.ts`, `workbench/browser/workbench.ts` and
 * `sessions/browser/web.main.ts`. They are never in the singleton registry, so
 * the walk below has to know about them. When one of these moves to or from
 * `registerSingleton` upstream, this list is what needs updating.
 */
const BOOTSTRAP_SERVICES: readonly ServiceIdentifier<unknown>[] = [
	IAccountPolicyGateService,
	IConfigurationService,
	IDefaultAccountService,
	IEncryptionService,
	IEnvironmentService,
	IFileService,
	IInstantiationService,
	ILogService,
	ILoggerService,
	IManagedSettingsService,
	INativeManagedSettingsService,
	IPolicyService,
	IProductService,
	IRemoteAgentService,
	IRemoteAuthorityResolverService,
	IRemoteSocketFactoryService,
	IRequestService,
	ISecretStorageService,
	ISignService,
	IStorageService,
	IUriIdentityService,
	IUserDataInitializationService,
	IUserDataProfileService,
	IUserDataProfilesService,
	IUserDataSyncStoreManagementService,
	IWorkbenchLayoutService,
	IWorkspaceContextService,
	IWorkspaceEditingService,
	IWorkspaceTrustEnablementService,
	IWorkspaceTrustManagementService,
];

/**
 * Services a parent widget hands to its children through a scoped child
 * instantiation service, so no entry point ever registers them.
 */
const SCOPED_SERVICES: readonly ServiceIdentifier<unknown>[] = [
	INewChatModelPickerService,
	ISessionModelSelection,
];

/**
 * The surfaces a user can reach on the Agents window. Widgets that a parent
 * creates with `createInstance` are listed separately from their parent, because
 * the parent's constructor signature says nothing about what they need.
 */
const SURFACES: readonly (readonly [string, Function])[] = [
	// Settings overlay
	['AgentSettingsOverlayService', AgentSettingsOverlayService],
	['AgentSettingsWidget', AgentSettingsWidget],
	['AgentSettingsCustomizationsHost', AgentSettingsCustomizationsHost],
	['AgentSettingsModelsHost', AgentSettingsModelsHost],
	['AgentSettingsRemoteHosts', AgentSettingsRemoteHosts],
	// Sessions list
	['SessionsView', SessionsView],
	['SessionsList', SessionsList],
	// New-session composer
	['NewChatWidget', NewChatWidget],
	['NewChatInputWidget', NewChatInputWidget],
	['ModelPicker', ModelPicker],
	['WorkspacePicker', WorkspacePicker],
	['WebWorkspacePicker', WebWorkspacePicker],
];

suite('Sessions - web entry', () => {

	const registered = new Map<ServiceIdentifier<unknown>, Function>();
	for (const [id, descriptor] of getSingletonServiceDescriptors()) {
		registered.set(id, descriptor.ctor);
	}
	const provided = new Set<ServiceIdentifier<unknown>>([...BOOTSTRAP_SERVICES, ...SCOPED_SERVICES]);

	test('the web entry registers its singletons', () => {
		// Guards against this file loading without the entry's side effects,
		// which would let every check below pass vacuously.
		assert.ok(registered.size > 100, `expected sessions.web.main.ts to register the workbench singletons, got ${registered.size}`);
	});

	for (const [label, surface] of SURFACES) {
		test(`${label} can be created in the web build`, () => {
			// Breadth-first over constructor injection, following each injected
			// service into its own constructor, the way `createInstance` does.
			const seen = new Set<Function>([surface]);
			const queue: { ctor: Function; path: string }[] = [{ ctor: surface, path: label }];
			while (queue.length) {
				const { ctor, path } = queue.shift()!;
				for (const dependency of _util.getServiceDependencies(ctor as _util.DI_TARGET_OBJ)) {
					const implementation = registered.get(dependency.id);
					if (implementation) {
						if (!seen.has(implementation)) {
							seen.add(implementation);
							queue.push({ ctor: implementation, path: `${path} -> ${implementation.name}` });
						}
						continue;
					}
					if (provided.has(dependency.id)) {
						continue;
					}
					// `assert.ok(false, …)` rather than `assert.fail(…)`: the browser
					// assert shim reports `fail`'s first argument as a truncated value.
					assert.ok(false,
						`${label} cannot be created in the web build: ${path} injects ${dependency.id.toString()}, `
						+ `which sessions.web.main.ts does not register. Import the file that registers it from `
						+ `sessions.web.main.ts (registering it from an electron-browser/ file only reaches the desktop entry), `
						+ `or add it to BOOTSTRAP_SERVICES if the workbench bootstrap provides it.`
					);
				}
			}
		});
	}
});
