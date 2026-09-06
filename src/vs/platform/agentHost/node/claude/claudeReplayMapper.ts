/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { ILogService } from '../../../log/common/log.js';
import {
	ResponsePartKind,
	ToolCallCancellationReason,
	ToolCallConfirmationReason,
	ToolCallStatus,
	ToolResultContentType,
	TurnState,
	MessageKind,
	MessageAttachmentKind,
	type MessageAttachment,
	type ResponsePart,
	type ToolCallCancelledState,
	type ToolCallCompletedState,
	type ToolCallResponsePart,
	type ToolResultContent,
	type Turn,
} from '../../common/state/protocol/state.js';
import { buildSubagentSessionUri } from '../../common/state/sessionState.js';
import { readToolCallMeta } from '../../common/meta/agentToolCallMeta.js';
import { formatGenericToolInput } from '../../common/streamingToolCallDisplay.js';
import { buildClaudeToolMeta, getClaudeInvocationMessage, getClaudePastTenseMessage, getClaudeToolDisplayName, getClaudeToolInputString } from './claudeToolDisplay.js';
import { hasClientToolNamePrefix, stripClientToolNamePrefix } from './clientTools/claudeClientToolMcpServer.js';

/**
 * Phase 13 — replay mapper. Reduces a flat `SessionMessage[]` (the SDK's
 * on-disk JSONL transcript) into the protocol's `Turn[]` shape per
 * [CONTEXT.md M7](./CONTEXT.md). Pure function; no I/O, no DI.
 *
 * Distinct from the live mapper (`mapSDKMessageToAgentSignals`) because:
 * - input shape differs (`SessionMessage` envelope vs `SDKMessage` union),
 * - output shape differs (`Turn[]` vs `AgentSignal[]`),
 * - replay has no `'result'` envelope (SDK doesn't persist it) and no
 *   `'stream_event'` lifecycle (terminal states only).
 *
 * Shared invariant with the live mapper: the `Map<tool_use_id, turnId>`
 * attribution rule from M7 — `tool_result` legitimately lands in a later
 * `'user'` envelope and must resolve back to the announcing `tool_use`'s
 * turn. This mapper builds an equivalent local map during its single pass.
 */
export function mapSessionMessagesToTurns(
	messages: readonly SessionMessage[],
	session: URI,
	logService: ILogService,
	hostInstructions?: readonly string[],
): readonly Turn[] {
	const builder = new ReplayBuilder(session, logService);
	for (const msg of messages) {
		const parsed = parseSessionMessage(msg, hostInstructions);
		if (parsed === undefined) {
			continue;
		}
		builder.consume(parsed);
	}
	return builder.finish();
}

/**
 * Phase 6.5 — translate a protocol `turnId` (the last KEPT turn N) into the
 * SDK envelope `uuid` that `forkSession({ upToMessageId })` accepts
 * (INCLUSIVE). Returns the `uuid` of turn N's last `'assistant'` envelope,
 * or `undefined` when `turnId` is not in the transcript or the turn has no
 * assistant envelope yet. Agent Host Protocol request turn IDs are not valid SDK fork UUIDs.
 * Reuses {@link parseSessionMessage} so the turn-boundary rule matches
 * {@link ReplayBuilder}; always returns an envelope `uuid`, never a `msg_…` id.
 */
export function resolveForkAnchorUuid(messages: readonly SessionMessage[], turnId: string): string | undefined {
	let turnOpen = false;
	let seenTarget = false;
	let lastAssistantUuid: string | undefined;
	for (const msg of messages) {
		const parsed = parseSessionMessage(msg);
		if (parsed === undefined) {
			continue;
		}
		if (parsed.kind === 'user-text') {
			if (seenTarget) {
				// First genuine user-text after turn N started → turn N is over.
				break;
			}
			turnOpen = true;
			if (parsed.uuid === turnId) {
				seenTarget = true;
			}
		} else if (parsed.kind === 'assistant') {
			if (!turnOpen) {
				// Mirrors {@link ReplayBuilder._consumeAssistant}: an assistant
				// envelope with no turn open starts one keyed on its own uuid
				// (subagent transcript, or a truncated slice that lost its
				// prompt). Without this the resolver can't anchor a fork on
				// such a turn.
				turnOpen = true;
				if (parsed.uuid === turnId) {
					seenTarget = true;
				}
			}
			if (seenTarget) {
				lastAssistantUuid = parsed.uuid;
			}
		}
		// 'user-tool-results' / 'system-notification' never flip the turn.
	}
	if (!seenTarget) {
		return undefined;
	}
	return lastAssistantUuid;
}

