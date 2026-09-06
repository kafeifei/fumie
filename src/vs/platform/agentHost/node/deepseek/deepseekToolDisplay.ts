/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { appendEscapedMarkdownInlineCode, escapeMarkdownLinkLabel } from '../../../../base/common/htmlContent.js';
import { basename } from '../../../../base/common/resources.js';
import { truncate } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { toToolCallMeta, type IToolCallMeta, type ToolKind } from '../../common/meta/agentToolCallMeta.js';
import type { StringOrMarkdown } from '../../common/state/protocol/state.js';
import type { ToolResultTodoItem } from '../../common/state/sessionState.js';

/**
 * Tool-name → display/permission helpers for the DeepSeek Harness provider.
 *
 * Mirrors the shape of [claudeToolDisplay.ts](../claude/claudeToolDisplay.ts)
 * but keyed off the DeepSeek Harness's built-in tool list. The mapping table
 * lives here so a rename of either the harness tool name or the host's
 * `permissionKind` union flows through compile-checks.
 *
 * No I/O, no DI; safe to import from any layer of `agentHost`.
 */

/**
 * Auto-approval kind reported alongside `pending_confirmation` signals. The
 * DeepSeek Harness exposes only `ask` / `never` approval policy, but the
 * permission kind still drives the workbench's confirmation-card wording and
 * terminal / write / read auto-approval rules.
 */
export type DeepSeekPermissionKind =
	| 'shell'
	| 'write'
	| 'read'
	| 'url'
	| 'skill'
	| 'custom-tool';

/**
 * Rendering hint for the workbench. The workbench picks a renderer off
 * `_meta.toolKind`; unknown values fall through to the generic tool renderer.
 * Same {@link ToolKind} union as Claude / Copilot.
 */
export type DeepSeekToolKind = ToolKind;

/**
 * Shell dialect the host's terminal auto-approve rules are parsed with. Same
 * union as `IAgentToolPendingConfirmationSignal.shellLanguage`; a shell tool
 * without one always prompts.
 */
export type DeepSeekShellLanguage = 'bash' | 'powershell';

/** Which input field carries the path/pattern surfaced to the user. */
type DeepSeekToolPathField = 'file_path' | 'path' | 'pattern' | 'command';

/**
 * Path fields naming a real filesystem target, so they can be handed to the
 * host's read/write auto-approval as `permissionPath`. `command` is a shell
 * command line and `pattern` a glob/regex — neither is a path.
 */
const FS_PATH_FIELDS: readonly DeepSeekToolPathField[] = ['file_path', 'path'];

interface DeepSeekToolRow {
	readonly permissionKind: DeepSeekPermissionKind;
	/** Field on the tool input carrying the path/pattern/command, if any. */
	readonly pathField?: DeepSeekToolPathField;
	/** Shell dialect for `permissionKind: 'shell'` rows; omitted elsewhere. */
	readonly shellLanguage?: DeepSeekShellLanguage;
	/** True for tools whose execution writes to disk and is tracked as a file edit. */
	readonly isFileEdit?: true;
	/** True for tools that always reach the host for an explicit user round-trip. */
	readonly interactive?: true;
	/** Rendering hint for the workbench. Omit for generic renderer. */
	readonly toolKind?: DeepSeekToolKind;
}

