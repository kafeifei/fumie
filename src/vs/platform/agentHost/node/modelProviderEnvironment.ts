/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Model-provider configuration belongs to the renderer provider catalog and
 * secret storage. Environment variables are never a provider configuration
 * source for Agent Host or a harness launched by it.
 *
 * Keep the rule centralized: entry points scrub the live Agent Host process,
 * while subprocess builders use the copy helper as defence in depth. Fumie's
 * short-lived loopback credentials are added only after this scrub.
 */

const MODEL_PROVIDER_ENV_EXACT = new Set([
	'CLAUDE_CODE_OAUTH_TOKEN',
	'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
	'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_FOUNDRY',
	'CLAUDE_CODE_USE_VERTEX',
	'GOOGLE_API_KEY',
	'GOOGLE_APPLICATION_CREDENTIALS',
	'HF_TOKEN',
	'HUGGINGFACEHUB_API_TOKEN',
	'OLLAMA_HOST',
	'VSCODE_BYOK_API_KEY',
]);

const MODEL_PROVIDER_ENV_PREFIXES = [
	'ANTHROPIC_',
	'OPENAI_',
	'AZURE_OPENAI_',
	'AZURE_AI_',
	'BEDROCK_',
	'COHERE_',
	'DEEPSEEK_',
	'GEMINI_',
	'GOOGLE_GENERATIVE_AI_',
	'GOOGLE_GENAI_',
	'GROQ_',
	'KIMI_',
	'LITELLM_',
	'MISTRAL_',
	'MOONSHOT_',
	'OPENROUTER_',
	'PERPLEXITY_',
	'TOGETHER_',
	'VERTEXAI_',
	'VERTEX_AI_',
	'XAI_',
] as const;

export function isModelProviderEnvironmentVariable(key: string): boolean {
	const normalized = key.toUpperCase();
	return MODEL_PROVIDER_ENV_EXACT.has(normalized)
		|| MODEL_PROVIDER_ENV_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/** Delete ambient provider configuration in place. Returns names only, never values. */
export function scrubModelProviderEnvironment(environment: NodeJS.ProcessEnv): string[] {
	const removed: string[] = [];
	for (const key of Object.keys(environment)) {
		if (isModelProviderEnvironmentVariable(key)) {
			delete environment[key];
			removed.push(key);
		}
	}
	return removed;
}

/** Copy an environment while dropping every ambient model-provider setting. */
export function withoutModelProviderEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result = { ...environment };
	scrubModelProviderEnvironment(result);
	return result;
}