// #region Parsed message union — narrow-at-the-seam adapter

interface UserTextBlock { readonly type: 'text'; readonly text: string }
interface UserImageBlock { readonly type: 'image'; readonly mediaType: string; readonly data: string }
interface UserToolResultBlock { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: unknown; readonly is_error: boolean }
interface AssistantBlock { readonly type: string; readonly text?: string; readonly thinking?: string; readonly id?: string; readonly name?: string; readonly input?: unknown }

/**
 * Discriminated union of replay-relevant message shapes. Everything that
 * the mapper actually cares about is one of these; everything else (hooks,
 * CLI-echo entries, unallowed system subtypes, malformed envelopes) returns
 * `undefined` from {@link parseSessionMessage}.
 *
 * The split keeps SDK shape detection (this seam) separate from the
 * stateful reduction (the {@link ReplayBuilder}) — see CONTEXT M7.
 */
type ParsedSessionMessage =
	| { readonly kind: 'user-text'; readonly uuid: string; readonly text: string; readonly attachments?: readonly MessageAttachment[]; readonly timestamp?: string }
	| { readonly kind: 'user-tool-results'; readonly uuid: string; readonly results: readonly UserToolResultBlock[]; readonly timestamp?: string }
	| { readonly kind: 'assistant'; readonly uuid: string; readonly blocks: readonly AssistantBlock[]; readonly isInner: boolean; readonly timestamp?: string; readonly usage?: ReplayCallUsage; readonly model?: string }
	| { readonly kind: 'system-notification'; readonly uuid: string; readonly subtype: string; readonly text: string; readonly timestamp?: string };

function parseSessionMessage(msg: SessionMessage, hostInstructions?: readonly string[]): ParsedSessionMessage | undefined {
	const timestamp = readTimestamp(msg);
	switch (msg.type) {
		case 'user': return parseUserMessage(msg, timestamp, hostInstructions);
		case 'assistant': return parseAssistantMessage(msg, timestamp);
		case 'system': return parseSystemMessage(msg, timestamp);
		default: return undefined;
	}
}

