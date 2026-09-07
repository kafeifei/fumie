/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../base/common/async.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Server as ChildProcessServer } from '../../../base/parts/ipc/node/ipc.cp.js';
import { Server as UtilityProcessServer } from '../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../base/parts/sandbox/node/electronTypes.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isWindows } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { joinPath } from '../../../base/common/resources.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { mkdir } from 'fs/promises';
import * as os from 'os';
import * as inspector from 'inspector';
import { AgentHostAcpAgentEnabledEnvVar, AgentHostClaudeAgentEnabledEnvVar, AgentHostCodexAgentCodexHomeEnvVar, AgentHostCodexAgentEnabledEnvVar, AgentHostDeepSeekAgentEnabledEnvVar, AgentHostIpcChannels, AgentHostKimiAgentEnabledEnvVar, AgentHostOpencodeAgentEnabledEnvVar, AgentHostPiAgentEnabledEnvVar, IAgentHostInspectInfo, IAgentHostSocketInfo, IConnectionTrackerService } from '../common/agentService.js';
import { AgentHostAcpEnabledConfigKey, AgentHostClaudeEnabledConfigKey, AgentHostCodexEnabledConfigKey, AgentHostDeepSeekEnabledConfigKey, AgentHostKimiEnabledConfigKey, AgentHostOpencodeEnabledConfigKey, AgentHostPiEnabledConfigKey, type AgentHostProviderEnabledConfigKey } from '../common/agentHostSchema.js';
import { registerProviderWhenEnabled } from './agentProviderEnablement.js';
import { AgentModelRefreshScheduler, MODEL_REFRESH_INTERVAL_MS } from './agentModelRefreshScheduler.js';
import { AgentService } from './agentService.js';
import { AgentHostStateManager, IAgentHostStateManager } from './agentHostStateManager.js';
import { IAgentConfigurationService } from './agentConfigurationService.js';
import { IAgentHostCompletions } from './agentHostCompletions.js';
import { CopilotAgent } from './copilot/copilotAgent.js';
import { ClaudeAgent } from './claude/claudeAgent.js';
import { ClaudeSdkPackage } from './claude/claudeAgentSdkService.js';
import { scheduleOrphanedClaudeResumeDirCleanup } from './claude/claudeResumeTempCleanup.js';
import { CodexAgent, CodexSdkPackage } from './codex/codexAgent.js';
import { KimiAgent } from './kimi/kimiAgent.js';
import { KimiSdkPackage } from './kimi/kimiCodeSdkService.js';
import { DeepSeekAgent } from './deepseek/deepseekAgent.js';
import { DeepSeekSdkPackage } from './deepseek/deepseekSdkService.js';
import { PiAgent } from './pi/piAgent.js';
import { PiSdkPackage } from './pi/piSdkService.js';
import { AcpAgent } from './acp/acpAgent.js';
import { OpencodeAgent } from './opencode/opencodeAgent.js';
import { ACP_CLAUDE_AGENT_PROVIDER_ID, OPENCODE_AGENT_PROVIDER_ID } from '../common/agent.js';
import { createCodexProviderConfiguration } from './codex/codexProviderConfiguration.js';
import { ByokLmBridgeRegistry } from './byokLmBridgeRegistry.js';
import { IAgentHostProxyResolver } from './agentHostProxyResolver.js';
import { IAgentSdkDownloader, type IAgentSdkDownloadProgress, type IAgentSdkPackage } from './agentSdkDownloader.js';
import { ProtocolServerHandler } from './protocolServerHandler.js';
import { WebSocketProtocolServer } from './webSocketTransport.js';
import { MessagePortProtocolServer } from './messagePortProtocolServer.js';
import { cleanupLocalAgentHostEndpointMetadataSync, cleanupLocalAgentHostEndpointSocketSync, createLocalAgentHostEndpointMetadata, prepareLocalAgentHostEndpointMetadataDirectory, prepareLocalAgentHostEndpointSocketDirectory, publishLocalAgentHostEndpointMetadata, type ILocalAgentHostEndpointMetadata } from './localAgentHostMetadata.js';
import { AgentHostManagementService } from './agentHostManagementService.js';
import { NativeEnvironmentService } from '../../environment/node/environmentService.js';
import { parseArgs, OPTIONS } from '../../environment/node/argv.js';
import { getLogLevel, ILogService, isDevConsoleLogForwardingEnabled, registerDevConsoleLogForwarder } from '../../log/common/log.js';
import { LogService } from '../../log/common/logService.js';
import { LoggerService } from '../../log/node/loggerService.js';
import { LoggerChannel } from '../../log/common/logIpc.js';
import { OtlpEmitterLogger, OtlpLogEmitter } from '../common/otlp/otlpLogEmitter.js';
import { DefaultURITransformer } from '../../../base/common/uriIpc.js';
import product from '../../product/common/product.js';
import { IProductService } from '../../product/common/productService.js';
import { localize } from '../../../nls.js';
import { IFileService } from '../../files/common/files.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { createAgentHostRuntime, type IAgentHostRuntime } from './agentHostBootstrap.js';
import { BANG_COMMAND_PREFIX } from './agentHostBangCommand.js';
import { AgentHostClientFileSystemProvider } from '../common/agentHostClientFileSystemProvider.js';
import { AGENT_CLIENT_SCHEME } from '../common/agentClientUri.js';
import { AGENT_HOST_CLIENT_BYOK_LM_CHANNEL, createAgentHostClientByokLmConnection } from '../common/agentHostClientByokLmChannel.js';
import { AGENT_HOST_CLIENT_PROXY_CHANNEL, createAgentHostClientProxyConnection } from '../common/agentHostClientProxyChannel.js';
import { join } from '../../../base/common/path.js';
import ErrorTelemetry from '../../telemetry/node/errorTelemetry.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AgentHostLaunchKindEnvVar, readAgentHostLaunchKind, type AgentHostLaunchKind } from '../common/agentHostTelemetry.js';
import { AgentHostLegacyUserDataDirEnvVar, AgentHostFumieHomeEnvVar, applyAgentHostProductEnv } from '../common/agentHostProductEnv.js';
import { AgentHostDatabase } from './agentHostDatabase.js';
import { AgentSdkManager, resolveDefaultAgentsDir } from './fumie/agentSdkManager.js';
import { migrateLegacyFumieData } from './fumie/fumieDataMigration.js';
import { scrubModelProviderEnvironment } from './modelProviderEnvironment.js';

