/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64 } from '../../../../base/common/buffer.js';
import { ByokLmImageMimeType, getByokLmSelectionModelId, IByokLmImagePart, IByokLmModelInfo } from '../../common/agentHostByokLm.js';

/**
 * Helpers for the upstream Copilot BYOK Responses adapter: validation, ids,
 * image decoding, SSE framing, and model-list projection.
 */

/**
 * Thrown when an inbound wire payload cannot be expressed in the bridge
 * contract (`IByokLmChatRequest`). The proxy turns it into a `400` rendered in
 * the caller's own error envelope.
 */
export class ByokWireTranslationError extends Error { }

/** Anthropic's error taxonomy, reused verbatim as the OpenAI `error.type`. */
export type ByokWireErrorType =
	| 'invalid_request_error'
	| 'authentication_error'
	| 'not_found_error'
	| 'api_error';

export function requiredString(value: string | undefined, path: string): string {
	if (!value) {
		throw new ByokWireTranslationError(`${path} is required`);
	}
	return value;
}

function isSupportedImageMimeType(mimeType: string): mimeType is ByokLmImageMimeType {
	switch (mimeType) {
		case 'image/png':
		case 'image/jpeg':
		case 'image/gif':
		case 'image/webp':
		case 'image/bmp':
			return true;
		default:
			return false;
	}
}

/**
 * Build a bridge image part from an explicit MIME type + base64 payload
 * (Anthropic `image` blocks carry the two separately). `path` names the
 * offending field on the inbound payload so the caller gets a precise 400.
 */
export function imagePartFromBase64(mimeType: string, data: string, path: string): IByokLmImagePart {
	if (!isSupportedImageMimeType(mimeType)) {
		throw new ByokWireTranslationError(`Unsupported ${path} MIME type '${mimeType}'`);
	}
	try {
		decodeBase64(data);
	} catch {
		throw new ByokWireTranslationError(`Invalid ${path}`);
	}
	return { type: 'image', mimeType, data };
}

const IMAGE_DATA_URL = /^data:(?<mimeType>image\/[^;,]+)(?:;[^,]*)?;base64,(?<data>.*)$/;

/**
 * Build a bridge image part from an inline `data:image/...;base64,...` URL
 * (OpenAI `input_image` / `image_url` parts). Remote URLs are rejected: the
 * bridge only forwards inline data.
 */
export function imagePartFromDataUrl(url: string, path: string): IByokLmImagePart {
	const match = IMAGE_DATA_URL.exec(url);
	if (!match?.groups) {
		throw new ByokWireTranslationError(`Unsupported ${path}`);
	}
	return imagePartFromBase64(match.groups.mimeType, match.groups.data, path);
}

let wireIdCounter = 0;

/** Mint a synthetic wire id (`msg_byok_…`) for a buffered bridge result. */
export function nextWireId(prefix: string): string {
	wireIdCounter = (wireIdCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `${prefix}_byok_${Date.now().toString(36)}_${wireIdCounter.toString(36)}`;
}

/** Encode a named SSE frame (`event: <name>` + `data:`), as Anthropic and OpenAI Responses use. */
export function sseEvent(eventName: string, data: unknown): string {
	return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Encode an unnamed SSE frame (`data:` only), as OpenAI Chat Completions uses. */
export function sseData(data: unknown): string {
	return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Render a vendor's BYOK models as a `GET /v1/models` page. One body serves
 * both clients — the Anthropic fields (`type`, `display_name`, `created_at`,
 * `has_more`) sit alongside the OpenAI ones (`object`, `created`, `owned_by`) —
 * because the Claude CLI and the OpenAI SDKs probe the very same path under a
 * vendor prefix, and the ids they need are identical.
 */
export function modelsListBody(models: readonly IByokLmModelInfo[], vendor: string): string {
	const data = models.filter(model => model.vendor === vendor).map(model => {
		const id = getByokLmSelectionModelId(model);
		return {
			id,
			type: 'model',
			object: 'model',
			display_name: model.name ?? id,
			created_at: '1970-01-01T00:00:00Z',
			created: 0,
			owned_by: vendor,
		};
	});
	return JSON.stringify({
		object: 'list',
		data,
		has_more: false,
		first_id: data.length ? data[0].id : null,
		last_id: data.length ? data[data.length - 1].id : null,
	});
}