function readTimestamp(msg: SessionMessage & { readonly timestamp?: unknown }): string | undefined {
	if (typeof msg.timestamp !== 'string') {
		return undefined;
	}
	const timestamp = Date.parse(msg.timestamp);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function parseUserMessage(msg: SessionMessage, timestamp: string | undefined, hostInstructions: readonly string[] | undefined): ParsedSessionMessage | undefined {
	const content = readUserContent(msg.message);
	if (content === undefined) {
		return undefined;
	}
	if (isCliEchoContent(content)) {
		return undefined;
	}
	if (typeof content === 'string') {
		const text = stripInjectedNotifications(stripHostInstructions(content, hostInstructions));
		return text ? { kind: 'user-text', uuid: msg.uuid, text, timestamp } : undefined;
	}
	const texts = content
		.filter((b): b is UserTextBlock => b.type === 'text' && !HOST_REMINDER_BLOCK_PATTERN.test(b.text))
		.map(b => stripInjectedNotifications(stripHostInstructions(b.text, hostInstructions)))
		.filter(text => text.length > 0);
	// The prompt resolver flattens image attachments (pasted or file-backed)
	// into bare image blocks, discarding label and origin; an embedded
	// attachment is what the bytes can still faithfully reconstitute.
	const attachments = content
		.filter((b): b is UserImageBlock => b.type === 'image')
		.map((b, i): MessageAttachment => ({
			type: MessageAttachmentKind.EmbeddedResource,
			label: i === 0 ? localize('claude.replay.imageAttachment', "Image") : localize('claude.replay.imageAttachmentN', "Image {0}", i + 1),
			displayKind: 'image',
			contentType: b.mediaType,
			data: b.data,
		}));
	if (texts.length === 0 && attachments.length === 0) {
		const results = content.filter((b): b is UserToolResultBlock => b.type === 'tool_result');
		return results.length > 0 ? { kind: 'user-tool-results', uuid: msg.uuid, results, timestamp } : undefined;
	}
	// Mixed or text-only: text wins — matches prior behavior where tool_results
	// in a text-bearing envelope are dropped (they should already have been delivered).
	return { kind: 'user-text', uuid: msg.uuid, text: texts.join('\n'), ...(attachments.length > 0 ? { attachments } : {}), timestamp };
}

function parseAssistantMessage(msg: SessionMessage, timestamp: string | undefined): ParsedSessionMessage | undefined {
	const blocks = readAssistantBlocks(msg.message);
	if (blocks === undefined || blocks.length === 0) {
		return undefined;
	}
	// Subagent transcripts (from `getSubagentMessages`) carry a
	// `parent_tool_use_id` on every envelope and have no synthetic spawning
	// user prompt, so they legitimately open with an assistant message —
	// `isInner` lets the builder synthesize a turn instead of dropping it.
	const isInner = msg.parent_tool_use_id !== null;
	const usage = isInner ? undefined : readAssistantUsage(msg.message);
	return {
		kind: 'assistant', uuid: msg.uuid, blocks, isInner, timestamp,
		...(usage ? { usage } : {}),
		...(usage ? { model: readAssistantModel(msg.message) } : {}),
	};
}

/** One replayed main-loop call's usage, mirroring the live mapper's `IMainLoopCallUsage`. */
interface ReplayCallUsage {
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheCreationTokens: number;
	readonly outputTokens: number;
}

/**
 * Reads a replayed assistant envelope's per-call usage. An all-zero block
 * (synthetic error notices carry one) returns `undefined` so it cannot wipe
 * the last real occupancy.
 */
function readAssistantUsage(raw: unknown): ReplayCallUsage | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const usage = (raw as { usage?: unknown }).usage;
	if (usage === null || typeof usage !== 'object') {
		return undefined;
	}
	const u = usage as Record<string, unknown>;
	const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
	const parsed: ReplayCallUsage = {
		inputTokens: num(u['input_tokens']),
		cacheReadTokens: num(u['cache_read_input_tokens']),
		cacheCreationTokens: num(u['cache_creation_input_tokens']),
		outputTokens: num(u['output_tokens']),
	};
	const occupancy = parsed.inputTokens + parsed.cacheReadTokens + parsed.cacheCreationTokens;
	return occupancy > 0 ? parsed : undefined;
}

function readAssistantModel(raw: unknown): string | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const model = (raw as { model?: unknown }).model;
	return typeof model === 'string' && model.length > 0 && model !== '<synthetic>' ? model : undefined;
}

function parseSystemMessage(msg: SessionMessage, timestamp: string | undefined): ParsedSessionMessage | undefined {
	const subtype = readSystemSubtype(msg.message);
	if (subtype === undefined || !ALLOWED_SYSTEM_SUBTYPES.has(subtype)) {
		return undefined;
	}
	const text = readSystemText(msg.message) ?? `[${subtype}]`;
	return { kind: 'system-notification', uuid: msg.uuid, subtype, text, timestamp };
}

// #endregion

// #region Builder

/**
 * Allowlist of `system` subtypes that survive replay as
 * {@link ResponsePartKind.SystemNotification} parts on the active turn.
 * Mirrors CONTEXT M7's table — anything not in this set is dropped.
 */
const ALLOWED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
	'compact_boundary',
	'notification',
]);

/**
 * CLI-echo markers the Claude Code CLI writes into the transcript for
 * replay fidelity. They are `type: 'user'` envelopes whose `message.content`
 * is a raw string starting with one of these tags — `<command-name>` /
 * `<command-args>` (slash-command echoes like `/model claude-opus-4.7`),
 * `<local-command-stdout>` / `<local-command-stderr>` (echo of the local
 * handler's output, e.g. "Set model to claude-opus-4.7"), and
 * `<local-command-caveat>` (the "messages below were generated while…"
 * preamble). The entries don't carry `isSynthetic` / `isMeta` reliably
 * (the `/model` echo lacks both, verified empirically), so the only reliable
 * discriminator is the content shape itself. Drop on replay so the workbench
 * doesn't render them as user turns.
 */
