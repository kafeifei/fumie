/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendEscapedMarkdownInlineCode, escapeMarkdownLinkLabel } from '../../../../base/common/htmlContent.js';
import { resolve } from '../../../../base/common/path.js';
import { basename } from '../../../../base/common/resources.js';
import { truncate } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { IAgentToolPendingConfirmationSignal } from '../../common/agent.js';
import { toToolCallMeta, type ToolKind } from '../../common/meta/agentToolCallMeta.js';
import type { StringOrMarkdown } from '../../common/state/protocol/state.js';

/**
 * Display strings for opencode tool calls.
 *
 * opencode names its tools but publishes no kind taxonomy, so this table is the
 * one place the two are joined: a tool name maps to a renderer `toolKind`, a
 * host permission kind, and the input field that carries its path. Everything
 * downstream — the transcript, the permission pipeline, the renderer — reads
 * only what this table produced, which is what keeps the name-to-kind decision
 * here rather than spread across the connector.
 *
 * A tool this table does not know (an MCP server's, a plugin's) is still a
 * perfectly good tool call: it renders under its own name and asks for a
 * generic confirmation.
 */

const MAX_TITLE_LENGTH = 200;

interface IOpencodeToolRow {
	readonly permissionKind: NonNullable<IAgentToolPendingConfirmationSignal['permissionKind']>;
	/** Input field carrying the path this call acts on, when it has one. */
	readonly pathField?: 'filePath' | 'path';
	readonly shellLanguage?: IAgentToolPendingConfirmationSignal['shellLanguage'];
	/** Renderer hint carried on the tool call's `_meta`. */
	readonly toolKind?: ToolKind;
}

/**
 * opencode's built-in tools (`GET /experimental/tool/ids` on 1.18.25).
 * `invalid` is opencode's own error placeholder for a malformed call and is
 * deliberately left to the generic row.
 */
const TOOL_ROWS: Readonly<Record<string, IOpencodeToolRow>> = {
	bash: { permissionKind: 'shell', shellLanguage: 'bash', toolKind: 'terminal' },
	read: { permissionKind: 'read', pathField: 'filePath', toolKind: 'read' },
	write: { permissionKind: 'write', pathField: 'filePath' },
	edit: { permissionKind: 'write', pathField: 'filePath' },
	apply_patch: { permissionKind: 'write' },
	glob: { permissionKind: 'read', pathField: 'path', toolKind: 'search' },
	grep: { permissionKind: 'read', pathField: 'path', toolKind: 'search' },
	webfetch: { permissionKind: 'url' },
	websearch: { permissionKind: 'url' },
	skill: { permissionKind: 'skill' },
	todowrite: { permissionKind: 'custom-tool' },
	task: { permissionKind: 'custom-tool', toolKind: 'subagent' },
};

/** The name of the tool that delegates work to a child session. */
export const OPENCODE_TASK_TOOL = 'task';

export interface IOpencodeApprovalTarget {
	readonly permissionKind: NonNullable<IAgentToolPendingConfirmationSignal['permissionKind']>;
	readonly permissionPath?: string;
	readonly shellLanguage?: IAgentToolPendingConfirmationSignal['shellLanguage'];
}

/** Maps a tool call onto the host's auto-approval taxonomy. */
export function getOpencodeApprovalTarget(toolName: string, input: unknown, cwd: string): IOpencodeApprovalTarget {
	const row = TOOL_ROWS[toolName];
	const path = row?.pathField ? readStringField(input, row.pathField) : undefined;
	return {
		permissionKind: row?.permissionKind ?? 'custom-tool',
		...(path ? { permissionPath: resolve(cwd, path) } : {}),
		...(row?.shellLanguage ? { shellLanguage: row.shellLanguage } : {}),
	};
}

/** Stable transcript label for a tool, independent of what one call is doing. */
export function getOpencodeToolDisplayName(toolName: string): string {
	switch (toolName) {
		case 'bash': return localize('opencode.tool.bash', "Run shell command");
		case 'read': return localize('opencode.tool.read', "Read file");
		case 'write': return localize('opencode.tool.write', "Write file");
		case 'edit': return localize('opencode.tool.edit', "Edit file");
		case 'apply_patch': return localize('opencode.tool.applyPatch', "Apply patch");
		case 'glob': return localize('opencode.tool.glob', "Find files");
		case 'grep': return localize('opencode.tool.grep', "Search");
		case 'webfetch': return localize('opencode.tool.webfetch', "Fetch page");
		case 'websearch': return localize('opencode.tool.websearch', "Search the web");
		case 'skill': return localize('opencode.tool.skill', "Run skill");
		case 'todowrite': return localize('opencode.tool.todowrite', "Update plan");
		case OPENCODE_TASK_TOOL: return localize('opencode.tool.task', "Delegate to subagent");
		default: return toolName;
	}
}

