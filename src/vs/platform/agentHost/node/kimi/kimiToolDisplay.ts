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

/**
 * Tool-name → display/permission helpers for the Kimi Harness provider.
 *
 * Mirrors the shape of [deepseekToolDisplay.ts](../deepseek/deepseekToolDisplay.ts)
 * but keyed off Kimi's built-in tool list (PascalCase names such as `Bash`,
 * `Read`, `Edit`; MCP tools arrive as `mcp__<server>__<tool>`). The mapping
 * table lives here so a rename of either the harness tool name or the host's
 * `permissionKind` union flows through compile-checks.
 *
 * No I/O, no DI; safe to import from any layer of `agentHost`.
 */

/**
 * Auto-approval kind reported alongside `pending_confirmation` signals. Kimi
 * exposes only `manual` / `auto` / `yolo` permission modes, but the permission
 * kind still drives the workbench's confirmation-card wording and the host's
 * terminal / write / read auto-approval rules.
 */
export type KimiPermissionKind =
	| 'shell'
	| 'write'
	| 'read'
	| 'url'
	| 'skill'
	| 'custom-tool';

/**
 * Rendering hint for the workbench. The workbench picks a renderer off
 * `_meta.toolKind`; unknown values fall through to the generic tool renderer.
 * Same {@link ToolKind} union as Claude / DeepSeek / Copilot.
 */
export type KimiToolKind = ToolKind;

/** Which input field carries the path/pattern/command surfaced to the user. */
type KimiToolPathField = 'path' | 'pattern' | 'command';

interface KimiToolRow {
	readonly permissionKind: KimiPermissionKind;
	/** Field on the tool input carrying the path/pattern/command, if any. */
	readonly pathField?: KimiToolPathField;
	/** Rendering hint for the workbench. Omit for generic renderer. */
	readonly toolKind?: KimiToolKind;
}

/**
 * Kimi's built-in tool set, as advertised by the SDK's default agent profiles.
 * Anything absent here (MCP tools, user tools, future built-ins) falls back to
 * the generic card and `custom-tool` permissions rather than being guessed at.
 */
const TOOL_ROWS: { readonly [toolName: string]: KimiToolRow } = {
	// shell
	Bash: { permissionKind: 'shell', pathField: 'command', toolKind: 'terminal' },

	// read
	Read: { permissionKind: 'read', pathField: 'path', toolKind: 'read' },
	ReadMediaFile: { permissionKind: 'read', pathField: 'path' },

	// search
	Glob: { permissionKind: 'read', pathField: 'pattern', toolKind: 'search' },
	Grep: { permissionKind: 'read', pathField: 'pattern', toolKind: 'search' },

	// write / edit
	Write: { permissionKind: 'write', pathField: 'path' },
	Edit: { permissionKind: 'write', pathField: 'path' },

	// network
	WebSearch: { permissionKind: 'url' },
	FetchURL: { permissionKind: 'url' },

	// subagents — both render in the subagent renderer
	Agent: { permissionKind: 'custom-tool', toolKind: 'subagent' },
	AgentSwarm: { permissionKind: 'custom-tool', toolKind: 'subagent' },

	// todo / plan
	TodoList: { permissionKind: 'custom-tool' },
	EnterPlanMode: { permissionKind: 'custom-tool' },
	ExitPlanMode: { permissionKind: 'custom-tool' },

	// skill
	Skill: { permissionKind: 'skill' },

	// goal
	CreateGoal: { permissionKind: 'custom-tool' },
	GetGoal: { permissionKind: 'custom-tool' },
	UpdateGoal: { permissionKind: 'custom-tool' },
	SetGoalBudget: { permissionKind: 'custom-tool' },

	// background tasks
	TaskList: { permissionKind: 'custom-tool' },
	TaskOutput: { permissionKind: 'custom-tool' },
	TaskStop: { permissionKind: 'custom-tool' },

	// cron
	CronCreate: { permissionKind: 'custom-tool' },
	CronList: { permissionKind: 'custom-tool' },
	CronDelete: { permissionKind: 'custom-tool' },

	// structured user round-trip
	AskUserQuestion: { permissionKind: 'custom-tool' },
};