const TOOL_ROWS: { readonly [toolName: string]: DeepSeekToolRow } = {
	// shell
	bash: { permissionKind: 'shell', pathField: 'command', shellLanguage: 'bash', toolKind: 'terminal' },
	pwsh: { permissionKind: 'shell', pathField: 'command', shellLanguage: 'powershell', toolKind: 'terminal' },

	// read
	read: { permissionKind: 'read', pathField: 'file_path', toolKind: 'read' },
	read_image: { permissionKind: 'read', pathField: 'file_path' },

	// search — `pathField` is the search *root* (what the read auto-approval
	// checks); the pattern is read straight off the input for display.
	glob: { permissionKind: 'read', pathField: 'path', toolKind: 'search' },
	grep: { permissionKind: 'read', pathField: 'path', toolKind: 'search' },

	// write / edit
	write: { permissionKind: 'write', pathField: 'file_path', isFileEdit: true },
	edit: { permissionKind: 'write', pathField: 'file_path', isFileEdit: true },
	str_replace_editor: { permissionKind: 'write', pathField: 'path', isFileEdit: true },

	// network
	web_search: { permissionKind: 'url' },

	// todo / goal / plan
	todo_write: { permissionKind: 'custom-tool' },
	create_goal: { permissionKind: 'custom-tool' },
	get_goal: { permissionKind: 'custom-tool' },
	update_goal: { permissionKind: 'custom-tool' },
	plan: { permissionKind: 'custom-tool', interactive: true },

	// subagent / workflow / ralph lineage — all render in the subagent renderer
	subagent: { permissionKind: 'custom-tool', toolKind: 'subagent' },
	subagent_fork: { permissionKind: 'custom-tool', toolKind: 'subagent' },
	workflow: { permissionKind: 'custom-tool', toolKind: 'subagent' },
	ralph: { permissionKind: 'custom-tool', toolKind: 'subagent' },

	// subagent control
	list_agents: { permissionKind: 'custom-tool' },
	send_message: { permissionKind: 'custom-tool' },
	interrupt_agent: { permissionKind: 'custom-tool' },

	// skill / jobs / misc
	skill: { permissionKind: 'skill' },
	job_list: { permissionKind: 'custom-tool' },
	job_output: { permissionKind: 'custom-tool' },
	job_kill: { permissionKind: 'custom-tool' },
	ask_user_question: { permissionKind: 'custom-tool', interactive: true },
};

/** Row lookup. Falls back to `'custom-tool'` so a growing built-in list never breaks the host. */
export function getDeepSeekPermissionKind(toolName: string): DeepSeekPermissionKind {
	return TOOL_ROWS[toolName]?.permissionKind ?? 'custom-tool';
}

/**
 * Host-only auto-approval fields carried alongside a `pending_confirmation`
 * (see `SessionPermissionManager.getAutoApproval`): the permission kind, plus
 * the filesystem target the read/write path rules check and the shell dialect
 * the terminal rules are parsed with. Both extras are optional — the rules
 * that need them simply prompt when they are absent.
 */
export interface IDeepSeekApprovalTarget {
	readonly permissionKind: DeepSeekPermissionKind;
	readonly permissionPath?: string;
	readonly shellLanguage?: DeepSeekShellLanguage;
}

/**
 * Derive the auto-approval fields for one tool call off {@link TOOL_ROWS}, so
 * the agent never branches on tool names. `permissionPath` comes from the row's
 * path field when that field names a real path ({@link FS_PATH_FIELDS}), and
 * `shellLanguage` straight off the row.
 */
export function getDeepSeekApprovalTarget(toolName: string, input: unknown): IDeepSeekApprovalTarget {
	const row = TOOL_ROWS[toolName];
	const permissionPath = row?.pathField && FS_PATH_FIELDS.includes(row.pathField)
		? getDeepSeekToolPath(toolName, input)
		: undefined;
	return {
		permissionKind: row?.permissionKind ?? 'custom-tool',
		...(permissionPath !== undefined ? { permissionPath } : {}),
		...(row?.shellLanguage !== undefined ? { shellLanguage: row.shellLanguage } : {}),
	};
}

