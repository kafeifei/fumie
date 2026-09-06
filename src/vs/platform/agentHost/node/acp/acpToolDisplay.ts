/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk';
import { escapeMarkdownLinkLabel } from '../../../../base/common/htmlContent.js';
import { basename } from '../../../../base/common/resources.js';
import { truncate } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { IAgentToolPendingConfirmationSignal } from '../../common/agent.js';
import { toToolCallMeta } from '../../common/meta/agentToolCallMeta.js';
import type { StringOrMarkdown } from '../../common/state/protocol/state.js';

/**
 * Display strings for ACP tool calls.
 *
 * Everything here keys off the protocol's own `ToolKind` taxonomy — never off a
 * tool's name and never off which agent produced it. ACP deliberately makes
 * `title` the agent's human-readable summary and `kind` the machine-readable
 * category, so a connector that renders `title` verbatim and switches only on
 * `kind` stays dialect-free by construction: a new ACP agent contributes new
 * titles, never new branches.
 */

const MAX_TITLE_LENGTH = 200;

interface IAcpToolKindRow {
	readonly permissionKind: NonNullable<IAgentToolPendingConfirmationSignal['permissionKind']>;
	/** Whether a `locations[0].path` should be forwarded as the auto-approval path target. */
	readonly usesPath?: boolean;
	/** Renderer hint carried on the tool call's `_meta`. */
	readonly toolKind?: 'terminal' | 'read' | 'search';
}

/**
 * The complete ACP `ToolKind` enum. Exhaustive by construction: the `Record`
 * key type is the protocol union, so a protocol upgrade that adds a kind fails
 * compilation here instead of silently falling through to `custom-tool`.
 */
const TOOL_KIND_ROWS: Readonly<Record<ToolKind, IAcpToolKindRow>> = {
	read: { permissionKind: 'read', usesPath: true, toolKind: 'read' },
	edit: { permissionKind: 'write', usesPath: true },
	delete: { permissionKind: 'write', usesPath: true },
	move: { permissionKind: 'write', usesPath: true },
	search: { permissionKind: 'read', toolKind: 'search' },
	execute: { permissionKind: 'shell', toolKind: 'terminal' },
	think: { permissionKind: 'custom-tool' },
	fetch: { permissionKind: 'url' },
	switch_mode: { permissionKind: 'custom-tool' },
	other: { permissionKind: 'custom-tool' },
};

export interface IAcpApprovalTarget {
	readonly permissionKind: NonNullable<IAgentToolPendingConfirmationSignal['permissionKind']>;
	readonly permissionPath?: string;
}

/**
 * Maps an ACP tool kind (plus the locations it reported) onto the host's
 * auto-approval taxonomy.
 *
 * ACP has no shell-language field, so `shellLanguage` is deliberately never
 * set: the host only runs terminal-rule analysis on a language it was told,
 * and guessing `bash` for an agent that may have run PowerShell would let a
 * rule auto-approve a command it never actually analysed.
 */
export function getAcpApprovalTarget(kind: ToolKind | undefined, locations: readonly ToolCallLocation[] | undefined): IAcpApprovalTarget {
	const row = TOOL_KIND_ROWS[kind ?? 'other'] ?? TOOL_KIND_ROWS.other;
	const path = row.usesPath ? absoluteLocationPath(locations) : undefined;
	return {
		permissionKind: row.permissionKind,
		...(path ? { permissionPath: path } : {}),
	};
}

/**
 * The tool label shown in the transcript.
 *
 * ACP's `name` (the programmatic tool name) is an unstable, optional field, so
 * the agent's `title` is the only thing guaranteed to be present and
 * human-readable. Falls back to the kind's generic label.
 */
export function getAcpToolDisplayName(kind: ToolKind | undefined, title: string | undefined): string {
	const trimmed = title?.trim();
	return trimmed ? truncate(trimmed, MAX_TITLE_LENGTH) : getAcpToolKindLabel(kind);
}

/**
 * The internal tool name reported to telemetry and logs. Prefers the
 * agent-supplied programmatic name and degrades to the protocol kind, so this
 * value is stable across turns even when the title changes.
 */
export function getAcpToolName(kind: ToolKind | undefined, name: string | null | undefined): string {
	const trimmed = typeof name === 'string' ? name.trim() : '';
	return trimmed || kind || 'other';
}

export function getAcpToolKindLabel(kind: ToolKind | undefined): string {
	switch (kind) {
		case 'read': return localize('acp.tool.read', "Read file");
		case 'edit': return localize('acp.tool.edit', "Edit file");
		case 'delete': return localize('acp.tool.delete', "Delete file");
		case 'move': return localize('acp.tool.move', "Move file");
		case 'search': return localize('acp.tool.search', "Search");
		case 'execute': return localize('acp.tool.execute', "Run command");
		case 'think': return localize('acp.tool.think', "Think");
		case 'fetch': return localize('acp.tool.fetch', "Fetch");
		case 'switch_mode': return localize('acp.tool.switchMode', "Switch mode");
		default: return localize('acp.tool.other', "Tool call");
	}
}

export function getAcpConfirmationTitle(kind: ToolKind | undefined): string {
	switch (TOOL_KIND_ROWS[kind ?? 'other']?.permissionKind) {
		case 'read': return localize('acp.permission.read.title', "Read files?");
		case 'write': return localize('acp.permission.write.title', "Edit files?");
		case 'shell': return localize('acp.permission.shell.title', "Run in terminal?");
		case 'url': return localize('acp.permission.url.title', "Fetch from the web?");
		default: return localize('acp.permission.default.title', "Allow tool call?");
	}
}

/**
 * Present-tense progress line. The agent's `title` is authoritative; a file
 * location is appended as a clickable link when the kind is path-shaped and the
 * title did not already name the file.
 */
export function getAcpInvocationMessage(kind: ToolKind | undefined, title: string | undefined, locations: readonly ToolCallLocation[] | undefined): StringOrMarkdown {
	const label = getAcpToolDisplayName(kind, title);
	const link = TOOL_KIND_ROWS[kind ?? 'other']?.usesPath ? locationLink(locations) : undefined;
	return link ? { markdown: `${escapeMarkdownLinkLabel(label)} ${link}` } : label;
}

export function getAcpPastTenseMessage(kind: ToolKind | undefined, title: string | undefined, success: boolean): StringOrMarkdown {
	const label = getAcpToolDisplayName(kind, title);
	return success ? label : localize('acp.toolResult.failed', "{0} failed", label);
}

export function buildAcpToolMeta(kind: ToolKind | undefined): Record<string, unknown> | undefined {
	const row = TOOL_KIND_ROWS[kind ?? 'other'];
	return row?.toolKind ? toToolCallMeta({ toolKind: row.toolKind }) : undefined;
}

/** Serializes an ACP `rawInput` for the tool call's streamed input pane. */
export function stringifyAcpToolInput(input: unknown): string | undefined {
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

/** First absolute path reported by the tool call, when it reported one. */
export function absoluteLocationPath(locations: readonly ToolCallLocation[] | undefined): string | undefined {
	for (const location of locations ?? []) {
		if (typeof location?.path === 'string' && location.path.length > 0) {
			return location.path;
		}
	}
	return undefined;
}

function locationLink(locations: readonly ToolCallLocation[] | undefined): string | undefined {
	const path = absoluteLocationPath(locations);
	if (!path) {
		return undefined;
	}
	const uri = URI.file(path);
	return `[${escapeMarkdownLinkLabel(basename(uri))}](${uri})`;
}