// Entry point for the agent host utility process.
// Sets up IPC, logging, and registers agent providers (Copilot).
// When VSCODE_AGENT_HOST_PORT or VSCODE_AGENT_HOST_SOCKET_PATH env vars
// are set, also starts a WebSocket server for external clients.

void startAgentHost().catch(err => {
	console.error(err);
	process.exit(1);
});

async function startAgentHost(): Promise<void> {
	applyAgentHostProductEnv(process.env, product);
	scrubModelProviderEnvironment(process.env);
	const codexHome = process.env[AgentHostCodexAgentCodexHomeEnvVar];
	if (codexHome) {
		await mkdir(codexHome, { recursive: true });
	}

	// Setup RPC - supports both Electron utility process and Node child process
	let server: ChildProcessServer<string> | UtilityProcessServer;
	if (isUtilityProcess(process)) {
		server = new UtilityProcessServer();
	} else {
		server = new ChildProcessServer(AgentHostIpcChannels.AgentHost);
	}

	const disposables = new DisposableStore();
	const protocolIngressDisposables = disposables.add(new DisposableStore());
	const protocolHandlers: ProtocolServerHandler[] = [];
	const errorTelemetry = disposables.add(new MutableDisposable<ErrorTelemetry>());

	// Services
	const productService: IProductService = { _serviceBrand: undefined, ...product };
	const environmentService = new NativeEnvironmentService(parseArgs(process.argv, OPTIONS), productService);
	const loggerService = new LoggerService(getLogLevel(environmentService), environmentService.logsHome);
	// Non-protocol management and logging IPC remain separate from the AHP data plane.
	server.registerChannel(AgentHostIpcChannels.Logger, new LoggerChannel(loggerService, () => DefaultURITransformer));
	const logger = loggerService.createLogger('agenthost', { name: localize('agentHost', "Agent Host") });
	// OTLP log fan-out: any consumer that subscribes to the host's
	// `ahp-otlp://logs/{level}` channel will receive every log record this
	// `ILogService` produces, in addition to the regular file logger. The
	// emitter is created here so it can be shared by every protocol
	// handler instantiated below.
	const otlpLogEmitter = disposables.add(new OtlpLogEmitter());
	const otlpLogger = disposables.add(new OtlpEmitterLogger(otlpLogEmitter));
	const logService = new LogService(logger, [otlpLogger]);
	if (!environmentService.isBuilt && isDevConsoleLogForwardingEnabled) {
		disposables.add(registerDevConsoleLogForwarder(logService));
	}
	logService.info('Agent Host process started successfully');

	// Fumie keeps durable agent state outside the editor profile. Existing
	// legacy data is migrated before any database or provider opens it.
	const fumieHome = process.env[AgentHostFumieHomeEnvVar] ? URI.file(process.env[AgentHostFumieHomeEnvVar]) : undefined;
	await migrateLegacyFumieData(process.env[AgentHostLegacyUserDataDirEnvVar], fumieHome?.fsPath, logService);
	const sessionsHome = fumieHome ? joinPath(fumieHome, 'sessions') : undefined;
	const rootConfigResource = sessionsHome ? joinPath(sessionsHome, 'agent-host-config.json') : undefined;
	const storageResource = sessionsHome ? joinPath(sessionsHome, 'agent-host-storage.json') : undefined;
	const orchestratorDatabase = sessionsHome ? new AgentHostDatabase(joinPath(sessionsHome, 'catalog.db').fsPath) : undefined;

	// Create the real service implementation that lives in this process
	let runtime!: IAgentHostRuntime;
	let agentService: AgentService;
	let instantiationService!: IInstantiationService;
	let fileService!: IFileService;
	let stateManager!: AgentHostStateManager;
	let completionTriggerCharacters!: readonly string[];
	// Hoisted out of the `try` below so the protocol handlers (constructed
	// after the block) can forward agent-SDK download progress to clients.
	let sdkDownloadProgress: Event<IAgentSdkDownloadProgress> | undefined;
	let byokLmBridgeRegistry: ByokLmBridgeRegistry;
	let proxyResolver!: IAgentHostProxyResolver;
	const hostLaunchKind = readAgentHostLaunchKind(process.env[AgentHostLaunchKindEnvVar]);
	try {
		byokLmBridgeRegistry = new ByokLmBridgeRegistry();
		runtime = await createAgentHostRuntime({
			environmentService,
			productService,
			logService,
			loggerService,
			transientProxyConfiguration: true,
			hostLaunchKind,
			providerConfigurations: [createCodexProviderConfiguration(environmentService.userHome)],
			byok: { kind: 'renderer', bridgeRegistry: byokLmBridgeRegistry },
			...(sessionsHome ? {
				sessionDataHome: sessionsHome,
				rootConfigResource: rootConfigResource!,
				storageResource: storageResource!,
				orchestratorDatabase: orchestratorDatabase!,
				pluginBasePath: joinPath(fumieHome!, 'plugins', 'cache'),
			} : {}),
		});
		disposables.add(runtime);
		agentService = runtime.agentService;
		instantiationService = runtime.instantiationService;
		const runtimeServices = instantiationService.invokeFunction(accessor => ({
			configurationService: accessor.get(IAgentConfigurationService),
			fileService: accessor.get(IFileService),
			proxyResolver: accessor.get(IAgentHostProxyResolver),
			telemetryService: accessor.get(ITelemetryService),
			agentSdkDownloader: accessor.get(IAgentSdkDownloader),
			stateManager: accessor.get(IAgentHostStateManager),
			completions: accessor.get(IAgentHostCompletions),
		}));
		const agentConfigurationService = runtimeServices.configurationService;
		fileService = runtimeServices.fileService;
		proxyResolver = runtimeServices.proxyResolver;
		stateManager = runtimeServices.stateManager;
		completionTriggerCharacters = runtimeServices.completions.triggerCharacters;
		errorTelemetry.value = new ErrorTelemetry(runtimeServices.telemetryService);
		const agentSdkDownloader = runtimeServices.agentSdkDownloader;
		sdkDownloadProgress = runtime.sdkDownloadProgress;
		if (!product.sessionsAllowedAgentHostProviders || product.sessionsAllowedAgentHostProviders.includes('copilotcli')) {
			agentService.registerProvider(instantiationService.createInstance(CopilotAgent));
		}
		// Claude and Codex providers are gated on two things:
		//  1. The user-facing enable toggle (`chat.agentHost.<x>Agent.enabled`,
		//     forwarded as an env var by the starters). Built-in agents default on.
		//  2. The SDK being reachable. Claude is a devDependency of this repo
		//     so the bare-import path in `ClaudeAgentSdkService._loadSdk`
		//     always succeeds in dev; in built products the SDK ships via
		//     `product.agentSdks.claude` and the downloader handles it. Codex
		//     is likewise a devDependency, so `CodexAgent._resolveSdkRoot`
		//     resolves it from `node_modules` in dev; built products use the
		//     env-var override or a `product.agentSdks.codex` entry.
		// If either gate fails, the provider is not registered and never appears
		// in the agent picker (matches the pre-CDN UX exactly).
		//
		// Registration is one-way (register-on-enable) for every provider below:
		// the env-var toggle carries the value this process was spawned with and
		// the renderer-forwarded root config carries every later change, so
		// turning an Agent on takes effect immediately while turning it off takes
		// effect on the next agent host restart. See
		// {@link registerProviderWhenEnabled}.
		const registerWhenEnabled = (
			enabledEnvVar: string,
			rootConfigKey: AgentHostProviderEnabledConfigKey,
			register: () => void,
			enabledByDefault?: boolean,
		): void => {
			disposables.add(registerProviderWhenEnabled(agentConfigurationService, {
				enabledEnvVar,
				rootConfigKey,
				enabledByDefault,
				onRegistrationError: error => logService.error(`[AgentHost] Failed to register provider enabled by ${rootConfigKey}`, error),
			}, register));
		};
		if ((!product.sessionsAllowedAgentHostProviders || product.sessionsAllowedAgentHostProviders.includes('claude')) && (!environmentService.isBuilt || agentSdkDownloader.isAvailable(ClaudeSdkPackage))) {
			registerWhenEnabled(AgentHostClaudeAgentEnabledEnvVar, AgentHostClaudeEnabledConfigKey, () => {
				agentService.registerProvider(instantiationService.createInstance(ClaudeAgent));
				// The SDK deletes the `claude-resume-<uuid>` scratch dir it
				// materializes for a resume only when that query shuts down, so
				// every host crash / force-quit / reload strands one — transcript
				// copy and credentials file included — and they accumulate one per
				// resume. Nothing else is positioned to notice, so sweep the
				// unreachable ones from here, the moment we know this process is
				// one that can produce them. This is the desktop app's host — the
				// one that does most of the resuming, and the one users force-quit
				// — so it is the entry point that matters most for the leak.
				scheduleOrphanedClaudeResumeDirCleanup(logService);
			}, true);
		}
		if ((!product.sessionsAllowedAgentHostProviders || product.sessionsAllowedAgentHostProviders.includes('codex')) && (!environmentService.isBuilt || agentSdkDownloader.isAvailable(CodexSdkPackage))) {
			registerWhenEnabled(AgentHostCodexAgentEnabledEnvVar, AgentHostCodexEnabledConfigKey, () => {
				agentService.registerProvider(instantiationService.createInstance(CodexAgent));
			});
		}

		const registerByokBackedProvider = (createProvider: () => KimiAgent | DeepSeekAgent | PiAgent): void => {
			void byokLmBridgeRegistry.whenInitialSnapshot.then(() => {
				if (!disposables.isDisposed) {
					agentService.registerProvider(createProvider());
				}
			}).catch(error => logService.error('[AgentHost] Failed waiting for the initial BYOK model snapshot', error));
		};
		const agentSdkManager = disposables.add(new AgentSdkManager({
			agentsDir: resolveDefaultAgentsDir(),
			hasProductSdk: id => !!product.agentSdks?.[id],
		}, agentConfigurationService, logService));
		// The BYOK-backed providers reach registration through the SDK manager:
		// enabling hands the package to `manage`, which adopts or installs it and
		// only then runs the register callback. `manage` throws on a second call
		// for the same package, which the one-shot register-on-enable gate
		// guarantees never happens — so flipping the toggle cannot start a second
		// download either.
		const manageByokSdk = (pkg: IAgentSdkPackage, enabledEnvVar: string, rootConfigKey: AgentHostProviderEnabledConfigKey, create: () => KimiAgent | DeepSeekAgent | PiAgent): void => {
			if (product.sessionsAllowedAgentHostProviders && !product.sessionsAllowedAgentHostProviders.includes(pkg.id)) {
				return;
			}
			registerWhenEnabled(enabledEnvVar, rootConfigKey, () => {
				agentSdkManager.manage(pkg, () => registerByokBackedProvider(create));
			});
		};
		manageByokSdk(KimiSdkPackage, AgentHostKimiAgentEnabledEnvVar, AgentHostKimiEnabledConfigKey, () => instantiationService.createInstance(KimiAgent));
		manageByokSdk(DeepSeekSdkPackage, AgentHostDeepSeekAgentEnabledEnvVar, AgentHostDeepSeekEnabledConfigKey, () => instantiationService.createInstance(DeepSeekAgent));
		manageByokSdk(PiSdkPackage, AgentHostPiAgentEnabledEnvVar, AgentHostPiEnabledConfigKey, () => instantiationService.createInstance(PiAgent));

		// The ACP providers have no SDK to download and no model catalog to wait
		// for: the protocol client ships with the product and the agents are
		// user-installed command-line tools. So they register directly, gated only
		// on the enable toggle and the product allowlist. An agent
		// that turns out not to be installed reports that on first send, which is
		// the only moment the process would have been started anyway.
		//
		// One registration per catalog agent: a picker row is keyed on a provider
		// id, so this is what makes the list name each agent instead of the
		// protocol they share. The per-provider allowlist check lives in the agent
		// itself, which already consults it to decide what it may run.
		registerWhenEnabled(AgentHostAcpAgentEnabledEnvVar, AgentHostAcpEnabledConfigKey, () => {
			for (const provider of [ACP_CLAUDE_AGENT_PROVIDER_ID]) {
				if (!product.sessionsAllowedAgentHostProviders || product.sessionsAllowedAgentHostProviders.includes(provider)) {
					agentService.registerProvider(instantiationService.createInstance(AcpAgent, provider));
				}
			}
		});

		// opencode registers on the same terms as the ACP providers: nothing to
		// download and no model catalog to wait for, because the binary is one the
		// user installed and the models are opencode's own. An install that turns
		// out to be missing reports that on the first send.
		if (!product.sessionsAllowedAgentHostProviders || product.sessionsAllowedAgentHostProviders.includes(OPENCODE_AGENT_PROVIDER_ID)) {
			registerWhenEnabled(AgentHostOpencodeAgentEnabledEnvVar, AgentHostOpencodeEnabledConfigKey, () => {
				agentService.registerProvider(instantiationService.createInstance(OpencodeAgent));
			});
		}
	} catch (err) {
		logService.error('Failed to create AgentService', err);
		disposables.dispose();
		throw err;
	}

	// Keep every provider's model catalog fresh. Provider-owned refresh
	// triggers (authentication, transport flips, client restarts) are all
	// edge-based, so this periodic tick is the only thing that notices a model
	// added service-side while the host stays up. Owned here, at process
	// lifetime, rather than inside `AgentHostService`: a service that arms a
	// recurring timer in its constructor is one that no faked-timer unit test
	// can ever drain.
	disposables.add(instantiationService.createInstance(AgentModelRefreshScheduler, runtime.agents, runtime.onDidStartTurn, MODEL_REFRESH_INTERVAL_MS));

	// Surface agent-SDK download progress to clients as generic `progress`
	// notifications. The downloader fires process-global frames keyed by package
	// id; the agent service surfaces frames requested by a waiting session or
	// another user-initiated flow, routed through the state manager so both the
	// local (IPC) and any external (WebSocket) renderer receive them via the same
	// path as session updates.
	if (sdkDownloadProgress) {
		disposables.add(sdkDownloadProgress(p => agentService.emitDownloadProgress(
			p.packageId,
			p.displayName,
			p.receivedBytes,
			p.totalBytes,
			p.phase === 'completed' || p.phase === 'failed',
			p.explicitlyRequested,
		)));
	}

	// Retain the imperative bridge only for the child-process server consumers.
	// The utility-process MessagePort exposes Protocol and Management instead.
	if (!(server instanceof UtilityProcessServer)) {
		const agentChannel = ProxyChannel.fromService(agentService, disposables);
		server.registerChannel(AgentHostIpcChannels.AgentHost, agentChannel);
	}

	// Single shared `vscode-agent-client` filesystem provider. Per-client
	// authorities are added by protocol handlers or the non-protocol reverse
	// bridges below.
	const clientFileSystemProvider = disposables.add(new AgentHostClientFileSystemProvider());
	disposables.add(fileService.registerProvider(AGENT_CLIENT_SCHEME, clientFileSystemProvider));

	if (server instanceof UtilityProcessServer) {
		const localDataPlaneDisposables = protocolIngressDisposables.add(new DisposableStore());
		const messagePortProtocolServer = localDataPlaneDisposables.add(new MessagePortProtocolServer<string>());
		// Shared config for the local data-plane protocol handlers (renderer
		// MessagePort + the external endpoint, which each get their own handler).
		const localProtocolHandlerConfig = {
			hostLaunchKind,
			defaultDirectory: URI.file(os.homedir()).toString(),
			completionTriggerCharacters,
			terminalCommandPrefix: BANG_COMMAND_PREFIX,
			otlpLogEmitter,
			allowExtensionMethods: false,
		};
		try {
			// Handler for the renderer's MessagePort data plane.
			const messagePortProtocolHandler = localDataPlaneDisposables.add(instantiationService.createInstance(
				ProtocolServerHandler,
				agentService,
				stateManager,
				messagePortProtocolServer,
				{
					...localProtocolHandlerConfig,
					beforeHandshake: clientId => byokLmBridgeRegistry.waitForInitialSnapshot(clientId),
				},
				clientFileSystemProvider,
			));
			protocolHandlers.push(messagePortProtocolHandler);
			// Non-protocol reverse bridges remain on their existing IPC channels.
			// The renderer's MessagePortClient ctx is its clientId.
			const authorityRegistrations = new Map<unknown, IDisposable>();
			const registerConnection = (connection: (typeof server.connections)[number]) => {
				if (authorityRegistrations.has(connection)) {
					return;
				}
				const clientId = connection.ctx;
				if (typeof clientId !== 'string' || !clientId || clientId === 'agentHost') {
					return;
				}
				const connectionStore = new DisposableStore();
				try {
					const getChannel = (channelName: string) => server.getChannel(channelName, c => c.ctx === clientId);
					const proxyConnection = createAgentHostClientProxyConnection(getChannel(AGENT_HOST_CLIENT_PROXY_CHANNEL));
					connectionStore.add(proxyResolver.register(clientId, proxyConnection));
					const byokLmConnection = createAgentHostClientByokLmConnection(getChannel(AGENT_HOST_CLIENT_BYOK_LM_CHANNEL));
					connectionStore.add(byokLmBridgeRegistry.register(clientId, byokLmConnection));
					authorityRegistrations.set(connection, connectionStore);
				} catch (error) {
					connectionStore.dispose();
					logService.warn(`[AgentHost] Failed to register renderer reverse channels for ${clientId}: ${error instanceof Error ? error.message : String(error)}`);
				}
			};
			localDataPlaneDisposables.add(server.onDidAddConnection(registerConnection));
			localDataPlaneDisposables.add(server.onDidRemoveConnection(connection => {
				if (typeof connection.ctx === 'string') {
					messagePortProtocolServer.closeClient(connection.ctx);
				}
				const reg = authorityRegistrations.get(connection);
				if (reg) {
					reg.dispose();
					authorityRegistrations.delete(connection);
				}
			}));
			localDataPlaneDisposables.add(toDisposable(() => {
				for (const registration of authorityRegistrations.values()) {
					registration.dispose();
				}
				authorityRegistrations.clear();
			}));
			for (const connection of server.connections) {
				registerConnection(connection);
			}

			// Register the renderer's protocol channel BEFORE starting the external
			// endpoint: the renderer connects over this channel, and the IPC
			// ChannelServer drops calls to a not-yet-registered channel after its
			// unknown-channel timeout (~1s), so the endpoint's socket startup must
			// not sit on this path.
			server.registerChannel(AgentHostIpcChannels.Protocol, messagePortProtocolServer);

			// The external local endpoint (out-of-process local clients such as the
			// CLI) is not on the renderer's path; start it after registration and
			// give it its own handler.
			// The endpoint registry is runtime discovery state, not durable Fumie
			// data: the tunnel CLI is launched by the upstream coordinator with
			// `--user-data-dir <Electron userDataPath>` and looks for the registry
			// there, so publishing it under FUMIE_HOME breaks tunnel delegation.
			const endpointRegistryRoot = environmentService.userDataPath;
			const localEndpoint = await startLocalAgentHostEndpoint(
				endpointRegistryRoot,
				logService,
				instantiationService,
				environmentService.logsHome,
			);
			if (localEndpoint) {
				const endpointMetadata = localEndpoint.metadata;
				// Wire the endpoint's handler (subscribing to its connections) BEFORE
				// publishing the metadata that advertises it, so a client can't connect
				// in the gap and be missed.
				localDataPlaneDisposables.add(localEndpoint.server);
				const localEndpointProtocolHandler = localDataPlaneDisposables.add(instantiationService.createInstance(
					ProtocolServerHandler,
					agentService,
					stateManager,
					localEndpoint.server,
					localProtocolHandlerConfig,
					clientFileSystemProvider,
				));
				protocolHandlers.push(localEndpointProtocolHandler);
				try {
					await publishLocalAgentHostEndpointMetadata(endpointRegistryRoot, endpointMetadata, logService);
					localDataPlaneDisposables.add(toDisposable(() => {
						cleanupLocalAgentHostEndpoint(endpointRegistryRoot, endpointMetadata, logService);
					}));
				} catch (error) {
					logService.error('[AgentHost] Failed to publish local protocol endpoint; continuing with MessagePort only', error);
					localEndpoint.server.dispose();
					cleanupLocalAgentHostEndpoint(endpointRegistryRoot, endpointMetadata, logService);
				}
			}
		} catch (error) {
			localDataPlaneDisposables.dispose();
			throw error;
		}
	}

	// Expose dynamic bridge client count to the parent process via a non-protocol
	// management IPC channel.
	const connectionCountEmitter = disposables.add(new Emitter<number>());
	let dynamicSocketInfo: IAgentHostSocketInfo | undefined;
	const configuredWebSocketServer = new DeferredPromise<void>();
	const connectionTrackerService: IConnectionTrackerService = {
		onDidChangeConnectionCount: connectionCountEmitter.event,
		waitForConfiguredWebSocketServer: () => configuredWebSocketServer.p,
		async startWebSocketServer(): Promise<IAgentHostSocketInfo> {
			if (protocolIngressDisposables.isDisposed) {
				throw new Error('Agent Host is shutting down.');
			}
			if (dynamicSocketInfo) {
				return dynamicSocketInfo;
			}

			const socketPath = isWindows
				? `\\\\.\\pipe\\vscode-agent-host-${generateUuid().replace(/-/g, '')}`
				: join(os.tmpdir(), `vscode-agent-host-${generateUuid().replace(/-/g, '')}.sock`);

			const wsServer = await WebSocketProtocolServer.create(
				{ socketPath },
				logService,
				{ instantiationService, logsHome: environmentService.logsHome },
			);
			if (protocolIngressDisposables.isDisposed) {
				wsServer.dispose();
				throw new Error('Agent Host is shutting down.');
			}
			protocolIngressDisposables.add(wsServer);

			const protocolHandler = protocolIngressDisposables.add(instantiationService.createInstance(
				ProtocolServerHandler,
				agentService,
				stateManager,
				wsServer,
				{
					hostLaunchKind,
					defaultDirectory: URI.file(os.homedir()).toString(),
					completionTriggerCharacters,
					terminalCommandPrefix: BANG_COMMAND_PREFIX,
					otlpLogEmitter,
				},
				clientFileSystemProvider,
			));
			protocolHandlers.push(protocolHandler);
			protocolIngressDisposables.add(protocolHandler.onDidChangeConnectionCount(count => connectionCountEmitter.fire(count)));

			logService.info(`[AgentHost] Dynamic WebSocket server listening on ${socketPath}`);
			dynamicSocketInfo = { socketPath };
			return dynamicSocketInfo;
		},
		async getInspectInfo(tryEnable: boolean): Promise<IAgentHostInspectInfo | undefined> {
			let url = inspector.url();
			if (!url && tryEnable) {
				try {
					inspector.open(0, '127.0.0.1', false);
				} catch (err) {
					logService.error('[AgentHost] Failed to open inspector', err);
					return undefined;
				}
				url = inspector.url();
			}
			if (!url) {
				return undefined;
			}
			// Inspector URL looks like: ws://host:port/uuid (host may be IPv6 in brackets)
			try {
				const parsedUrl = new URL(url);
				if (parsedUrl.protocol !== 'ws:') {
					logService.warn(`[AgentHost] Unexpected inspector URL: ${url}`);
					return undefined;
				}

				const port = Number(parsedUrl.port);
				const auth = parsedUrl.pathname.replace(/^\/+/, '');
				if (!Number.isInteger(port) || !auth) {
					logService.warn(`[AgentHost] Unexpected inspector URL: ${url}`);
					return undefined;
				}

				const host = parsedUrl.hostname === '0.0.0.0'
					? '127.0.0.1'
					: parsedUrl.hostname === '::'
						? '::1'
						: parsedUrl.hostname;
				const devtoolsHost = host.includes(':') ? `[${host}]` : host;

				return {
					host,
					port,
					devtoolsUrl: `devtools://devtools/bundled/js_app.html?v8only=true&ws=${devtoolsHost}:${parsedUrl.port}/${auth}`,
				};
			} catch {
				logService.warn(`[AgentHost] Unexpected inspector URL: ${url}`);
				return undefined;
			}
		},
	};
	server.registerChannel(AgentHostIpcChannels.Management, ProxyChannel.fromService(instantiationService.createInstance(
		AgentHostManagementService,
		agentService,
		connectionTrackerService,
		async () => {
			protocolIngressDisposables.dispose();
			await Promise.all(protocolHandlers.map(handler => handler.whenIdle()));
		},
	), disposables));
	if (!(server instanceof UtilityProcessServer)) {
		server.registerChannel(AgentHostIpcChannels.ConnectionTracker, ProxyChannel.fromService(connectionTrackerService, disposables));
	}

	// The configured bridge listener remains separate: tunnel forwarding pipes
	// raw WebSocket streams and cannot carry the local endpoint's bearer token.
	const configuredWebSocketServerStart = startWebSocketServer(
		agentService,
		stateManager,
		completionTriggerCharacters,
		clientFileSystemProvider,
		instantiationService,
		environmentService.logsHome,
		logService,
		otlpLogEmitter,
		protocolIngressDisposables,
		hostLaunchKind,
		count => connectionCountEmitter.fire(count),
		handler => protocolHandlers.push(handler),
	);
	configuredWebSocketServer.settleWith(configuredWebSocketServerStart);
	// Startup is complete once the last ingress has settled — successfully or
	// not, since a failed WebSocket server is non-fatal. Deferred maintenance
	// then runs after a client has also been served its first session listing.
	void configuredWebSocketServerStart.catch(err => {
		logService.error('Failed to start WebSocket server', err);
	}).finally(() => {
		agentService.markStartupComplete();
	});

	process.once('exit', () => {
		logService.dispose();
		disposables.dispose();
	});
}

