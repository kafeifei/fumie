/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Public entry point for Fumie-owned worktree lifecycle management. The legacy
 * module remains as a compatibility export while callers migrate to this seam.
 */
export type {
	IWorktreeDiskBudgetSession,
	IWorktreeHandle,
} from '../shared/worktreeIsolation.js';

export {
	IAgentHostWorktreeIsolation,
	WorktreeIsolation as WorktreeService,
} from '../shared/worktreeIsolation.js';
