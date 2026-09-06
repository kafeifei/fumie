/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorktreeTrustCandidate, trustWorktreesOfTrustedRepositories } from '../../../../platform/workspace/common/worktreeTrust.js';
import { ISessionWorkspace } from './session.js';

/**
 * Auto-trusts the isolated git worktrees VS Code created for this session off
 * a base repository the user already trusts.
 *
 * Identifies the session's worktrees from its workspace model and defers the
 * trust decision itself to {@link trustWorktreesOfTrustedRepositories}, which
 * the agent-host spawn gate shares — so both gates apply one policy. A plain
 * (non-worktree) folder is never trusted here; it must pass an explicit trust
 * prompt.
 */
export async function ensureWorktreesTrusted(workspaceTrustManagementService: IWorkspaceTrustManagementService, workspace: ISessionWorkspace | undefined): Promise<void> {
	if (!workspace?.requiresWorkspaceTrust) {
		return;
	}

	const candidates: IWorktreeTrustCandidate[] = [];
	for (const folder of workspace.folders) {
		const gitRepository = folder.gitRepository;
		// `workTreeUri` is only set for a genuine worktree (working directory !==
		// repository root); a plain folder session leaves it undefined.
		if (gitRepository?.workTreeUri) {
			candidates.push({ worktree: folder.workingDirectory, baseRepository: gitRepository.uri });
		}
	}

	await trustWorktreesOfTrustedRepositories(workspaceTrustManagementService, candidates);
}