interface ILocalAgentHostEndpoint {
	readonly metadata: ILocalAgentHostEndpointMetadata;
	readonly server: WebSocketProtocolServer;
}

async function startLocalAgentHostEndpoint(
	userDataPath: string,
	logService: ILogService,
	instantiationService: IInstantiationService,
	logsHome: URI,
): Promise<ILocalAgentHostEndpoint | undefined> {
	let metadata: ILocalAgentHostEndpointMetadata | undefined;
	let server: WebSocketProtocolServer | undefined;
	try {
		const endpointMetadata = createLocalAgentHostEndpointMetadata(userDataPath);
		metadata = endpointMetadata;
		await prepareLocalAgentHostEndpointMetadataDirectory(userDataPath);
		if (!isWindows) {
			await prepareLocalAgentHostEndpointSocketDirectory(userDataPath);
		}
		server = await WebSocketProtocolServer.create(
			{
				socketPath: endpointMetadata.endpoint.path,
				connectionTokenValidate: token => token === endpointMetadata.connectionToken,
			},
			logService,
			{ instantiationService, logsHome },
		);
		await server.whenListening;
		return { metadata: endpointMetadata, server };
	} catch (error) {
		try {
			server?.dispose();
		} catch (disposeError) {
			logService.error('[AgentHost] Failed to dispose local protocol endpoint', disposeError);
		}
		if (metadata) {
			cleanupLocalAgentHostEndpoint(userDataPath, metadata, logService);
		}
		logService.error('[AgentHost] Failed to start local protocol endpoint; continuing with MessagePort only', error);
		return undefined;
	}
}