/** Localized display name for the harness's built-in tools. Falls back to the raw tool name. */
export function getDeepSeekToolDisplayName(toolName: string): string {
	switch (toolName) {
		case 'bash': return localize('deepseek.tool.bash', "Run shell command");
		case 'pwsh': return localize('deepseek.tool.pwsh', "Run PowerShell command");
		case 'read': return localize('deepseek.tool.read', "Read file");
		case 'read_image': return localize('deepseek.tool.readImage', "Read image");
		case 'glob': return localize('deepseek.tool.glob', "Find files");
		case 'grep': return localize('deepseek.tool.grep', "Search files");
		case 'write': return localize('deepseek.tool.write', "Write file");
		case 'edit': return localize('deepseek.tool.edit', "Edit file");
		case 'str_replace_editor': return localize('deepseek.tool.strReplace', "Edit files");
		case 'web_search': return localize('deepseek.tool.webSearch', "Search the web");
		case 'todo_write': return localize('deepseek.tool.todoWrite', "Update todo list");
		case 'create_goal': return localize('deepseek.tool.createGoal', "Create goal");
		case 'get_goal': return localize('deepseek.tool.getGoal', "Read goal");
		case 'update_goal': return localize('deepseek.tool.updateGoal', "Update goal");
		case 'plan': return localize('deepseek.tool.plan', "Plan");
		case 'subagent':
		case 'subagent_fork': return localize('deepseek.tool.subagent', "Delegate to subagent");
		case 'workflow': return localize('deepseek.tool.workflow', "Run workflow");
		case 'ralph': return localize('deepseek.tool.ralph', "Run fresh-agent loop");
		case 'list_agents': return localize('deepseek.tool.listAgents', "List subagents");
		case 'send_message': return localize('deepseek.tool.sendMessage', "Message subagent");
		case 'interrupt_agent': return localize('deepseek.tool.interruptAgent', "Interrupt subagent");
		case 'skill': return localize('deepseek.tool.skill', "Run skill");
		case 'job_list': return localize('deepseek.tool.jobList', "List background jobs");
		case 'job_output': return localize('deepseek.tool.jobOutput', "Read job output");
		case 'job_kill': return localize('deepseek.tool.jobKill', "Stop background job");
		case 'ask_user_question': return localize('deepseek.tool.askUserQuestion', "Ask user a question");
	}
	return toolName;
}

/** Read the `pathField` named on the tool's row from `input`. Returns `undefined` when absent. */
export function getDeepSeekToolPath(toolName: string, input: unknown): string | undefined {
	const row = TOOL_ROWS[toolName];
	if (!row?.pathField || typeof input !== 'object' || input === null) {
		return undefined;
	}
	const value = (input as Record<string, unknown>)[row.pathField];
	return typeof value === 'string' ? value : undefined;
}

/** True for tools that produce on-disk file edits tracked as a diff. */
export function isDeepSeekFileEditTool(toolName: string): boolean {
	return TOOL_ROWS[toolName]?.isFileEdit === true;
}

/** Workbench rendering hint. `terminal` / `search` / `subagent` / `read`, else `undefined`. */
export function getDeepSeekToolKind(toolName: string): DeepSeekToolKind | undefined {
	return TOOL_ROWS[toolName]?.toolKind;
}

/** Typed meta view for a tool call. Returns `undefined` for tools without a `toolKind` hint. */
export function buildDeepSeekToolCallMeta(toolName: string, input?: unknown): IToolCallMeta | undefined {
	const row = TOOL_ROWS[toolName];
	if (!row?.toolKind) {
		return undefined;
	}
	if (row.toolKind === 'subagent') {
		// Carry the delegation's short description so the subagent card shows a
		// meaningful task label instead of the raw tool name. `subagent` /
		// `subagent_fork` / `workflow` take `description`; `ralph` takes `objective`.
		const description = readStringField(input, 'description') ?? readStringField(input, 'objective');
		return {
			toolKind: row.toolKind,
			...(description ? { subagentDescription: description } : {}),
		};
	}
	return { toolKind: row.toolKind };
}

/** Serialized `_meta` bag stamped at the tool-open seam. */
export function buildDeepSeekToolMeta(toolName: string, input?: unknown): Record<string, unknown> | undefined {
	const meta = buildDeepSeekToolCallMeta(toolName, input);
	return meta ? toToolCallMeta(meta) : undefined;
}

function md(value: string): StringOrMarkdown {
	return { markdown: value };
}

function formatPathAsMarkdownLink(path: string): string {
	const uri = URI.file(path);
	return `[${escapeMarkdownLinkLabel(basename(uri))}](${uri})`;
}

