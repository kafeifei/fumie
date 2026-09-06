/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpSdkServerConfigWithInstance, McpServerConfig, OnElicitation, Options, Settings } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { tmpdir } from 'os';
import { delimiter, dirname, normalize } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { rgDiskPath } from '../../../../base/node/ripgrep.js';
import { AiAgentEnvValue, AiAgentEnvVar } from '../../../chat/common/aiAgentEnv.js';
import { ClaudePermissionMode } from '../../common/claudeSessionConfigKeys.js';
import { resolveClaudeEffort } from '../../common/claudeModelConfig.js';
import { PendingRequestRegistry } from '../../common/pendingRequestRegistry.js';
import type { ModelSelection } from '../../common/state/protocol/state.js';
import { IClaudeAgentSdkService } from './claudeAgentSdkService.js';
import { ClaudeConfigDirEnvVar, ClaudeSecureStorageConfigDirEnvVar } from './claudeBackingStore.js';
import { buildClientToolMcpServer } from './clientTools/claudeClientToolMcpServer.js';
import { toClaudeSdkModelId } from './claudeModelSelection.js';
import type { IAgentHostNativeOTelConfig, IAgentHostTraceContext } from '../../common/otel/agentHostOTelService.js';
import type { ClaudeTransport } from './claudeProxyService.js';
import { SessionClientToolsDiff } from './clientTools/claudeSessionClientToolsModel.js';
import { withoutModelProviderEnvironment } from '../modelProviderEnvironment.js';
import { McpServerType } from '../../../mcp/common/mcpPlatformTypes.js';
import type { IMcpServerDefinition } from '../../../agentPlugins/common/pluginParsers.js';
import { isEqual } from '../../../../base/common/resources.js';
import { resolveMcpServerWorkingDirectory } from '../shared/mcpServerWorkingDirectory.js';

type ClaudeSdkDeniedMcpServerSpec = NonNullable<Settings['deniedMcpServers']>[number];

/** The Claude SDK validator accepts exactly one matching strategy per deny entry. */
export type ClaudeDeniedMcpServerSpec =
	| { readonly serverName: string; readonly serverCommand?: never; readonly serverUrl?: never }
	| { readonly serverName?: never; readonly serverCommand: NonNullable<ClaudeSdkDeniedMcpServerSpec['serverCommand']>; readonly serverUrl?: never }
	| { readonly serverName?: never; readonly serverCommand?: never; readonly serverUrl: string };

/**
 * Inputs to {@link buildOptions} that vary per startup. Pure-data: no
 * services, no live event subscribers. The function is a deterministic
 * projection from this bag plus a {@link IClaudeProxyHandle} onto the
 * SDK's {@link Options} discriminated union.
 */