function cleanupLocalAgentHostEndpoint(
	userDataPath: string,
	metadata: ILocalAgentHostEndpointMetadata,
	logService: ILogService,
): void {
	try {
		cleanupLocalAgentHostEndpointMetadataSync(userDataPath, metadata, logService);
	} catch (error) {
		logService.error('[AgentHost] Failed to clean up local protocol metadata', error);
	}
	try {
		cleanupLocalAgentHostEndpointSocketSync(metadata.endpoint.path);
	} catch (error) {
		logService.error('[AgentHost] Failed to clean up local protocol socket', error);
	}
}

/**
 * When the parent process passes WebSocket configuration via environment
 * variables, start a protocol server that external clients can connect to.
 * This reuses the same {@link AgentService} and {@link AgentHostStateManager}
 * that the IPC channel uses, so both IPC and WebSocket clients share state.
 */
async function startWebSocketServer(
	agentService: AgentService,
	stateManager: AgentHostStateManager,
	completionTriggerCharacters: readonly string[],
	clientFileSystemProvider: AgentHostClientFileSystemProvider,
	instantiationService: IInstantiationService,
	logsHome: URI,
	logService: ILogService,
	otlpLogEmitter: OtlpLogEmitter,
	disposables: DisposableStore,
	hostLaunchKind: AgentHostLaunchKind,
	onConnectionCountChanged: (count: number) => void,
	onProtocolHandlerCreated: (handler: ProtocolServerHandler) => void,
): Promise<void> {
	const port = process.env['VSCODE_AGENT_HOST_PORT'];
	const socketPath = process.env['VSCODE_AGENT_HOST_SOCKET_PATH'];

	if (!port && !socketPath) {
		return;
	}

	const connectionToken = process.env['VSCODE_AGENT_HOST_CONNECTION_TOKEN'];
	const host = process.env['VSCODE_AGENT_HOST_HOST'] || 'localhost';

	const wsServer = await WebSocketProtocolServer.create(
		socketPath
			? {
				socketPath,
				connectionTokenValidate: connectionToken
					? (token) => token === connectionToken
					: undefined,
			}
			: {
				port: parseInt(port!, 10),
				host,
				connectionTokenValidate: connectionToken
					? (token) => token === connectionToken
					: undefined,
			},
		logService,
		{ instantiationService, logsHome },
	);
	if (disposables.isDisposed) {
		wsServer.dispose();
		return;
	}
	disposables.add(wsServer);

	const protocolHandler = disposables.add(instantiationService.createInstance(
		ProtocolServerHandler,
		agentService,
		stateManager,
		wsServer,
		{
			hostLaunchKind,
			defaultDirectory: URI.file(os.homedir()).toString(),
			completionTriggerCharacters,
			terminalCommandPrefix: BANG_COMMAND_PREFIX,
			otlpLogEmitter,
		},
		clientFileSystemProvider,
	));
	onProtocolHandlerCreated(protocolHandler);
	disposables.add(protocolHandler.onDidChangeConnectionCount(onConnectionCountChanged));

	// Wait for the listener to actually bind before reporting readiness.
	// When the caller requested `port: 0` (let the OS pick), the bound
	// port is only known after this point — emitting the requested port
	// would print `localhost:0` and break the CLI's readiness parser.
	await wsServer.whenListening;
	const listenTarget = socketPath ?? `${host}:${wsServer.boundPort ?? port}`;
	logService.info(`[AgentHost] WebSocket server listening on ${listenTarget}`);
	// Do not change this line. The CLI looks for this in the output.
	console.log(`Agent host server listening on ${listenTarget}`);
}