const CLI_ECHO_MARKER_PATTERN = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;

/**
 * Harness-injected background-task notifications. The Claude Code harness
 * appends these to the conversation as `type: 'user'` envelopes (a
 * `[SYSTEM NOTIFICATION - NOT USER INPUT]` preamble followed by a
 * `<task-notification>…</task-notification>` block); the workbench must not
 * render them as user turns. Unlike CLI echoes they can share an envelope
 * with genuine user input (notifications queued while the user types are
 * delivered together), so they are stripped from the text rather than the
 * envelope being dropped — an envelope left with no text at all is then
 * dropped by the caller.
 */
const INJECTED_NOTIFICATION_PATTERN = /(?:\[SYSTEM NOTIFICATION - NOT USER INPUT\][\s\S]*?)?<task-notification>[\s\S]*?<\/task-notification>\s*/g;

/**
 * Host- or harness-generated `<system-reminder>` blocks riding a user
 * envelope — the prompt resolver's attachment-reference list, the Claude
 * harness's own context reminders. They are self-contained text blocks that
 * BEGIN with the tag; genuinely user-typed text never does (the same
 * shape-is-the-discriminator trade-off as {@link CLI_ECHO_MARKER_PATTERN}).
 * Dropped at the block level so replay shows only what the user typed.
 */
const HOST_REMINDER_BLOCK_PATTERN = /^<system-reminder>/;

function stripInjectedNotifications(text: string): string {
	return text.replace(INJECTED_NOTIFICATION_PATTERN, '').trim();
}

/**
 * Removes host-injected instructions from a replayed user message.
 *
 * The host attaches per-operation instructions to a send on the explicit
 * promise that they reach the model "without persisting as user content"
 * (`IAgentChatContext.hostInstructions`). This provider delivers them through
 * the SDK's `UserPromptSubmit` hook (`claudeSdkOptions`), but the SDK persists
 * the hook's `additionalContext` as a leading `text` block of the user
 * envelope — structurally indistinguishable from what the user typed — so a
 * replayed chat would show the host's instructions to the user, in their own
 * voice, on every turn. The history read carries the same strings the send
 * injected (see `AgentService._getChatMessages`), and taking them back out
 * here is what keeps the host's promise.
 *
 * Only text the host itself supplied is removed, so this can never eat
 * something the user typed: an instruction the host has since stopped sending
 * simply is not recognised and survives as ordinary text — the honest failure.
 * Mirrors `stripAcpHostInstructions`, which keeps the same promise for ACP.
 */
function stripHostInstructions(text: string, instructions: readonly string[] | undefined): string {
	let result = text;
	for (const instruction of instructions ?? []) {
		if (instruction) {
			result = result.split(instruction).join('');
		}
	}
	return result;
}

/**
 * Stand-in prompt for a turn whose user message is not present in the
 * transcript slice we were handed. This happens when the SDK truncates a
 * large transcript (it returns only the bytes after the last compact
 * boundary), which cuts the opening prompt off mid-turn. Showing the
 * recovered assistant content under a placeholder prompt is strictly better
 * than dropping the turn — dropping can silently empty an entire session.
 */
export function missingPromptPlaceholder(): string {
	return localize('claude.replay.missingPrompt', "Message content could not be retrieved");
}

interface InProgressTurn {
	readonly id: string;
	readonly userText: string;
	readonly attachments?: readonly MessageAttachment[];
	readonly startedAt?: string;
	lastResponseAt?: string;
	readonly responseParts: ResponsePart[];
	/**
	 * `tool_use_id`s announced by THIS turn. Drained when the matching
	 * `tool_result` lands (which may arrive in this turn's user-side
	 * `tool_result` block or a later turn's). At turn close, non-empty →
	 * tail Turn marked `Cancelled`.
	 */
	readonly pendingToolUseIds: Set<string>;
	/**
	 * Stash of completed `ToolCallResponsePart`s waiting on their result
	 * content. `tool_use` opens with a placeholder; the matching
	 * `tool_result` fills it in. Keyed by `tool_use_id`.
	 */
	readonly toolCallParts: Map<string, ToolCallResponsePart>;
}