export interface IBuildOptionsInput {
	readonly sessionId: string;
	readonly workingDirectory: URI;
	/**
	 * Fumie's Claude transcript namespace. Both halves are required and are
	 * deliberately not defaulted here: `configDir` decides where the
	 * subprocess writes its JSONL, `sessionStore` decides what Fumie reads
	 * back, and setting only one would leave transcripts in the user's own
	 * `~/.claude` (the SDK's store is a mirror, not a relocation).
	 */
	readonly store: {
		readonly sessionStore: NonNullable<Options['sessionStore']>;
		readonly configDir: string;
	};
	/**
	 * Additional directories (index 1..N of the session's ordered set) the agent
	 * is granted tool access to beyond the primary {@link workingDirectory}
	 * (index 0 → `Options.cwd`). Projected onto `Options.additionalDirectories`
	 * as absolute paths. Omitted from the returned options entirely when empty so
	 * a single-root session keeps the SDK default (no additional directories).
	 */
	readonly additionalDirectories?: readonly URI[];
	readonly model: ModelSelection | undefined;
	readonly abortController: AbortController;
	readonly permissionMode: ClaudePermissionMode;
	readonly canUseTool: NonNullable<Options['canUseTool']>;
	readonly onElicitation: OnElicitation;
	readonly isResume: boolean;
	/**
	 * One-shot SDK assistant-message uuid to resume *up to and including*
	 * (the SDK's `Options.resumeSessionAt`). Only meaningful with
	 * {@link isResume}; truncates the loaded transcript to this anchor so
	 * the next turn continues from the restored point on the same session
	 * id. Omitted in the non-resume (`sessionId`) branch and on ordinary
	 * resumes. Set by `truncateChat` for the rebuild that immediately
	 * precedes the post-restore turn.
	 */
	readonly resumeSessionAt?: string;
	readonly mcpServers: Record<string, McpServerConfig> | undefined;
	/** Workspace MCP servers that must be blocked before native project discovery runs. */
	readonly deniedMcpServers?: readonly ClaudeDeniedMcpServerSpec[];
	/**
	 * SDK-prefixed tool names to auto-approve without prompting (projected
	 * onto `Options.allowedTools`). Used for the agent host's feedback server
	 * tools, which only touch the session's annotations channel and are always
	 * safe. Omitted from the returned options when empty so the SDK keeps its
	 * default.
	 */
	readonly allowedTools?: readonly string[];
	/**
	 * Local plugin directories to load at SDK startup. Projected onto
	 * `Options.plugins` as `{ type: 'local', path }`. Omitted from the
	 * returned options entirely when empty so the SDK keeps its default
	 * (no plugins). Built per-session from
	 * {@link SessionClientCustomizationsDiff.consume}.
	 */
	readonly plugins?: readonly { readonly uri: URI; readonly skipMcpDiscovery: boolean }[];
	/**
	 * Resolved SDK agent name (matches a key in `Options.agents`, or an
	 * agent loaded from `~/.claude/agents/**`). Projected onto
	 * `Options.agent` — the SDK's `--agent` flag. The plugin URI captured
	 * at startup is the only path the SDK consults, so any `changeAgent`
	 * after materialize triggers a yield-restart through the rematerializer.
	 * Omit when no custom agent is selected (SDK default behavior).
	 */
	readonly agent?: string;
	readonly telemetry?: IAgentHostNativeOTelConfig;
	readonly traceContext?: IAgentHostTraceContext;
	readonly getUserPromptAdditionalContext?: () => string | undefined;
	/**
	 * Session-constant host briefing appended to the `claude_code` system-prompt
	 * preset (`composeSessionHostContext`). Rides the SDK options rather than the
	 * per-turn {@link getUserPromptAdditionalContext} channel so it reaches the
	 * model exactly once per session and never persists into the transcript.
	 * Omitted → bare preset.
	 */
	readonly systemPromptAppend?: string;
	/**
	 * The user's global `~/.claude/CLAUDE.md`, verbatim
	 * (`ClaudeBackingStore.readGlobalClaudeMd`). Consumed **only** under the
	 * native transport, which pins `settingSources: []` below and therefore
	 * loads no instruction file from disk — the system-prompt append is the
	 * only channel those sessions have left. Ignored under `byok` / `proxy`,
	 * which already load the same file through the `user` setting source; the
	 * transport check lives here rather than at the call sites so passing it
	 * unconditionally can never double-inject.
	 */
	readonly globalClaudeMd?: string;
}

/** Tells the model where the appended global instructions came from. */
const GlobalInstructionsHeading = '# User global instructions (~/.claude/CLAUDE.md)';

/**
 * Route a Claude subprocess's config root at Fumie's own namespace instead of
 * the user's `~/.claude`. Every Fumie-spawned query needs this, not just the
 * ones that run a turn: the CLI reads *and writes* `$CLAUDE_CONFIG_DIR`'s
 * `.claude.json` (cached usage utilization, and other per-install state) even
 * for a query that only answers control requests, so leaving it unset mutates
 * a user file and can read a different account's state than Fumie's own.
 *
 * Moving the config dir must not move the credential store with it: see
 * {@link ClaudeSecureStorageConfigDirEnvVar}.
 */
function applyClaudeConfigDirEnv(env: Record<string, string | undefined>, configDir: string): void {
	env[ClaudeConfigDirEnvVar] = configDir;
	env[ClaudeSecureStorageConfigDirEnvVar] = '';
}

/**
 * Build the SDK {@link Options} bag for a Claude session startup.
 * Deterministic over its declared inputs plus three ambient reads:
 *   1. `process.env.PATH` (composed into `Options.settings.env.PATH`
 *      so ripgrep wins over any system install),
 *   2. `process.env` keys via {@link buildSubprocessEnv} (used to
 *      strip `VSCODE_*` / `ELECTRON_*` / `NODE_OPTIONS` and ambient
 *      model-provider configuration from the spawn env),
 *   3. the memoized `rgDiskPath()` lookup.
 * The returned options carry the caller-supplied `abortController` so a
 * racing dispose unwinds `sdk.startup()` cleanly.
 *
 * Used by both the initial materialize and the yield-restart rematerialize
 * — both call sites pass a freshly-built `mcpServers` snapshot consumed
 * from the session's {@link SessionClientToolsDiff}.
 */