function readStringField(input: unknown, field: string): string | undefined {
	if (input === null || typeof input !== 'object') {
		return undefined;
	}
	const value = (input as Record<string, unknown>)[field];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Confirmation-card title shown when a tool needs explicit user approval. */
export function getDeepSeekConfirmationTitle(toolName: string): string {
	switch (getDeepSeekPermissionKind(toolName)) {
		case 'shell':
			return localize('deepseek.permission.shell.title', "Run in terminal?");
		case 'write':
			return localize('deepseek.permission.write.title', "Edit file?");
		case 'read':
			return localize('deepseek.permission.read.title', "Read file?");
		case 'url':
			return localize('deepseek.permission.url.title', "Search the web?");
		case 'skill':
			return localize('deepseek.permission.skill.title', "Run skill?");
		case 'custom-tool':
		default:
			return localize('deepseek.permission.default.title', "Allow tool call?");
	}
}

/** Rich invocation message for a `pending_confirmation` card or streaming `ChatToolCallStart`. */
export function getDeepSeekInvocationMessage(
	toolName: string,
	displayName: string,
	input: unknown,
): StringOrMarkdown {
	switch (toolName) {
		case 'bash':
		case 'pwsh': {
			const command = getDeepSeekToolPath(toolName, input);
			if (command) {
				return md(localize('deepseek.toolInvoke.bashCmd', "Running {0}", appendEscapedMarkdownInlineCode(truncate(command.split('\n')[0], 80))));
			}
			return localize('deepseek.toolInvoke.bash', "Running shell command");
		}
		case 'read':
		case 'read_image': {
			const path = getDeepSeekToolPath(toolName, input);
			if (path) {
				return md(localize('deepseek.toolInvoke.readFile', "Read {0}", formatPathAsMarkdownLink(path)));
			}
			return localize('deepseek.toolInvoke.read', "Read file");
		}
		case 'write':
		case 'edit':
		case 'str_replace_editor': {
			const path = getDeepSeekToolPath(toolName, input);
			if (path) {
				return md(localize('deepseek.toolInvoke.editFile', "Edit {0}", formatPathAsMarkdownLink(path)));
			}
			return localize('deepseek.toolInvoke.edit', "Edit file");
		}
		case 'glob': {
			const pattern = readStringField(input, 'pattern');
			if (pattern) {
				return md(localize('deepseek.toolInvoke.globPattern', "Find files matching {0}", appendEscapedMarkdownInlineCode(truncate(pattern, 80))));
			}
			return localize('deepseek.toolInvoke.glob', "Find files");
		}
		case 'grep': {
			const pattern = readStringField(input, 'pattern');
			if (pattern) {
				return md(localize('deepseek.toolInvoke.grepPattern', "Search for {0}", appendEscapedMarkdownInlineCode(truncate(pattern, 80))));
			}
			return localize('deepseek.toolInvoke.grep', "Search files");
		}
		case 'web_search': {
			const query = readStringField(input, 'query');
			if (query) {
				return md(localize('deepseek.toolInvoke.webSearch', "Searching {0}", appendEscapedMarkdownInlineCode(truncate(query, 80))));
			}
			return localize('deepseek.toolInvoke.webSearchGeneric', "Searching the web");
		}
		case 'subagent':
		case 'subagent_fork': {
			const description = readStringField(input, 'description');
			return description ?? displayName;
		}
		case 'workflow': {
			const description = readStringField(input, 'description');
			return description ?? displayName;
		}
		case 'ralph': {
			const objective = readStringField(input, 'objective');
			if (objective) {
				return md(localize('deepseek.toolInvoke.ralph', "Running fresh-agent loop: {0}", truncate(objective, 80)));
			}
			return localize('deepseek.toolInvoke.ralphGeneric', "Running fresh-agent loop");
		}
		case 'todo_write':
			return localize('deepseek.toolInvoke.todoWrite', "Update todo list");
		case 'create_goal':
		case 'get_goal':
		case 'update_goal':
			return displayName;
		case 'skill': {
			const skill = readStringField(input, 'name') ?? readStringField(input, 'skill');
			if (skill) {
				return md(localize('deepseek.toolInvoke.skillNamed', "Running skill {0}", appendEscapedMarkdownInlineCode(truncate(skill, 80))));
			}
			return localize('deepseek.toolInvoke.skill', "Running skill");
		}
		default:
			return displayName;
	}
}

/** Success-aware rich past-tense message. */
export function getDeepSeekPastTenseMessage(
	toolName: string,
	displayName: string,
	input: unknown,
	success: boolean,
	_resultText?: string,
): StringOrMarkdown {
	if (!success) {
		return localize('deepseek.toolComplete.failed', "\"{0}\" failed", displayName);
	}
	switch (toolName) {
		case 'bash':
		case 'pwsh': {
			const command = getDeepSeekToolPath(toolName, input);
			if (command) {
				return md(localize('deepseek.toolComplete.bashCmd', "Ran {0}", appendEscapedMarkdownInlineCode(truncate(command.split('\n')[0], 80))));
			}
			return localize('deepseek.toolComplete.bash', "Ran shell command");
		}
		case 'read':
		case 'read_image': {
			const path = getDeepSeekToolPath(toolName, input);
			if (path) {
				return md(localize('deepseek.toolComplete.readFile', "Read {0}", formatPathAsMarkdownLink(path)));
			}
			return localize('deepseek.toolComplete.read', "Read file");
		}
		case 'write':
		case 'edit':
		case 'str_replace_editor': {
			const path = getDeepSeekToolPath(toolName, input);
			if (path) {
				return md(localize('deepseek.toolComplete.editFile', "Edited {0}", formatPathAsMarkdownLink(path)));
			}
			return localize('deepseek.toolComplete.edit', "Edited file");
		}
		case 'glob':
			return localize('deepseek.toolComplete.glob', "Found files");
		case 'grep':
			return localize('deepseek.toolComplete.grep', "Searched files");
		case 'web_search':
			return localize('deepseek.toolComplete.webSearch', "Searched the web");
		case 'subagent':
		case 'subagent_fork':
			return localize('deepseek.toolComplete.subagent', "Ran subagent");
		case 'workflow':
			return localize('deepseek.toolComplete.workflow', "Ran workflow");
		case 'ralph':
			return localize('deepseek.toolComplete.ralph', "Ran fresh-agent loop");
		case 'todo_write':
			return localize('deepseek.toolComplete.todoWrite', "Updated todo list");
		default:
			return getDeepSeekInvocationMessage(toolName, displayName, input);
	}
}

/** Canonical "input as code" string rendered under the tool-call row. */
export function getDeepSeekToolInputString(toolName: string, input: unknown): string | undefined {
	if (input === undefined) {
		return undefined;
	}
	if (toolName === 'bash' || toolName === 'pwsh') {
		const command = readStringField(input, 'command');
		if (command) {
			return command;
		}
	}
	if (toolName === 'glob' || toolName === 'grep') {
		const pattern = readStringField(input, 'pattern');
		if (pattern) {
			return pattern;
		}
	}
	try {
		return JSON.stringify(input, null, 2);
	} catch {
		return undefined;
	}
}

function mapDeepSeekTodoStatus(status: string): ToolResultTodoItem['status'] {
	switch (status) {
		case 'in_progress': return 'in-progress';
		case 'completed': return 'completed';
		default: return 'not-started';
	}
}

/**
 * Maps a DeepSeek `todo/write` `todos` payload to the protocol's todo items.
 * The harness's items carry `{ content, status: pending|in_progress|completed }`
 * with no id, so we synthesize a stable index-based id and fold `pending` into
 * the protocol's `not-started`.
 */
export function mapDeepSeekTodos(value: unknown): ToolResultTodoItem[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const result: ToolResultTodoItem[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = typeof value[i] === 'object' && value[i] !== null ? value[i] as Record<string, unknown> : {};
		const title = typeof item.content === 'string' ? item.content : '';
		if (!title) {
			continue;
		}
		result.push({
			id: `todo-${i}`,
			title,
			status: mapDeepSeekTodoStatus(typeof item.status === 'string' ? item.status : ''),
		});
	}
	return result;
}