export function getOpencodeConfirmationTitle(toolName: string): string {
	switch (TOOL_ROWS[toolName]?.permissionKind) {
		case 'read': return localize('opencode.permission.read.title', "Read files?");
		case 'write': return localize('opencode.permission.write.title', "Edit files?");
		case 'shell': return localize('opencode.permission.shell.title', "Run in terminal?");
		case 'url': return localize('opencode.permission.url.title', "Fetch from the web?");
		default: return localize('opencode.permission.default.title', "Allow tool call?");
	}
}

/**
 * Present-tense progress line.
 *
 * opencode publishes a per-call `title` once the call starts running (the file
 * it read, the task it delegated); it is the agent's own summary, so it wins
 * whenever it exists and the derived line is what a still-pending call shows.
 */
export function getOpencodeInvocationMessage(toolName: string, input: unknown, title: string | undefined, cwd: string): StringOrMarkdown {
	if (toolName === 'bash') {
		const command = readStringField(input, 'command');
		return command
			? md(localize('opencode.toolInvoke.bashCommand', "Running {0}", appendEscapedMarkdownInlineCode(truncate(command.split('\n')[0], 80))))
			: localize('opencode.toolInvoke.bash', "Running shell command");
	}
	const link = pathLink(toolName, input, cwd);
	if (link) {
		return md(localize('opencode.toolInvoke.path', "{0} {1}", escapeMarkdownLinkLabel(getOpencodeToolDisplayName(toolName)), link));
	}
	const trimmed = title?.trim();
	return trimmed ? truncate(trimmed, MAX_TITLE_LENGTH) : getOpencodeToolDisplayName(toolName);
}

export function getOpencodePastTenseMessage(toolName: string, input: unknown, title: string | undefined, cwd: string, success: boolean): StringOrMarkdown {
	if (!success) {
		return localize('opencode.toolResult.failed', "{0} failed", getOpencodeToolDisplayName(toolName));
	}
	if (toolName === 'bash') {
		return localize('opencode.toolResult.bash', "Ran shell command");
	}
	const link = pathLink(toolName, input, cwd);
	if (link) {
		return md(localize('opencode.toolResult.path', "{0} {1}", escapeMarkdownLinkLabel(getOpencodeToolDisplayName(toolName)), link));
	}
	const trimmed = title?.trim();
	return trimmed ? truncate(trimmed, MAX_TITLE_LENGTH) : getOpencodeToolDisplayName(toolName);
}

/**
 * The renderer hints for one tool call.
 *
 * A `task` call carries the subagent labels too, because the workbench renders
 * the subagent card from this bag before any of the child session's own content
 * has arrived.
 */
export function buildOpencodeToolMeta(toolName: string, input?: unknown): Record<string, unknown> | undefined {
	const row = TOOL_ROWS[toolName];
	if (!row?.toolKind) {
		return undefined;
	}
	return toToolCallMeta({
		toolKind: row.toolKind,
		...(toolName === 'bash' ? { language: 'bash' } : {}),
		...(toolName === OPENCODE_TASK_TOOL ? {
			subagentDescription: readStringField(input, 'description'),
			subagentAgentName: readStringField(input, 'subagent_type'),
		} : {}),
	});
}

export function stringifyOpencodeToolInput(input: unknown): string | undefined {
	if (input === undefined || input === null) {
		return undefined;
	}
	if (typeof input === 'string') {
		return input;
	}
	try {
		return JSON.stringify(input);
	} catch {
		return undefined;
	}
}

/** The absolute path a tool call acts on, when its row declares one. */
export function getOpencodeToolPath(toolName: string, input: unknown, cwd: string): string | undefined {
	const row = TOOL_ROWS[toolName];
	const path = row?.pathField ? readStringField(input, row.pathField) : undefined;
	return path ? resolve(cwd, path) : undefined;
}

function pathLink(toolName: string, input: unknown, cwd: string): string | undefined {
	const absolutePath = getOpencodeToolPath(toolName, input, cwd);
	if (!absolutePath) {
		return undefined;
	}
	const uri = URI.file(absolutePath);
	return `[${escapeMarkdownLinkLabel(basename(uri))}](${uri})`;
}

function readStringField(input: unknown, field: string): string | undefined {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return undefined;
	}
	const value = (input as Record<string, unknown>)[field];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function md(markdown: string): StringOrMarkdown {
	return { markdown };
}
