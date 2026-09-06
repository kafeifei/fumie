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
import { toToolCallMeta } from '../../common/meta/agentToolCallMeta.js';
import type { IAgentToolPendingConfirmationSignal } from '../../common/agent.js';
import type { StringOrMarkdown } from '../../common/state/protocol/state.js';

interface IPiToolRow {
	readonly permissionKind: NonNullable<IAgentToolPendingConfirmationSignal['permissionKind']>;
	readonly pathField?: 'path';
	readonly shellLanguage?: IAgentToolPendingConfirmationSignal['shellLanguage'];
	readonly toolKind?: 'terminal' | 'read';
}

const TOOL_ROWS: Readonly<Record<string, IPiToolRow>> = {
	read: { permissionKind: 'read', pathField: 'path', toolKind: 'read' },
	write: { permissionKind: 'write', pathField: 'path' },
	edit: { permissionKind: 'write', pathField: 'path' },
	bash: { permissionKind: 'shell', shellLanguage: 'bash', toolKind: 'terminal' },
};

export interface IPiApprovalTarget {
	readonly permissionKind: NonNullable<IAgentToolPendingConfirmationSignal['permissionKind']>;
	readonly permissionPath?: string;
	readonly shellLanguage?: IAgentToolPendingConfirmationSignal['shellLanguage'];
}

export function getPiApprovalTarget(toolName: string, input: unknown, cwd: string): IPiApprovalTarget {
	const row = TOOL_ROWS[toolName];
	const path = row?.pathField ? readStringField(input, row.pathField) : undefined;
	return {
		permissionKind: row?.permissionKind ?? 'custom-tool',
		...(path ? { permissionPath: resolve(cwd, path) } : {}),
		...(row?.shellLanguage ? { shellLanguage: row.shellLanguage } : {}),
	};
}

export function getPiToolDisplayName(toolName: string): string {
	switch (toolName) {
		case 'read': return localize('pi.tool.read', "Read file");
		case 'write': return localize('pi.tool.write', "Write file");
		case 'edit': return localize('pi.tool.edit', "Edit file");
		case 'bash': return localize('pi.tool.bash', "Run shell command");
		default: return toolName;
	}
}

export function getPiConfirmationTitle(toolName: string): string {
	switch (TOOL_ROWS[toolName]?.permissionKind) {
		case 'read': return localize('pi.permission.read.title', "Read file?");
		case 'write': return localize('pi.permission.write.title', "Edit file?");
		case 'shell': return localize('pi.permission.shell.title', "Run in terminal?");
		default: return localize('pi.permission.default.title', "Allow tool call?");
	}
}

export function getPiInvocationMessage(toolName: string, input: unknown, cwd: string): StringOrMarkdown {
	if (toolName === 'bash') {
		const command = readStringField(input, 'command');
		return command
			? md(localize('pi.toolInvoke.bashCommand', "Running {0}", appendEscapedMarkdownInlineCode(truncate(command.split('\n')[0], 80))))
			: localize('pi.toolInvoke.bash', "Running shell command");
	}
	const path = readStringField(input, 'path');
	if (path) {
		const absolutePath = resolve(cwd, path);
		const link = `[${escapeMarkdownLinkLabel(basename(URI.file(absolutePath)))}](${URI.file(absolutePath)})`;
		return toolName === 'read'
			? md(localize('pi.toolInvoke.readFile', "Read {0}", link))
			: md(localize('pi.toolInvoke.editFile', "Edit {0}", link));
	}
	return getPiToolDisplayName(toolName);
}

export function getPiPastTenseMessage(toolName: string, input: unknown, cwd: string, success: boolean): StringOrMarkdown {
	if (!success) {
		return localize('pi.toolResult.failed', "{0} failed", getPiToolDisplayName(toolName));
	}
	if (toolName === 'bash') {
		return localize('pi.toolResult.bash', "Ran shell command");
	}
	const path = readStringField(input, 'path');
	if (path) {
		const absolutePath = resolve(cwd, path);
		const link = `[${escapeMarkdownLinkLabel(basename(URI.file(absolutePath)))}](${URI.file(absolutePath)})`;
		return toolName === 'read'
			? md(localize('pi.toolResult.readFile', "Read {0}", link))
			: md(localize('pi.toolResult.editedFile', "Edited {0}", link));
	}
	return getPiToolDisplayName(toolName);
}

export function buildPiToolMeta(toolName: string): Record<string, unknown> | undefined {
	const row = TOOL_ROWS[toolName];
	return row?.toolKind
		? toToolCallMeta({ toolKind: row.toolKind, ...(toolName === 'bash' ? { language: 'bash' } : {}) })
		: undefined;
}

export function stringifyPiToolInput(input: unknown): string | undefined {
	if (input === undefined) {
		return undefined;
	}
	try {
		return JSON.stringify(input);
	} catch {
		return String(input);
	}
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