class ReplayBuilder {
	private readonly _turns: Turn[] = [];
	private _active: InProgressTurn | undefined;
	/**
	 * Cross-turn tool-use tracking. Keyed by `tool_use_id`:
	 * - `turnId` — the announcing turn (so a late `tool_result` in a
	 *   later `user` envelope can attach back to the right turn per M7).
	 * - `parsedInput` — the original `tool_use.input`, looked up at
	 *   `_attachToolResult` so the past-tense message can include the
	 *   original parameters. Mirrors the live mapper's `_toolCallInfo`
	 *   pattern but simpler (replay has the full input synchronously on
	 *   the `tool_use` block).
	 */
	private readonly _toolUses = new Map<string, { readonly turnId: string; readonly parsedInput: Record<string, unknown> | undefined; readonly isClientTool: boolean }>();

	/**
	 * Usage of the most recent top-level assistant envelope. Its prompt-side
	 * fields describe one API call's full prompt — the session's context
	 * occupancy at that point — so each closed turn carries the latest value
	 * (mirrors the live mapper's `recordMainLoopUsage`). Not reset between
	 * turns: occupancy only changes when another call is made.
	 */
	private _lastCallUsage: { readonly usage: ReplayCallUsage; readonly model?: string } | undefined;

	/** Turns opened from a leading assistant envelope because the prompt was missing. Reported once by {@link finish}. */
	private _recoveredPromptlessTurns = 0;

	/** `tool_result` blocks whose announcing `tool_use` was not in the slice. Reported once by {@link finish}. */
	private _orphanToolResults = 0;

	constructor(private readonly _session: URI, private readonly _logService: ILogService) { }

	consume(msg: ParsedSessionMessage): void {
		switch (msg.kind) {
			case 'user-text':
				this._closeActive();
				this._active = {
					id: msg.uuid,
					userText: msg.text,
					attachments: msg.attachments,
					startedAt: msg.timestamp,
					responseParts: [],
					pendingToolUseIds: new Set(),
					toolCallParts: new Map(),
				};
				return;
			case 'user-tool-results': {
				let updatesActiveTurn = false;
				for (const block of msg.results) {
					updatesActiveTurn = this._attachToolResult(block) === this._active?.id || updatesActiveTurn;
				}
				if (updatesActiveTurn && this._active && msg.timestamp) {
					this._active.lastResponseAt = msg.timestamp;
				}
				return;
			}
			case 'assistant':
				this._consumeAssistant(msg);
				return;
			case 'system-notification':
				if (this._active === undefined) {
					// System notification before any user message — drop. Without an active turn there's nowhere to attach.
					return;
				}
				this._active.responseParts.push({
					kind: ResponsePartKind.SystemNotification,
					content: msg.text,
				});
				if (msg.timestamp) {
					this._active.lastResponseAt = msg.timestamp;
				}
				return;
		}
	}

	finish(): readonly Turn[] {
		this._closeActive();
		// One summary line per replay instead of one warn per envelope: a
		// truncated transcript produces these by the hundred, and the
		// per-envelope form drowned out the fact that the whole session had
		// been reduced to nothing.
		if (this._recoveredPromptlessTurns > 0 || this._orphanToolResults > 0) {
			this._logService.warn(`[claudeReplayMapper] incomplete transcript for ${this._session.toString()}: ${this._recoveredPromptlessTurns} turn(s) recovered without their prompt, ${this._orphanToolResults} orphaned tool_result(s)`);
		}
		return this._turns;
	}