export async function buildOptions(
	input: IBuildOptionsInput,
	transport: ClaudeTransport,
	logStderr: (data: string) => void,
): Promise<Options> {
	// Native keeps the user's non-provider runtime environment (PATH, HOME, shell
	// tools); both routed transports supply every credential themselves and take
	// the sparse env. Provider variables are scrubbed in every mode.
	const subprocessEnv = buildSubprocessEnv(transport.kind !== 'native');
	const telemetryEnv = buildClaudeTelemetryEnv(input.telemetry, input.traceContext);
	Object.assign(subprocessEnv, telemetryEnv);
	// Fumie's sessions never land in the user's own Claude store. The SDK
	// session store below is a mirror — the subprocess still writes JSONL under
	// whatever `$CLAUDE_CONFIG_DIR` it sees — so the root has to move here too.
	applyClaudeConfigDirEnv(subprocessEnv, input.store.configDir);
	if (transport.kind === 'byok') {
		// Pin the BYOK loopback proxy as the session's *only* credential: the CLI
		// otherwise prefers its own stored login (macOS Keychain
		// `Claude Code-credentials` from `claude /login`, or
		// `CLAUDE_CODE_OAUTH_TOKEN`) over an inherited `ANTHROPIC_API_KEY` and
		// sends that OAuth token upstream, which the proxy rejects (its nonce is
		// what authenticates) — observed against a gateway even with
		// `ANTHROPIC_AUTH_TOKEN` set. `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`
		// (cc >= 2.1.198) is the flag that stops it: the CLI then reads *no*
		// local credential (Keychain, `apiKeyHelper`, `/login` key) and the host
		// owns the provider. It also strips the provider variables
		// (`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`)
		// from *settings-sourced* env, so the endpoint and token must be handed
		// in through the spawn env here — putting them in `settings.env` below
		// would leave the CLI with no credential at all ("Not logged in").
		subprocessEnv['ANTHROPIC_BASE_URL'] = transport.baseUrl;
		subprocessEnv['ANTHROPIC_AUTH_TOKEN'] = `${transport.nonce}.${input.sessionId}`;
		subprocessEnv['CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST'] = '1';
		subprocessEnv['ANTHROPIC_API_KEY'] = undefined;
		subprocessEnv['CLAUDE_CODE_OAUTH_TOKEN'] = undefined;
	}
	const resolvedRgDiskPath = await rgDiskPath();
	const settingsEnv: Record<string, string> = {
		...telemetryEnv,
		// Proxied (Copilot-routed) mode points the SDK at the local proxy on a
		// per-session bearer. The other two never set provider variables here:
		// BYOK carries them on the spawn env above (the host-managed-provider flag
		// strips settings-sourced ones), while native relies only on the SDK-owned
		// first-party login (for example the macOS Keychain entry).
		...(transport.kind === 'proxy'
			? {
				ANTHROPIC_BASE_URL: transport.handle.baseUrl,
				ANTHROPIC_AUTH_TOKEN: `${transport.handle.nonce}.${input.sessionId}`,
			}
			: {}),
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		USE_BUILTIN_RIPGREP: '0',
		// Attribute the CLI's tool subprocesses (`gh`, …) to VS Code.
		// `settings.env` is what the CLI layers onto the commands it runs, so it
		// needs the marker in addition to the spawn env below. Note the CLI
		// re-stamps `AI_AGENT` as `claude-code_<version>_agent` for its own Bash
		// tool, so commands from that tool are not attributed to VS Code.
		[AiAgentEnvVar]: AiAgentEnvValue,
		PATH: `${dirname(resolvedRgDiskPath)}${delimiter}${process.env.PATH ?? ''}`,
	};

	// The host briefing first, then the user's own global instructions — see
	// {@link IBuildOptionsInput.globalClaudeMd} for why only native gets the
	// second half.
	const systemPromptAppend = [
		input.systemPromptAppend,
		transport.kind === 'native' && input.globalClaudeMd
			? `${GlobalInstructionsHeading}\n${input.globalClaudeMd}`
			: undefined,
	].filter((part): part is string => part !== undefined && part.length > 0).join('\n\n');

	return {
		cwd: input.workingDirectory.fsPath,
		...(input.additionalDirectories && input.additionalDirectories.length > 0
			? { additionalDirectories: input.additionalDirectories.map(d => d.fsPath) }
			: {}),
		executable: process.execPath as 'node',
		env: subprocessEnv,
		// Fumie's authoritative copy. Read back per call, so no SDK read has to
		// flip a process-level `$CLAUDE_CONFIG_DIR` and race a concurrent one.
		sessionStore: input.store.sessionStore,
		// Flush transcript entries to the store as they are produced instead of
		// batching them to the end of the turn (the SDK default). Fumie rebuilds
		// a session by tearing the subprocess down and resuming a NEW one out of
		// this store, so anything the dying process has not flushed yet is
		// context the resumed session never sees — a turn that answers nothing,
		// or a session that has forgotten the conversation. `ClaudeSdkPipeline`
		// closes that window by awaiting the old subprocess's exit before it
		// materializes the replacement; eager flushing is the second line of
		// defence, and it is the only one that covers a host or subprocess that
		// dies without getting to run its shutdown at all.
		sessionStoreFlush: 'eager',
		abortController: input.abortController,
		allowDangerouslySkipPermissions: true,
		canUseTool: input.canUseTool,
		onElicitation: input.onElicitation,
		disallowedTools: ['WebSearch'],
		includePartialMessages: true,
		forwardSubagentText: true,
		// `enableFileCheckpointing` is deliberately absent: the SDK rejects it
		// outright alongside `sessionStore` ("backup blobs are not mirrored, so
		// rewindFiles() fails after a store-backed resume"), and every Fumie
		// session now carries a store, so setting it fails startup for all of
		// them. Nothing is lost: Fumie never calls `rewindFiles`, and file-edit
		// before/after content comes from {@link ClaudeFileEditObserver}
		// snapshotting the disk off the message stream, not from SDK
		// checkpoints. Restore it only if the SDK lifts the restriction AND a
		// caller actually needs `rewindFiles`.
		model: toClaudeSdkModelId(input.model),
		effort: resolveClaudeEffort(input.model),
		permissionMode: input.permissionMode,
		...(input.isResume
			? { resume: input.sessionId, ...(input.resumeSessionAt ? { resumeSessionAt: input.resumeSessionAt } : {}) }
			: { sessionId: input.sessionId }),
		...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
		...(input.allowedTools && input.allowedTools.length > 0 ? { allowedTools: [...input.allowedTools] } : {}),
		...(input.plugins && input.plugins.length > 0
			? { plugins: input.plugins.map(plugin => ({ type: 'local' as const, path: plugin.uri.fsPath, skipMcpDiscovery: plugin.skipMcpDiscovery })) }
			: {}),
		...(input.agent ? { agent: input.agent } : {}),
		// Official native Claude uses only its first-party login. User/project
		// settings may contain provider env and cannot participate in Fumie model
		// routing. Routed modes keep non-provider settings; BYOK additionally
		// enables the SDK's host-managed-provider isolation flag above.
		settingSources: transport.kind === 'native' ? [] : ['user', 'project', 'local'],
		settings: {
			env: settingsEnv,
			...(input.deniedMcpServers?.length
				? { deniedMcpServers: [...input.deniedMcpServers] }
				: {}),
		},
		systemPrompt: {
			type: 'preset',
			preset: 'claude_code',
			...(systemPromptAppend ? { append: systemPromptAppend } : {}),
		},
		...(input.getUserPromptAdditionalContext ? {
			hooks: {
				UserPromptSubmit: [{
					hooks: [async () => ({
						hookSpecificOutput: {
							hookEventName: 'UserPromptSubmit' as const,
							additionalContext: input.getUserPromptAdditionalContext?.(),
						},
					})],
				}],
			},
		} : {}),
		stderr: logStderr,
	};
}