/** Row lookup. Falls back to `'custom-tool'` so a growing built-in list never breaks the host. */
export function getKimiPermissionKind(toolName: string): KimiPermissionKind {
	return TOOL_ROWS[toolName]?.permissionKind ?? 'custom-tool';
}

/** Localized display name for Kimi's built-in tools. Falls back to the raw tool name. */
export function getKimiToolDisplayName(toolName: string): string {
	switch (toolName) {
		case 'Bash': return localize('kimi.tool.bash', "Run shell command");
		case 'Read': return localize('kimi.tool.read', "Read file");
		case 'ReadMediaFile': return localize('kimi.tool.readMedia', "Read image or video");
		case 'Glob': return localize('kimi.tool.glob', "Find files");
		case 'Grep': return localize('kimi.tool.grep', "Search files");
		case 'Write': return localize('kimi.tool.write', "Write file");
		case 'Edit': return localize('kimi.tool.edit', "Edit file");
		case 'WebSearch': return localize('kimi.tool.webSearch', "Search the web");
		case 'FetchURL': return localize('kimi.tool.fetchUrl', "Fetch URL");
		case 'Agent': return localize('kimi.tool.agent', "Delegate to subagent");
		case 'AgentSwarm': return localize('kimi.tool.agentSwarm', "Delegate to subagent swarm");
		case 'TodoList': return localize('kimi.tool.todoList', "Update todo list");
		case 'EnterPlanMode': return localize('kimi.tool.enterPlanMode', "Enter plan mode");
		case 'ExitPlanMode': return localize('kimi.tool.exitPlanMode', "Review plan");
		case 'Skill': return localize('kimi.tool.skill', "Run skill");
		case 'CreateGoal': return localize('kimi.tool.createGoal', "Create goal");
		case 'GetGoal': return localize('kimi.tool.getGoal', "Read goal");
		case 'UpdateGoal': return localize('kimi.tool.updateGoal', "Update goal");
		case 'SetGoalBudget': return localize('kimi.tool.setGoalBudget', "Set goal budget");
		case 'TaskList': return localize('kimi.tool.taskList', "List background tasks");
		case 'TaskOutput': return localize('kimi.tool.taskOutput', "Read task output");
		case 'TaskStop': return localize('kimi.tool.taskStop', "Stop background task");
		case 'CronCreate': return localize('kimi.tool.cronCreate', "Create scheduled task");
		case 'CronList': return localize('kimi.tool.cronList', "List scheduled tasks");
		case 'CronDelete': return localize('kimi.tool.cronDelete', "Delete scheduled task");
		case 'AskUserQuestion': return localize('kimi.tool.askUserQuestion', "Ask user a question");
	}
	return toolName;
}

/** Read the `pathField` named on the tool's row from `input`. Returns `undefined` when absent. */
export function getKimiToolPath(toolName: string, input: unknown): string | undefined {
	const row = TOOL_ROWS[toolName];
	if (!row?.pathField) {
		return undefined;
	}
	return readStringField(input, row.pathField);
}

/** Typed meta view for a tool call. Returns `undefined` for tools without a `toolKind` hint. */
export function buildKimiToolCallMeta(toolName: string, input?: unknown): IToolCallMeta | undefined {
	const row = TOOL_ROWS[toolName];
	if (!row?.toolKind) {
		return undefined;
	}
	if (row.toolKind === 'subagent') {
		// Carry the delegation's short description and profile so the subagent
		// card shows a meaningful task label instead of the raw tool name. Both
		// `Agent` and `AgentSwarm` take `description` + `subagent_type`.
		const description = readStringField(input, 'description');
		const agentName = readStringField(input, 'subagent_type');
		return {
			toolKind: row.toolKind,
			...(description ? { subagentDescription: description } : {}),
			...(agentName ? { subagentAgentName: agentName } : {}),
		};
	}
	return { toolKind: row.toolKind };
}

/** Serialized `_meta` bag stamped at the tool-open seam. */
export function buildKimiToolMeta(toolName: string, input?: unknown): Record<string, unknown> | undefined {
	const meta = buildKimiToolCallMeta(toolName, input);
	return meta ? toToolCallMeta(meta) : undefined;
}

/**
 * Shell dialect the host's terminal auto-approve rules are parsed with. Same
 * union as `IAgentToolPendingConfirmationSignal.shellLanguage`; a shell tool
 * without one always prompts.
 */