	private _consumeAssistant(msg: ParsedSessionMessage & { kind: 'assistant' }): void {
		if (msg.usage) {
			// The occupancy always comes from this envelope, but the model does
			// NOT: `readAssistantModel` filters the SDK's `<synthetic>` sentinel
			// (and any other unusable value) to `undefined`, and such an envelope
			// can still carry real non-zero usage. Overwriting the model with
			// `undefined` there would erase the only model id the replay ever saw,
			// and the context gauge has no other way to find its denominator —
			// replayed usage carries no `_meta.modelContextWindow`, so the client
			// resolves the window by looking the model id up in the catalog.
			// Keep the last real model until a later envelope names another one.
			this._lastCallUsage = { usage: msg.usage, model: msg.model ?? this._lastCallUsage?.model };
		}
		if (this._active === undefined) {
			// Two ways a transcript legitimately opens with an assistant
			// envelope:
			// - Subagent transcript (`isInner`): every envelope carries
			//   `parent_tool_use_id` and the SDK omits the synthetic spawning
			//   prompt, so there is genuinely no prompt to show.
			// - Truncated parent transcript: the SDK drops everything before
			//   the last compact boundary for transcripts over its size
			//   threshold, which can cut the prompt off mid-turn.
			// Either way, synthesize a turn to hold the reply. Dropping would
			// discard the assistant content — and when the truncated slice
			// contains no user message at all (one long agentic turn), that
			// means discarding the entire session.
			if (!msg.isInner) {
				this._recoveredPromptlessTurns++;
			}
			this._active = {
				id: msg.uuid,
				userText: msg.isInner ? '' : missingPromptPlaceholder(),
				startedAt: msg.timestamp,
				responseParts: [],
				pendingToolUseIds: new Set(),
				toolCallParts: new Map(),
			};
		}
		let textPartCounter = 0;
		let reasoningPartCounter = 0;
		for (const block of msg.blocks) {
			if (block.type === 'text' && typeof block.text === 'string') {
				this._active.responseParts.push({
					kind: ResponsePartKind.Markdown,
					id: `${this._active.id}#${msg.uuid}#text-${textPartCounter++}`,
					content: block.text,
				});
			} else if (block.type === 'thinking' && typeof block.thinking === 'string') {
				this._active.responseParts.push({
					kind: ResponsePartKind.Reasoning,
					id: `${this._active.id}#${msg.uuid}#thinking-${reasoningPartCounter++}`,
					content: block.thinking,
				});
			} else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
				// Strip the in-process MCP server prefix so the workbench resolves
				// the workbench-registered tool by its unprefixed name (matches the
				// live stream mapper). Without this, replayed client-tool calls
				// fall back to the generic "Run MCP tool" rendering.
				this._openToolUse(block.id, stripClientToolNamePrefix(block.name), block.input, hasClientToolNamePrefix(block.name));
			}
			// Other block types (server_tool_use, etc.) are dropped silently per M7.
		}
		if (msg.timestamp) {
			this._active.lastResponseAt = msg.timestamp;
		}
	}

	private _openToolUse(toolUseId: string, toolName: string, input: unknown, isClientTool: boolean): void {
		if (this._active === undefined) {
			return;
		}
		const displayName = isClientTool ? toolName : getClaudeToolDisplayName(toolName);
		const parsedInput = input !== null && typeof input === 'object' ? input as Record<string, unknown> : undefined;
		const meta = isClientTool ? undefined : buildClaudeToolMeta(toolName);
		// Build a placeholder Cancelled state by default; replaced with Completed when the tool_result lands.
		const placeholder: ToolCallCancelledState = {
			status: ToolCallStatus.Cancelled,
			toolCallId: toolUseId,
			toolName,
			displayName,
			invocationMessage: isClientTool ? displayName : getClaudeInvocationMessage(toolName, displayName, parsedInput),
			toolInput: parsedInput !== undefined
				? isClientTool ? formatGenericToolInput(parsedInput) : getClaudeToolInputString(toolName, parsedInput)
				: (typeof input === 'string' ? input : input !== undefined ? safeStringify(input) : undefined),
			reason: ToolCallCancellationReason.Skipped,
			...(meta ? { _meta: meta } : {}),
		};
		const part: ToolCallResponsePart = {
			kind: ResponsePartKind.ToolCall,
			toolCall: placeholder,
		};
		this._active.responseParts.push(part);
		this._active.toolCallParts.set(toolUseId, part);
		this._active.pendingToolUseIds.add(toolUseId);
		this._toolUses.set(toolUseId, { turnId: this._active.id, parsedInput, isClientTool });
	}

	private _attachToolResult(block: UserToolResultBlock): string | undefined {
		const entry = this._toolUses.get(block.tool_use_id);
		if (entry === undefined) {
			this._orphanToolResults++;
			return undefined;
		}
		const announcingTurnId = entry.turnId;
		// Find the part — it lives on the announcing turn (which may be `_active` or one already pushed to `_turns`).
		const part = this._findToolCallPart(announcingTurnId, block.tool_use_id);
		if (part === undefined) {
			return undefined;
		}
		const isError = block.is_error;
		const previousState = part.toolCall;
		const isSubagent = readToolCallMeta(previousState).toolKind === 'subagent';
		const content: ToolResultContent[] = extractToolResultContent(block.content) ?? [];
		const resultText = content
			.filter((c): c is { type: ToolResultContentType.Text; text: string } => c.type === ToolResultContentType.Text)
			.map(c => c.text)
			.join('\n');
		if (isSubagent) {
			content.push({
				type: ToolResultContentType.Subagent,
				resource: buildSubagentSessionUri(this._session.toString(), previousState.toolCallId),
				title: previousState.displayName,
			});
		}
		const completed: ToolCallCompletedState = {
			status: ToolCallStatus.Completed,
			toolCallId: previousState.toolCallId,
			toolName: previousState.toolName,
			displayName: previousState.displayName,
			invocationMessage: previousState.invocationMessage ?? previousState.displayName,
			toolInput: previousState.status === ToolCallStatus.Streaming ? undefined : previousState.toolInput,
			confirmed: ToolCallConfirmationReason.NotNeeded,
			success: !isError,
			pastTenseMessage: entry.isClientTool
				? previousState.displayName
				: getClaudePastTenseMessage(previousState.toolName, previousState.displayName, entry.parsedInput, !isError, resultText),
			content: content.length > 0 ? content : undefined,
			...(previousState._meta ? { _meta: previousState._meta } : {}),
		};
		part.toolCall = completed;
		// Drain pending tracker on the announcing turn — but only if that
		// turn is still in progress. Committed turns have their state
		// locked at close time per Fixture 6b ("orphan in turn N does
		// NOT cancel turn N+1"); a late-arriving tool_result for a
		// committed turn doesn't re-promote it.
		if (this._active?.id === announcingTurnId) {
			this._active.pendingToolUseIds.delete(block.tool_use_id);
		}
		return announcingTurnId;
	}

	private _findToolCallPart(turnId: string, toolUseId: string): ToolCallResponsePart | undefined {
		if (this._active && this._active.id === turnId) {
			return this._active.toolCallParts.get(toolUseId);
		}
		// Already-closed turn: search committed Turns. Linear scan is fine — replay is one-shot per session and turns are O(tens-hundreds).
		for (let i = this._turns.length - 1; i >= 0; i--) {
			if (this._turns[i].id !== turnId) {
				continue;
			}
			for (const part of this._turns[i].responseParts) {
				if (part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === toolUseId) {
					return part;
				}
			}
			return undefined;
		}
		return undefined;
	}

	private _closeActive(): void {
		if (this._active === undefined) {
			return;
		}
		const a = this._active;
		const state = a.pendingToolUseIds.size === 0 ? TurnState.Complete : TurnState.Cancelled;
		const startedAt = a.startedAt === undefined ? undefined : Date.parse(a.startedAt);
		const endedAt = a.lastResponseAt === undefined ? undefined : Date.parse(a.lastResponseAt);
		const duration = startedAt !== undefined && endedAt !== undefined && Number.isFinite(startedAt) && Number.isFinite(endedAt)
			? Math.max(0, endedAt - startedAt)
			: undefined;
		// Rebuild the turn's usage from the latest replayed main-loop call so
		// the context-usage gauge survives a session reopen. The transcript's
		// `message.usage` carries the same three input-side counters the live
		// SDK reports, so they are transcribed into the same protocol counters —
		// cache creation into `_meta.cacheCreationTokens`, matching the live
		// mapper — and the client folds occupancy the same way for both paths.
		// Whole-turn totals and the SDK-reported window are result-envelope data
		// the transcript does not carry, so they stay absent.
		const lastCall = this._lastCallUsage;
		const turn: Turn = {
			id: a.id,
			startedAt: a.startedAt,
			duration,
			message: { text: a.userText, origin: { kind: MessageKind.User }, ...(a.attachments?.length ? { attachments: [...a.attachments] } : {}) },
			responseParts: a.responseParts,
			usage: lastCall ? {
				inputTokens: lastCall.usage.inputTokens,
				outputTokens: lastCall.usage.outputTokens,
				cacheReadTokens: lastCall.usage.cacheReadTokens,
				_meta: { cacheCreationTokens: lastCall.usage.cacheCreationTokens },
				...(lastCall.model ? { model: lastCall.model } : {}),
			} : undefined,
			state,
		};
		this._turns.push(turn);
		this._active = undefined;
	}
}

