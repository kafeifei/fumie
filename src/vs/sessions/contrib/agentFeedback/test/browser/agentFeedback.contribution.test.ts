/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, isDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IAgentEditorCommentsBridge } from '../../../../../workbench/services/agentEditorComments/common/agentEditorComments.js';
import { IChatAttachmentWidgetRegistry } from '../../../../../workbench/contrib/chat/browser/attachments/chatAttachmentWidgetRegistry.js';
import { IChatEditingService } from '../../../../../workbench/contrib/chat/common/editing/chatEditingService.js';
import { IPlanReviewFeedbackService } from '../../../../../workbench/contrib/chat/browser/planReviewFeedback/planReviewFeedbackService.js';
import { createEditorPart, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { IActiveSession, ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionChangesService } from '../../../changes/browser/sessionChangesService.js';
import { ICodeReviewService } from '../../../codeReview/browser/codeReviewService.js';
import { ActiveSessionFeedbackContextContribution, AgentFeedbackAttachmentWidgetContribution } from '../../browser/agentFeedback.contribution.js';
import { AgentEditorCommentsProviderContribution } from '../../browser/agentEditorCommentsProvider.js';
import { AgentFeedbackAttachmentContribution } from '../../browser/agentFeedbackAttachment.js';
import { AgentFeedbackEditorOverlay } from '../../browser/agentFeedbackEditorOverlay.js';
import { AgentFeedbackPRReviewSeederContribution } from '../../browser/agentFeedbackPRReviewSeeder.js';
import { AgentFeedbackPRThreadResolverContribution } from '../../browser/agentFeedbackPRThreadResolver.js';
import { AgentFeedbackService, IAgentFeedbackService } from '../../browser/agentFeedbackService.js';

/**
 * `agentFeedback.contribution.ts` is imported from `sessions.common.main.ts`, so
 * everything it registers has to be constructible on web as well as on desktop.
 * These tests instantiate the real service and every contribution against the
 * services the web build has — the browser-layer workbench services plus the
 * sessions services `sessions.common.main.ts` registers — and nothing else. A
 * dependency the web build does not register fails here with `depends on
 * UNKNOWN service`, instead of throwing once someone opens the web client.
 */
suite('agentFeedback.contribution (web service set)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createServices(disposables: DisposableStore): Promise<TestInstantiationService> {
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.stub(IEditorGroupsService, await createEditorPart(instantiationService, disposables));

		instantiationService.stub(IChatEditingService, new class extends mock<IChatEditingService>() { });
		instantiationService.stub(ISessionsService, new class extends mock<ISessionsService>() {
			override readonly activeSession = constObservable<IActiveSession | undefined>(undefined);
		});
		instantiationService.stub(ISessionsManagementService, new class extends mock<ISessionsManagementService>() {
			override readonly onDidDeleteSession = Event.None;
			override getSession() { return undefined; }
		});
		instantiationService.stub(ICodeReviewService, new class extends mock<ICodeReviewService>() { });
		instantiationService.stub(ISessionChangesService, new class extends mock<ISessionChangesService>() {
			override getSessionResource() { return undefined; }
		});
		instantiationService.stub(IAgentEditorCommentsBridge, new class extends mock<IAgentEditorCommentsBridge>() {
			override registerProvider(): IDisposable { return Disposable.None; }
		});
		instantiationService.stub(IPlanReviewFeedbackService, new class extends mock<IPlanReviewFeedbackService>() {
			override readonly onDidChangePlanReviewScope = Event.None;
		});
		instantiationService.stub(IChatAttachmentWidgetRegistry, new class extends mock<IChatAttachmentWidgetRegistry>() {
			override registerFactory(): IDisposable { return Disposable.None; }
		});

		return instantiationService;
	}

	test('the real feedback service constructs', async () => {
		const disposables = store.add(new DisposableStore());
		const instantiationService = await createServices(disposables);

		const service = disposables.add(instantiationService.createInstance(AgentFeedbackService));
		assert.ok(service.activeFeedbackSessionResource.get());
	});

	test('every registered contribution constructs', async () => {
		const disposables = store.add(new DisposableStore());
		const instantiationService = await createServices(disposables);
		instantiationService.stub(IAgentFeedbackService, disposables.add(instantiationService.createInstance(AgentFeedbackService)));

		// The contributions `agentFeedback.contribution.ts` registers, in
		// registration order.
		const contributions = [
			ActiveSessionFeedbackContextContribution,
			AgentFeedbackEditorOverlay,
			AgentFeedbackAttachmentContribution,
			AgentFeedbackPRThreadResolverContribution,
			AgentFeedbackPRReviewSeederContribution,
			AgentEditorCommentsProviderContribution,
			AgentFeedbackAttachmentWidgetContribution,
		];

		// `createInstance` throws for any dependency the service set above is
		// missing, so constructing all of them is the assertion.
		const constructed: string[] = [];
		for (const contribution of contributions) {
			const instance: object = instantiationService.createInstance(contribution);
			if (isDisposable(instance)) {
				disposables.add(instance);
			}
			constructed.push(contribution.ID);
		}
		assert.deepStrictEqual(constructed, contributions.map(contribution => contribution.ID));
	});

	test('the registered feedback service is the real one', () => {
		// A stand-in that silently reports "no feedback" satisfies every consumer,
		// so a swapped-in null service would never surface as a failure elsewhere.
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IAgentFeedbackService)?.[1];
		assert.strictEqual(descriptor?.ctor, AgentFeedbackService);
	});
});