export type KimiShellLanguage = 'bash' | 'powershell';

/**
 * Host-only auto-approval fields carried alongside a `pending_confirmation`
 * (see `SessionPermissionManager.getAutoApproval`): the permission kind, plus
 * the filesystem target the read/write path rules check and the shell dialect
 * the terminal rules are parsed with.
 */
export interface IKimiApprovalTarget {
	readonly permissionKind: KimiPermissionKind;
	readonly permissionPath?: string;
	readonly shellLanguage?: KimiShellLanguage;
}

/**
 * Derive the auto-approval fields for one approval request.
 *
 * `permissionKind` comes from {@link TOOL_ROWS}, so the agent never branches on
 * tool names. The path and shell dialect come from Kimi's own
 * `ToolInputDisplay` payload — the only tool input the SDK hands the approval
 * handler, and the one that carries the already-resolved absolute path rather
 * than the model's raw argument. A missing or unrecognized display leaves both
 * unset, which fails closed in `SessionPermissionManager`.
 */
export function getKimiApprovalTarget(toolName: string, display: unknown): IKimiApprovalTarget {
	const permissionKind = getKimiPermissionKind(toolName);
	const kind = readStringField(display, 'kind');
	if (permissionKind === 'shell') {
		const language = kind === 'command' ? readStringField(display, 'language') : undefined;
		return {
			permissionKind,
			...(language === 'bash' || language === 'powershell' ? { shellLanguage: language } : {}),
		};
	}
	// `file_io` covers read/write/edit/glob/grep (`path` is the resolved file or
	// search root); `diff` is the edit-preview shape of the same target.
	const path = kind === 'file_io' || kind === 'diff' ? readStringField(display, 'path') : undefined;
	return { permissionKind, ...(path !== undefined ? { permissionPath: path } : {}) };
}

/**
 * Canonical "input as code" string for a confirmation card. The host's terminal
 * rules parse the command line off this field, so a shell call surfaces the bare
 * command; everything else surfaces the serialized display payload.
 */