// #endregion

// #region Helpers — narrow-at-the-seam shape readers

/**
 * Returns string content (legacy form) or an array of recognised user
 * blocks (text + tool_result). Anything else returns `undefined` and the
 * caller drops the message — matches the production extension's parser
 * semantics per CONTEXT M7 glossary.
 */
function readUserContent(raw: unknown): string | ReadonlyArray<UserTextBlock | UserImageBlock | UserToolResultBlock> | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const content = (raw as { content?: unknown }).content;
	if (typeof content === 'string') {
		return content.length > 0 ? content : undefined;
	}
	if (!Array.isArray(content) || content.length === 0) {
		return undefined;
	}
	const out: (UserTextBlock | UserImageBlock | UserToolResultBlock)[] = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object') {
			continue;
		}
		const b = block as { type?: unknown; text?: unknown; source?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
		if (b.type === 'text' && typeof b.text === 'string') {
			out.push({ type: 'text', text: b.text });
		} else if (b.type === 'image') {
			const source = (b.source ?? undefined) as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
			if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
				out.push({ type: 'image', mediaType: source.media_type, data: source.data });
			}
		} else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
			out.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error === true });
		}
	}
	return out.length > 0 ? out : undefined;
}

function readAssistantBlocks(raw: unknown): readonly AssistantBlock[] | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const content = (raw as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	const out: AssistantBlock[] = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object') {
			continue;
		}
		const b = block as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; input?: unknown };
		if (typeof b.type !== 'string') {
			continue;
		}
		out.push({
			type: b.type,
			text: typeof b.text === 'string' ? b.text : undefined,
			thinking: typeof b.thinking === 'string' ? b.thinking : undefined,
			id: typeof b.id === 'string' ? b.id : undefined,
			name: typeof b.name === 'string' ? b.name : undefined,
			input: b.input,
		});
	}
	return out;
}