/**
 * Consume the diff (clears its dirty bit) and build the in-process MCP
 * server config from the resulting tool snapshot. Resolves to
 * `undefined` when the snapshot is empty so `Options.mcpServers` is
 * omitted entirely and the SDK keeps its default.
 *
 * On builder throw the caller is responsible for re-marking the diff
 * dirty (the diff has already been consumed). See
 * {@link SessionClientToolsDiff.markDirty}.
 */
export async function buildClientMcpServers(
	toolDiff: SessionClientToolsDiff,
	registry: PendingRequestRegistry<CallToolResult>,
	sdkService: IClaudeAgentSdkService,
): Promise<Record<string, McpSdkServerConfigWithInstance> | undefined> {
	const tools = toolDiff.consume();
	if (tools.length === 0) {
		return undefined;
	}
	const server = await buildClientToolMcpServer(tools, id => registry.register(id), sdkService);
	return { client: server };
}

export function toClaudeMcpServers(
	definitions: readonly IMcpServerDefinition[],
	primaryCwd: URI,
): { readonly servers: Record<string, McpServerConfig>; readonly skipped: readonly string[] } {
	const servers: Record<string, McpServerConfig> = {};
	const skipped: string[] = [];
	for (const definition of definitions) {
		const config = definition.configuration;
		if (config.type === McpServerType.REMOTE) {
			servers[definition.name] = {
				type: config.transport === 'sse' ? 'sse' : 'http',
				url: config.url,
				...(config.headers ? { headers: { ...config.headers } } : {}),
			};
			continue;
		}

		const effectiveCwd = resolveMcpServerWorkingDirectory(config.cwd, definition.defaultCwd ?? primaryCwd);
		const hasRepresentableCwd = effectiveCwd !== undefined && isEqual(URI.file(normalize(effectiveCwd)), URI.file(normalize(primaryCwd.fsPath)));
		if (!hasRepresentableCwd) {
			skipped.push(definition.name);
			continue;
		}
		servers[definition.name] = {
			type: 'stdio',
			command: config.command,
			...(config.args ? { args: [...config.args] } : {}),
			...(config.env ? {
				env: Object.fromEntries(Object.entries(config.env)
					.filter((entry): entry is [string, string | number] => entry[1] !== null)
					.map(([key, value]) => [key, String(value)]))
			} : {}),
		};
	}
	return { servers, skipped };
}