export function getKimiApprovalToolInput(toolName: string, display: unknown): string | undefined {
	if (getKimiPermissionKind(toolName) === 'shell' && readStringField(display, 'kind') === 'command') {
		return readStringField(display, 'command');
	}
	return stringifyDisplay(display);
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

function stringifyDisplay(display: unknown): string | undefined {
	if (display === undefined || display === null) {
		return undefined;
	}
	try {
		return typeof display === 'string' ? display : JSON.stringify(display);
	} catch {
		return undefined;
	}
}

/** Confirmation-card title shown when a tool needs explicit user approval. */
export function getKimiConfirmationTitle(toolName: string): string {
	switch (getKimiPermissionKind(toolName)) {
		case 'shell':
			return localize('kimi.permission.shell.title', "Run in terminal?");
		case 'write':
			return localize('kimi.permission.write.title', "Edit file?");
		case 'read':
			return localize('kimi.permission.read.title', "Read file?");
		case 'url':
			return localize('kimi.permission.url.title', "Fetch web content?");
		case 'skill':
			return localize('kimi.permission.skill.title', "Run skill?");
		case 'custom-tool':
		default:
			return localize('kimi.permission.default.title', "Allow tool call?");
	}
}

/** Rich invocation message for a `pending_confirmation` card or streaming `ChatToolCallStart`. */
export function getKimiInvocationMessage(
	toolName: string,
	displayName: string,
	input: unknown,
): StringOrMarkdown {
	switch (toolName) {
		case 'Bash': {
			const command = getKimiToolPath(toolName, input);
			if (command) {
				return md(localize('kimi.toolInvoke.bashCmd', "Running {0}", appendEscapedMarkdownInlineCode(truncate(command.split('\n')[0], 80))));
			}
			return localize('kimi.toolInvoke.bash', "Running shell command");
		}
		case 'Read':
		case 'ReadMediaFile': {
			const path = getKimiToolPath(toolName, input);
			if (path) {
				return md(localize('kimi.toolInvoke.readFile', "Read {0}", formatPathAsMarkdownLink(path)));
			}
			return localize('kimi.toolInvoke.read', "Read file");
		}
		case 'Write':
		case 'Edit': {
			const path = getKimiToolPath(toolName, input);
			if (path) {
				return md(localize('kimi.toolInvoke.editFile', "Edit {0}", formatPathAsMarkdownLink(path)));
			}
			return localize('kimi.toolInvoke.edit', "Edit file");
		}
		case 'Glob': {
			const pattern = getKimiToolPath(toolName, input);
			if (pattern) {
				return md(localize('kimi.toolInvoke.globPattern', "Find files matching {0}", appendEscapedMarkdownInlineCode(truncate(pattern, 80))));
			}
			return localize('kimi.toolInvoke.glob', "Find files");
		}
		case 'Grep': {
			const pattern = getKimiToolPath(toolName, input);
			if (pattern) {
				return md(localize('kimi.toolInvoke.grepPattern', "Search for {0}", appendEscapedMarkdownInlineCode(truncate(pattern, 80))));
			}
			return localize('kimi.toolInvoke.grep', "Search files");
		}
		case 'WebSearch': {
			const query = readStringField(input, 'query');
			if (query) {
				return md(localize('kimi.toolInvoke.webSearch', "Searching {0}", appendEscapedMarkdownInlineCode(truncate(query, 80))));
			}
			return localize('kimi.toolInvoke.webSearchGeneric', "Searching the web");
		}
		case 'FetchURL': {
			const url = readStringField(input, 'url');
			if (url) {
				return md(localize('kimi.toolInvoke.fetchUrl', "Fetching {0}", appendEscapedMarkdownInlineCode(truncate(url, 80))));
			}
			return localize('kimi.toolInvoke.fetchUrlGeneric', "Fetching web content");
		}
		case 'Agent':
		case 'AgentSwarm':
			return readStringField(input, 'description') ?? displayName;
		case 'Skill': {
			const skill = readStringField(input, 'skill');
			if (skill) {
				return md(localize('kimi.toolInvoke.skillNamed', "Running skill {0}", appendEscapedMarkdownInlineCode(truncate(skill, 80))));
			}
			return localize('kimi.toolInvoke.skill', "Running skill");
		}
		case 'CreateGoal':
		case 'UpdateGoal': {
			const objective = readStringField(input, 'objective');
			if (objective) {
				return md(localize('kimi.toolInvoke.goal', "Goal: {0}", truncate(objective, 80)));
			}
			return displayName;
		}
		default:
			return displayName;
	}
}

/** Success-aware rich past-tense message. */
export function getKimiPastTenseMessage(
	toolName: string,
	displayName: string,
	input: unknown,
	success: boolean,
): StringOrMarkdown {
	if (!success) {
		return localize('kimi.toolComplete.failed', "\"{0}\" failed", displayName);
	}
	switch (toolName) {
		case 'Bash': {
			const command = getKimiToolPath(toolName, input);
			if (command) {
				return md(localize('kimi.toolComplete.bashCmd', "Ran {0}", appendEscapedMarkdownInlineCode(truncate(command.split('\n')[0], 80))));
			}
			return localize('kimi.toolComplete.bash', "Ran shell command");
		}
		case 'Read':
		case 'ReadMediaFile': {
			const path = getKimiToolPath(toolName, input);
			if (path) {
				return md(localize('kimi.toolComplete.readFile', "Read {0}", formatPathAsMarkdownLink(path)));
			}
			return localize('kimi.toolComplete.read', "Read file");
		}
		case 'Write':
		case 'Edit': {
			const path = getKimiToolPath(toolName, input);
			if (path) {
				return md(localize('kimi.toolComplete.editFile', "Edited {0}", formatPathAsMarkdownLink(path)));
			}
			return localize('kimi.toolComplete.edit', "Edited file");
		}
		case 'Glob':
			return localize('kimi.toolComplete.glob', "Found files");
		case 'Grep':
			return localize('kimi.toolComplete.grep', "Searched files");
		case 'WebSearch':
			return localize('kimi.toolComplete.webSearch', "Searched the web");
		case 'FetchURL':
			return localize('kimi.toolComplete.fetchUrl', "Fetched web content");
		case 'Agent':
		case 'AgentSwarm':
			return localize('kimi.toolComplete.agent', "Ran subagent");
		case 'TodoList':
			return localize('kimi.toolComplete.todoList', "Updated todo list");
		default:
			return getKimiInvocationMessage(toolName, displayName, input);
	}
}