function readSystemSubtype(raw: unknown): string | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const subtype = (raw as { subtype?: unknown }).subtype;
	return typeof subtype === 'string' ? subtype : undefined;
}

function readSystemText(raw: unknown): string | undefined {
	if (raw === null || typeof raw !== 'object') {
		return undefined;
	}
	const r = raw as { text?: unknown; message?: unknown };
	if (typeof r.text === 'string') {
		return r.text;
	}
	if (typeof r.message === 'string') {
		return r.message;
	}
	return undefined;
}

/**
 * Mirror of the live mapper's helper — kept inline so the two mappers
 * don't yet need a shared module. If a third consumer appears, factor
 * to `claudeToolResultContent.ts`.
 */
function extractToolResultContent(content: unknown): { type: ToolResultContentType.Text; text: string }[] | undefined {
	if (typeof content === 'string') {
		return content.length > 0 ? [{ type: ToolResultContentType.Text, text: content }] : undefined;
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const out: { type: ToolResultContentType.Text; text: string }[] = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object') {
			continue;
		}
		const b = block as { type?: unknown; text?: unknown };
		if (b.type === 'text' && typeof b.text === 'string') {
			out.push({ type: ToolResultContentType.Text, text: b.text });
		}
	}
	return out.length > 0 ? out : undefined;
}

function safeStringify(v: unknown): string | undefined {
	try {
		return JSON.stringify(v);
	} catch {
		return undefined;
	}
}

/**
 * True when the message content is a CLI slash-command echo (e.g.
 * `<command-name>/model</command-name>...`) that the subprocess writes
 * to the transcript for restore fidelity but is not a user-authored prompt.
 * Checks the first text fragment only; mixed messages where the first
 * content block is a real prompt are NOT filtered.
 */
function isCliEchoContent(content: string | ReadonlyArray<UserTextBlock | UserImageBlock | UserToolResultBlock>): boolean {
	if (typeof content === 'string') {
		return CLI_ECHO_MARKER_PATTERN.test(content);
	}
	const firstText = content.find((b): b is UserTextBlock => b.type === 'text');
	return firstText !== undefined && CLI_ECHO_MARKER_PATTERN.test(firstText.text);
}

// #endregion
