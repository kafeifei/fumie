/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILanguageModelChatMetadataAndIdentifier } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IProviderSessionType } from '../../../services/sessions/common/sessionsManagement.js';
import { isMixableOfficialSubscriptionModel } from './sessionModelPickerPresentation.js';

/**
 * Decode a language-model identifier into the vendor prefix (the
 * `agent-host-<provider>` pool) and the model slug the agent advertised.
 *
 * Agent-host ids are `{vendor}:{slug}`. The slug may itself be
 * `@provider={source}:{id}`, and `{id}` may be URI-encoded (`moonshotai%2Fkimi-example`).
 */
export function decodeQualifiedModelId(identifier: string): { readonly vendor: string | undefined; readonly slug: string } {
	const colon = identifier.indexOf(':');
	if (colon <= 0) {
		return { vendor: undefined, slug: decodeModelSlug(identifier) };
	}
	return { vendor: identifier.slice(0, colon), slug: decodeModelSlug(identifier.slice(colon + 1)) };
}

export function modelSlug(model: ILanguageModelChatMetadataAndIdentifier): string {
	const metaId = model.metadata.id;
	if (metaId.includes('/') || metaId.startsWith('@provider=')) {
		return decodeModelSlug(metaId);
	}
	return decodeQualifiedModelId(model.identifier).slug;
}

/**
 * The advertised session type that should serve this model in the new-session
 * composer. Family/slug wins over `targetChatSessionType` when a matching
 * harness is advertised — a LiteLLM catalog hosted on Codex still lists
 * `moonshotai/kimi-example`, which must land on Kimi rather than stay on Codex.
 *
 * Claude/Anthropic names are *not* a family override: custom gateway Claude
 * slugs stay on their catalog harness (Codex). Only models whose
 * `targetChatSessionType` already points at an advertised Claude type switch
 * to the Claude SDK harness.
 */
export function advertisedHarnessForModel(
	model: ILanguageModelChatMetadataAndIdentifier,
	types: readonly IProviderSessionType[],
): { readonly providerId: string; readonly sessionTypeId: string } | undefined {
	if (types.length === 0) {
		return undefined;
	}
	const { vendor, slug } = decodeQualifiedModelId(model.identifier);
	const familyHint = familyHarnessHint(slug, vendor, model.metadata.family);
	if (familyHint) {
		const familyMatch = matchAdvertisedHarness(types, familyHint);
		if (familyMatch) {
			return { providerId: familyMatch.providerId, sessionTypeId: familyMatch.sessionType.id };
		}
	}
	const target = model.metadata.targetChatSessionType;
	if (!target) {
		return undefined;
	}
	const targetMatch = types.find(type =>
		type.sessionType.chatSessionType === target || type.sessionType.id === target);
	return targetMatch
		? { providerId: targetMatch.providerId, sessionTypeId: targetMatch.sessionType.id }
		: undefined;
}

/**
 * After the composer switches harness, map the picked catalog model onto the
 * new harness's own list (ids differ: Codex `moonshotai/kimi-example` vs Kimi
 * `moonshot/kimi-example`).
 */
export function resolveModelOnHarness(
	pending: ILanguageModelChatMetadataAndIdentifier,
	harnessModels: readonly ILanguageModelChatMetadataAndIdentifier[],
): ILanguageModelChatMetadataAndIdentifier | undefined {
	const exact = harnessModels.find(model => model.identifier === pending.identifier);
	if (exact) {
		return exact;
	}
	const pendingSlug = modelSlug(pending);
	const bySlug = harnessModels.find(model => modelSlug(model) === pendingSlug);
	if (bySlug) {
		return bySlug;
	}
	const pendingTail = lastPathSegment(pendingSlug);
	if (pendingTail) {
		const byTail = harnessModels.filter(model => lastPathSegment(modelSlug(model)) === pendingTail);
		if (byTail.length === 1) {
			return byTail[0];
		}
	}
	return harnessModels.length === 1 ? harnessModels[0] : undefined;
}

function familyHarnessHint(slug: string, vendor: string | undefined, family: string | undefined): string | undefined {
	const haystack = `${vendor ?? ''} ${family ?? ''} ${slug}`.toLowerCase();
	if (/\b(moonshotai|moonshot|kimi)\b/.test(haystack) || haystack.includes('moonshotai/') || haystack.includes('moonshot/')) {
		return 'kimi';
	}
	return undefined;
}

function matchAdvertisedHarness(types: readonly IProviderSessionType[], hint: string): IProviderSessionType | undefined {
	const normalized = hint.toLowerCase();
	return types.find(type => {
		const id = type.sessionType.id.toLowerCase();
		const chat = (type.sessionType.chatSessionType ?? '').toLowerCase();
		return id === normalized
			|| id.endsWith(`-${normalized}`)
			|| chat === normalized
			|| chat.endsWith(`-${normalized}`);
	});
}

function decodeModelSlug(value: string): string {
	const qualified = /^@provider=([^:]+):(.*)$/.exec(value);
	const slug = qualified ? qualified[2] : value;
	return decodeURIComponentSafe(slug);
}

function decodeURIComponentSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function lastPathSegment(slug: string): string | undefined {
	const slash = slug.lastIndexOf('/');
	const tail = slash >= 0 ? slug.slice(slash + 1) : slug;
	return tail || undefined;
}