/**
 * Build a minimal {@link Options} bag for an ephemeral model-enumeration
 * query (Phase 19, native transport). No workspace (`cwd = os.tmpdir()`), no
 * provider environment, and no user/project/local setting sources: only the
 * SDK-owned first-party login may authorize the subscription catalog. Verified
 * not to write any session transcript because the enumeration never iterates a
 * turn. The caller (`_fetchNativeModels`) aborts the returned `abortController`
 * during teardown, alongside `query.close()`.
 *
 * `configDir` is `IClaudeBackingStore.subprocessConfigDir`, the same root a
 * session gets: the query still reads and writes `.claude.json` there (see
 * {@link applyClaudeConfigDirEnv}), and without it the enumeration would touch
 * the user's own `~/.claude`.
 *
 * Unlike {@link buildOptions}, this deliberately does NOT set
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: that flag makes the CLI skip its
 * `GET /api/oauth/usage` fetch entirely, and the usage snapshot this query
 * collects alongside the catalog (`usage_EXPERIMENTAL…`) is exactly what that
 * fetch produces. With the flag set the response still reports
 * `rate_limits_available: true` — a plan predicate, not a data-presence one —
 * but carries `rate_limits: null`, so the account panel silently loses every
 * window. Real sessions keep the flag; their rate-limit data arrives on the
 * server-pushed `rate_limit_event` stream during a turn, not from this
 * endpoint.
 */
export function buildModelEnumerationOptions(configDir: string): Options {
	const env = buildSubprocessEnv(false);
	applyClaudeConfigDirEnv(env, configDir);
	return {
		cwd: tmpdir(),
		executable: process.execPath as 'node',
		env,
		abortController: new AbortController(),
		settingSources: [],
		systemPrompt: { type: 'preset', preset: 'claude_code' },
	};
}

/**
 * Build the {@link Options.env} payload for the Claude subprocess.
 *
 * SDK >= 0.3 **replaces** the subprocess environment with `Options.env` — it is
 * NOT merged with `process.env` (sdk.d.ts:1402-1405: "this value REPLACES the
 * subprocess environment entirely … Spread `process.env` yourself"). Keys whose
 * value is `undefined` are dropped from the spawned env.
 *
 * Two modes, gated by `proxied`:
 *
 * - **Proxied (Copilot-routed), `true` (default):** a *sparse* env. Credentials
 *   reach the CLI via `settings.env` (the per-session proxy bearer), so the
 *   subprocess env stays minimal and the user's personal `ANTHROPIC_API_KEY`
 *   must not leak to the Copilot proxy (stripped). `PATH` for ripgrep is
 *   supplied through `settings.env`, not here.
 *
 * - **Native (first-party login), `false`:** inherit the non-provider portion of
 *   `process.env` so `PATH`, `HOME`, and normal tool configuration reach the
 *   subprocess, while every ambient model-provider variable is removed. Native
 *   authentication remains SDK-owned (for example its Keychain login).
 *
 * In both modes the agent host's own `NODE_OPTIONS`, `ELECTRON_*`, and
 * `VSCODE_*` variables are stripped (they break the Electron-node subprocess),
 * `ELECTRON_RUN_AS_NODE=1` is set, and `AI_AGENT` is pinned so the sparse
 * proxied env still announces the originating VS Code surface. Mirror of the
 * strip pattern in `CopilotAgent._ensureClient()`.
 *
 * Exported for unit testing as a pure function over `process.env`.
 */