export function isClaudeFamilyText(value: string | undefined): boolean {
	if (!value) {
		return false;
	}
	const haystack = value.toLowerCase();
	return /\b(claude|anthropic)\b/.test(haystack)
		|| haystack.includes('anthropic/')
		|| haystack.includes('anthropic-claude/')
		|| haystack.includes('claude-');
}

export function isClaudeHarnessId(sessionTypeId: string, chatSessionType?: string): boolean {
	const haystack = `${sessionTypeId} ${chatSessionType ?? ''}`.toLowerCase();
	return haystack.includes('claude');
}

export function isKimiHarnessId(sessionTypeId: string, chatSessionType?: string): boolean {
	const haystack = `${sessionTypeId} ${chatSessionType ?? ''}`.toLowerCase();
	return haystack.includes('kimi');
}

export function isCodexHarnessId(sessionTypeId: string, chatSessionType?: string): boolean {
	const haystack = `${sessionTypeId} ${chatSessionType ?? ''}`.toLowerCase();
	return haystack.includes('codex');
}

function modelHaystack(model: ILanguageModelChatMetadataAndIdentifier): string {
	return `${modelSlug(model)} ${model.metadata.name} ${model.metadata.family} ${model.identifier}`;
}

export function isGptFamilyText(value: string | undefined): boolean {
	if (!value) {
		return false;
	}
	const haystack = value.toLowerCase();
	return /\bgpt\b/.test(haystack) || /gpt-[0-9]/.test(haystack) || haystack.includes('gpt-image') || haystack.includes('gpt-realtime') || haystack.includes('/gpt');
}

/**
 * Resolve a selected model against the Kimi harness catalog before persisting it.
 */
export function persistableModelOnHarness(
	pending: ILanguageModelChatMetadataAndIdentifier,
	harnessModels: readonly ILanguageModelChatMetadataAndIdentifier[],
	sessionTypeId: string,
	chatSessionType?: string,
): ILanguageModelChatMetadataAndIdentifier {
	if (!isKimiHarnessId(sessionTypeId, chatSessionType)) {
		return pending;
	}
	return resolveModelOnHarness(pending, harnessModels) ?? pending;
}

/**
 * Union Copilot / ChatGPT subscription rows that already belong to this
 * harness. Does not restamp foreign vendors (send would misroute) and does
 * not pull native Anthropic SDK rows.
 */
export function mixOfficialSubscriptionModels(
	sessionTypeId: string,
	sessionModels: readonly ILanguageModelChatMetadataAndIdentifier[],
	registered: readonly ILanguageModelChatMetadataAndIdentifier[],
	chatSessionType?: string,
): readonly ILanguageModelChatMetadataAndIdentifier[] {
	const seen = new Set(sessionModels.map(model => model.identifier));
	const extras = collectOfficialSubscriptionModels(sessionTypeId, registered, seen, chatSessionType);
	return extras.length === 0 ? sessionModels : [...sessionModels, ...extras];
}

function collectOfficialSubscriptionModels(
	sessionTypeId: string,
	candidates: readonly ILanguageModelChatMetadataAndIdentifier[],
	seen: Set<string>,
	chatSessionType?: string,
): ILanguageModelChatMetadataAndIdentifier[] {
	const extras: ILanguageModelChatMetadataAndIdentifier[] = [];
	for (const model of candidates) {
		if (seen.has(model.identifier) || !isMixableOfficialSubscriptionModel(model) || !modelBelongsToHarness(model, sessionTypeId, chatSessionType) || !officialMatchesHarnessFamily(model, sessionTypeId, chatSessionType)) {
			continue;
		}
		seen.add(model.identifier);
		extras.push(model);
	}
	return extras;
}

function modelBelongsToHarness(
	model: ILanguageModelChatMetadataAndIdentifier,
	sessionTypeId: string,
	chatSessionType?: string,
): boolean {
	const vendor = harnessLanguageModelVendor(sessionTypeId, chatSessionType);
	const target = model.metadata.targetChatSessionType;
	if (target === vendor || target === sessionTypeId || (chatSessionType && target === chatSessionType)) {
		return true;
	}
	const modelVendor = (decodeQualifiedModelId(model.identifier).vendor ?? model.metadata.vendor).toLowerCase();
	return modelVendor === vendor.toLowerCase() || modelVendor === sessionTypeId.toLowerCase();
}

export function claudeLanguageModelVendor(sessionTypeId: string, chatSessionType?: string): string {
	if (chatSessionType && /claude/i.test(chatSessionType)) {
		return chatSessionType;
	}
	return `agent-host-${sessionTypeId}`;
}

function harnessLanguageModelVendor(sessionTypeId: string, chatSessionType?: string): string {
	if (isClaudeHarnessId(sessionTypeId, chatSessionType)) {
		return claudeLanguageModelVendor(sessionTypeId, chatSessionType);
	}
	if (chatSessionType && /codex|kimi/i.test(chatSessionType)) {
		return chatSessionType;
	}
	return `agent-host-${sessionTypeId}`;
}

function officialMatchesHarnessFamily(
	model: ILanguageModelChatMetadataAndIdentifier,
	sessionTypeId: string,
	chatSessionType?: string,
): boolean {
	const haystack = modelHaystack(model);
	if (isClaudeHarnessId(sessionTypeId, chatSessionType)) {
		return isClaudeFamilyText(haystack);
	}
	if (isCodexHarnessId(sessionTypeId, chatSessionType)) {
		return isGptFamilyText(haystack);
	}
	if (isKimiHarnessId(sessionTypeId, chatSessionType)) {
		return /\b(kimi|moonshot)\b/i.test(haystack);
	}
	return true;
}