export function buildClaudeTelemetryEnv(config: IAgentHostNativeOTelConfig | undefined, traceContext?: IAgentHostTraceContext): Record<string, string> {
	if (!config) {
		return {};
	}
	const env: Record<string, string> = {
		CLAUDE_CODE_ENABLE_TELEMETRY: '1',
		OTEL_SERVICE_NAME: 'claude-code',
		OTEL_RESOURCE_ATTRIBUTES: serializeResourceAttributes(config.resourceAttributes),
		CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: config.traces ? '1' : '0',
		OTEL_TRACES_EXPORTER: config.traces ? 'otlp' : 'none',
		OTEL_LOGS_EXPORTER: config.external ? 'otlp' : 'none',
		OTEL_METRICS_EXPORTER: config.external ? 'otlp' : 'none',
		OTEL_LOG_USER_PROMPTS: config.captureContent ? '1' : '0',
		OTEL_LOG_ASSISTANT_RESPONSES: config.captureContent ? '1' : '0',
		OTEL_LOG_TOOL_DETAILS: config.captureContent ? '1' : '0',
		OTEL_LOG_TOOL_CONTENT: config.captureContent ? '1' : '0',
	};
	if (config.traces) {
		env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = config.traces.endpoint;
		env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = config.traces.protocol;
	}
	if (config.external) {
		env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = resolveSignalEndpoint(config.external.endpoint, 'logs', config.external.protocol);
		env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = config.external.protocol;
		env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = resolveSignalEndpoint(config.external.endpoint, 'metrics', config.external.protocol);
		env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = config.external.protocol;
		if (config.external.headers && Object.keys(config.external.headers).length > 0) {
			env.OTEL_EXPORTER_OTLP_HEADERS = Object.entries(config.external.headers).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join(',');
		}
	}
	if (traceContext) {
		env.TRACEPARENT = traceContext.traceparent;
		if (traceContext.tracestate) {
			env.TRACESTATE = traceContext.tracestate;
		}
	}
	return env;
}

function serializeResourceAttributes(attributes: Readonly<Record<string, string>>): string {
	return Object.entries(attributes).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join(',');
}

function resolveSignalEndpoint(endpoint: string, signal: 'logs' | 'metrics', protocol: 'http/json' | 'http/protobuf' | 'grpc'): string {
	if (protocol === 'grpc') {
		return endpoint;
	}
	try {
		const url = new URL(endpoint);
		if (url.pathname === '' || url.pathname === '/') {
			url.pathname = `/v1/${signal}`;
		} else if (url.pathname.endsWith('/v1/traces')) {
			url.pathname = `${url.pathname.slice(0, -'/v1/traces'.length)}/v1/${signal}`;
		}
		return url.toString().replace(/\/$/, '');
	} catch {
		return endpoint;
	}
}

export function buildSubprocessEnv(proxied: boolean = true): Record<string, string | undefined> {
	// Proxy mode: a sparse env (creds arrive via settings.env), and ambient
	// provider configuration must not leak to the Copilot proxy.
	// Native mode: retain the ordinary runtime env (including PATH) but strip all
	// provider variables; first-party authentication remains owned by the SDK.
	const env: Record<string, string | undefined> = proxied
		? {
			ELECTRON_RUN_AS_NODE: '1',
			NODE_OPTIONS: undefined,
			ANTHROPIC_API_KEY: undefined,
			HOME: process.env['HOME'],
			USERPROFILE: process.env['USERPROFILE'],
			// Load rules from additional directories https://code.claude.com/docs/en/memory#load-from-additional-directories
			CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1'
		}
		: { ...withoutModelProviderEnvironment(process.env), ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined };
	// Replace semantics mean the sparse (proxied) env would otherwise drop the
	// agent host's own marker, so set it in both modes. See `AiAgentEnvVar`.
	env[AiAgentEnvVar] = AiAgentEnvValue;
	for (const key of Object.keys(process.env)) {
		if (key === 'ELECTRON_RUN_AS_NODE') { continue; }
		if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
			env[key] = undefined;
		}
	}
	return env;
}
