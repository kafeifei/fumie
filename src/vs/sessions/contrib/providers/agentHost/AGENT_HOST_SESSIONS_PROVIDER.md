# Agent Host sessions provider

> **Specification change gate:** Do not update this document for provider bug
> fixes, metadata additions, races, or transport behavior. Update it only when
> provider ownership, identity, or the shared Agent Host lifecycle changes.

## Scope

| Class | File | Purpose |
|-------|------|---------|
| `BaseAgentHostSessionsProvider` | `browser/baseAgentHostSessionsProvider.ts` | Abstract base implementing the full `ISessionsProvider` surface against an `IAgentConnection`. ~5200 lines; contains `AgentHostSessionAdapter` (the `ISession` impl) and `NewSession` (pre-creation draft). |
| `LocalAgentHostSessionsProvider` | `browser/localAgentHostSessionsProvider.ts` | Concrete local-window provider backed by the in-process `IAgentHostService`. |
| `RemoteAgentHostSessionsProvider` | `../remoteAgentHost/` | Concrete remote provider (one per connection). Documented separately in [`REMOTE_AGENT_HOST_SESSIONS_PROVIDER.md`](../remoteAgentHost/REMOTE_AGENT_HOST_SESSIONS_PROVIDER.md). |

Remote connection-specific behavior is specified in
[REMOTE_AGENT_HOST_SESSIONS_PROVIDER.md](../remoteAgentHost/REMOTE_AGENT_HOST_SESSIONS_PROVIDER.md).

## Implementations

| Implementation | Responsibility |
|----------------|----------------|
| `BaseAgentHostSessionsProvider` | Shared `ISessionsProvider` adaptation over an `IAgentConnection` |
| `LocalAgentHostSessionsProvider` | Local provider backed by `IAgentHostService` |
| `RemoteAgentHostSessionsProvider` | Per-connection remote specialization |

The shared base owns session adaptation, draft creation, catalog publication,
request routing, and provider operations. Concrete providers own connection
lifetime and environment-specific capabilities.

## Extended contract

Agent Host providers implement `IAgentHostSessionsProvider`, which extends
`ISessionsProvider` with:

- optional remote connection state and connect/disconnect operations;
- observable host-declared session configuration;
- configuration mutation and completion APIs.

Consumers use the extended type guard rather than matching provider IDs.
Provider-neutral features continue to depend on `ISessionsProvider`.

## Registration

`LocalAgentHostContribution` registers the local provider only when the Agent
Host runtime is available for the current environment. Agent discovery
populates session types dynamically from host root state.

- **Gated on Agent Host runtime availability.** If the runtime is unavailable, the contribution registers nothing.
- The local provider rebinds its root/action/notification listeners on the initial `onAgentHostStart`. `LocalAgentHostServiceClient` exposes no-op getters before its protocol client exists, so rebinding is required when the service was instantiated while Agent Host was disabled and started later.
- In web, Agent Host enablement additionally requires a remote authority. Web windows with a remote extension host use that server's Agent Host; serverless web keeps Agent Host disabled.
- Claude is surfaced whenever the local Agent Host advertises it; there is no extension-host Claude provider or per-window implementation preference.
- The local Codex session type is additionally gated directly on `chat.agentHost.codexAgent.enabled`. The Agents window does not register the OpenAI extension's Codex session type, so it has no separate Codex `preferAgentHost` setting.
- An optional product-level allowlist, `product.sessionsAllowedAgentHostProviders` (read through the injectable `IProductService`), restricts and orders which agent providers a build surfaces at all: `_shouldAdvertiseAgent` (local provider) drops any provider id not on the list before its usual gates run, and `_syncSessionTypesFromRootState` (base provider, shared with remote) sorts the advertised session types to match the list's order when one is configured. `undefined` (the default) means no restriction and no reordering.
- The enablement bit is read once through the sessions-layer `AgentHostEnablementService`; the contribution does not subscribe to config changes.
- Creates `LocalAgentHostSessionsProvider` via `IInstantiationService` and registers it through `ISessionsProvidersService.registerProvider`.
- Registers a per-session-type **working-directory resolver** (`IAgentHostSessionWorkingDirectoryResolver`) for each `agent-host-${sessionType.id}` scheme, refreshed on `onDidChangeSessionTypes`.
- The same module also wires the heavy lifting from the workbench chat layer at `WorkbenchPhase.AfterRestored`:
  - `AgentHostContribution` — agent discovery, session-handler registration, language-model providers, customization harness (via `IChatSessionsService`).
  - `AgentHostTerminalContribution` — terminal integration for agent host sessions.
  - The classic chat sidebar item controller is registered separately in the editor window only; the Agents window does not load or register `AgentHostSessionListController`.

The Electron-only `electron-browser/agentHost.contribution.ts` adds desktop-only Agent Host developer commands, including debugging, profiling, and restarting the local Agent Host process.

## Identity

The local provider uses:

| Property | Contract |
|----------|----------|
| Provider ID | `local-agent-host` |
| Workspace support | Local workspaces |
| Quick chats | Supported while the provider is available |
| Session types | Dynamically derived from advertised agents |

Agent provider names form logical session-type identifiers. Resource URI
schemes remain the routing identity for content and model providers. Consumers
must not derive one identifier by parsing another.

## Session adaptation

`AgentHostSessionAdapter` is the stable `ISession` facade for a committed Agent
Host session. It:

- preserves provider resource identity;
- projects host metadata into observables;
- exposes chats through stable `IChat` facades;
- derives capabilities from the advertised agent and live host state;
- updates observable state without replacing the facade when identity is stable.

The provider cache owns adapter identity. Catalog notifications describe
membership; adapter observables describe mutable state.

Provider-specific metadata such as pull-request provenance, changesets, agent
configuration, and external visibility is translated inside this provider.
Shared Sessions code consumes only provider-neutral fields and capabilities.

Agent-recorded artifacts are persisted with the session and projected through
`ISession.artifacts`. Pull request and issue artifacts that shared GitHub
surfaces can represent are promoted into the existing GitHub metadata without
duplicating them. Customizations used or read by the agent are derived per chat
and projected through `IChat.customizations`.

## Draft and send lifecycle

`NewSession` represents an untitled draft before the backend session is
committed.

```text
create draft
    -> resolve host configuration
    -> create or select the chat
    -> send through the owning agent connection
    -> publish or replace the committed session facade
```

The first send waits for tracked draft configuration. Cancellation disposes the
draft. Later configuration changes are scoped to the committed session and do
not recreate the entire facade.

Existing-session requests route by the provider resource and chat resource.
Host notifications update adapters and catalog membership reactively.

## Persistence and discovery

Startup metadata may seed lightweight session facades before a live connection
finishes discovery. Live host state remains authoritative and upgrades or
replaces cached state through the normal catalog lifecycle.

External sessions remain provider-owned domain objects. Visibility and
interactivity fields determine whether shared Sessions surfaces present them;
shared code does not infer visibility from Agent Host URI formats.

Host-owned background activities remain independent of client visibility. Agent
Merge monitoring prevents an enabled session from idle eviction while work is
active, resumes eligible sessions after host startup, and releases that
retention when monitoring ends.

## Local and remote boundary

- **`AgentHostSessionAdapter`** (`baseAgentHostSessionsProvider.ts`) is the `ISession` implementation. It wraps an `IAgentSessionMetadata` from the backend and exposes the observable session surface (`status`, `title`, `workspace`, `mainChat`, `mode`, …). The base provider keeps a `_sessionCache` of adapters keyed by `rawId`. Adapter capabilities derive from a shared provider-to-capabilities lookup, so one root-state event listener and one catalog scan serve the entire cache; root-state errors and disconnects clear the lookup so stale capabilities are not retained. Its `title` observable falls back to the localized `"New Session"` (`agentHost.sessionFallbackTitle`) whenever the backend metadata carries no `summary` yet — the same fallback the host itself uses for a registry row it cannot describe.
- **`NewSession`** is a disposable, **purely client-local** draft (pre-creation) session. Several can be in flight simultaneously; the management layer tears down superseded drafts via `deleteNewSession`. A draft never touches the backend: it does not call `createSession`, does not subscribe to a session channel, and does not call `disposeSession` when it is discarded. The agent host does not know a draft exists until its first message is sent, at which point the draft **graduates** into a committed `AgentHostSessionAdapter`. (The editor window's chat view keeps a separate eager mechanism for its own `agent-host-<provider>:/untitled-<uuid>` composer resources — `IAgentHostUntitledProvisionalSessionService` — which is unrelated to this draft and unused by the Agents window.) `isClientLocalDraft(sessionResource)` answers whether a resource is still such a draft — tracked in `_newSessions` with no cached adapter for its raw id — so chat-input consumers can tell "no backend session yet" from "committed" across the whole draft window, including the mid-send phase where the draft's status has already flipped to `InProgress`.
- The base provider is abstract; concrete providers supply: `connection`, `authenticationPending`, `resourceSchemeForProvider`, `_formatSessionTypeLabel`, `_adapterOptions` (workspace builder), `resolveWorkspace`, and optionally `_diffUriMapper`.

### Session-list state: two tables and one hand-over

`getSessions()` reads exactly **two** tables, and every row comes from one of them:

| Table | Rows it owns |
|-------|--------------|
| `_sessionCache` (keyed by `rawId`) | Every session the host has announced — `listSessions()` plus `notify/sessionAdded`. |
| `_newSessions` (keyed by `sessionId`) | Client-local drafts. A draft is listed **only** once its first send was dispatched (`NewSession.markSent()`, read back as `isSent`); an unsent draft lives in the composer and is deliberately invisible in the list. |

There is no third "pending" table. A draft allocates its own `rawId` at construction (`NewSession.rawId`) and the first send creates the host session under exactly that id, so **the draft's row and the committed adapter's row are the same row**, and the hand-over is a question of which table answers for that id:

1. Before the first send, only `_newSessions` has the id; nothing is listed for it and the host does not know it exists.
2. A live draft **masks** the cached adapter under its own `rawId` (`_draftRawIds()`), so the row can never be rendered twice, and from the first send onwards the draft renders it itself — with the title seeded from the query, so the row never flashes an empty `"New Session"`. For the same reason `_refreshSessions()` never evicts a cached row under a draft's id: some hosts briefly omit the just-created session from `listSessions()`.
3. When `notify/sessionAdded` lands for that `rawId`, `_waitForNewSession` resolves and the send retires the draft (`graduate()` + `deleteAndDispose`). Dropping it lifts the mask in the same synchronous step, so the following `onDidReplaceSession` (skeleton → committed adapter) already sees the committed row and only that row.

Because both reads consult `_newSessions` first, `getSessionByResource()` and `getSessions()` always agree on the row's identity, which is what keeps list selection and composer focus on the row across the hand-over. If the send fails or the connection drops (`_disposeAllNewSessions`), retiring the draft retracts its row instead, and `removed` is fired for it.

`notify/sessionAdded` fires once per session, immediately, as a provisional announcement (empty title) rather than at materialization — it is not re-emitted later. An active provisional session can already have entered `_sessionCache` through `listSessions()` or that initial `sessionAdded` with its original checkout; when materialization resolves the final project and worktree working directory, the host reports it as a `notify/sessionSummaryChanged` delta carrying `project`/`workingDirectories` (never a second `sessionAdded`), which the provider applies to the adapter in place — via the same metadata rebuild `sessionAdded` uses, then `updateAdapter` — and reports it as changed (see `_handleSessionSummaryChanged`).

Behavior shared by both belongs in the base provider. Connection policy stays
in the remote contribution.

## Testing

Focused tests live under `test/browser/*.test.ts` beside this provider. Tests
own concrete behavior, hydration races, metadata translation, and regressions;
this document owns only stable provider boundaries.

## Change policy

## How Chat Content Loads & Sends (no `IChatSessionItemController`)

A common point of confusion is whether the Agents window needs to register an
`IChatSessionItemController` for agent host sessions. **It does not.** The item
controller and the chat-content path are two unrelated APIs:

| API | Responsibility | Used by the Agents window? |
|-----|----------------|----------------------------|
| `IChatSessionItemController` (`registerChatSessionItemController`) | Enumerate session **items** (`.items`, `onDidChangeChatSessionItems`) for the **classic** chat sidebar list. | **No.** The agent host `ISessionsProvider` builds its own list via `getSessions()` straight from the connection (`listSessions()` / `notify/sessionAdded` / `rootState`). The workbench `AgentHostSessionListController` is registered only for classic chat surfaces in the editor window; the Agents window neither loads nor consumes it. |
| `IChatSessionContentProvider` (`registerChatSessionContentProvider`) | Load a session's **chat content** (history/turns) for a resource, provide input completions, and handle the request stream. | **Yes — this is the only API on the chat path.** |

The classic `ChatWidget` is generic: it renders whatever `IChatModel` it is
handed and sends through `IChatService`. The agent host plugs into chat through
**two registrations**, neither of which is the item controller — both wired by
`AgentHostContribution` (workbench) / the remote `*.contribution.ts` at startup:

1. **`registerChatSessionContentProvider(sessionType, AgentHostSessionHandler)`** —
   binds the per-provider `resource.scheme` (e.g. `agent-host-copilotcli`) to a
   content provider. `AgentHostSessionHandler.provideChatSessionContent()`
   hydrates the model from the backend session state (turns → history) and owns
   the request stream.
2. **`AgentHostLanguageModelProvider`** — publishes language models under
   `targetChatSessionType` = the same resource scheme so
   `BaseAgentHostSessionsProvider.getModelsSnapshot` resolves the right models.

End-to-end in the Agents window:

- **List** — `getSessions()` reads from the agent host connection. *(no widget, no item controller)*
- **Open / load content** — `ChatView.setChat(chat)` → `IChatService.acquireOrLoadSession(chat.resource, …)` → `ChatWidget.setModel(ref.object)`. `IChatService` routes the resource scheme to `AgentHostSessionHandler.provideChatSessionContent()`. `ChatView` first **locks** the widget to the contributed chat session type so follow-up turns keep routing to the same handler.
- **Send** — `ISessionsManagementService.sendNewChatRequest` → `provider.createNewChat()` → `provider.sendRequest()` → `IChatService.sendRequest(chatResource, …)`, which the bound `AgentHostSessionHandler` forwards to the backend over the agent host protocol.

Codex messages created by another thread remain in independent sessions, including when the source and destination use different workspaces. The Codex mapper removes the private transport envelope from visible text and records the source thread as typed message metadata. `AgentHostSessionHandler` converts that metadata into a per-request source resource; the generic request renderer exposes a source-chat affordance, and the Agents window opens it through the normal session service. In the source session, persisted create-thread and send-message calls may be absent from `thread/read`, so `codexRolloutMetadata` recovers their completed targets from the rollout and `codexReplayMapper` emits standard session-coordination tool parts. The existing result renderer turns those parts into target-chat buttons and consumes a matching `::created-thread` directive instead of displaying it as markdown.

When an existing Agent Host session becomes active, `BaseAgentHostSessionsProvider` publishes the current Agents-window client through `session/activeClientSet`. This lets the host include the window's current customizations and tool definitions before a request is sent; the chat handler continues to update that active-client entry as customizations or tools change.

The Agents window thus depends on the classic `ChatWidget` for rendering and on
the `IChatSessionContentProvider` for content/send, but **not** on
`IChatSessionItemController` — that API exists only to feed the classic chat
sidebar list.

User-input requests are unresolved `InputRequest` response parts on the active
turn, not a separate chat-level queue. `AgentHostSessionHandler` renders and
settles the question, plan-review, or URL elicitation directly from that part as
its `response` and `request.answers` change. Replacing an unresolved request with
the same id recreates the UI when its structure changes; completed turns restore
the settled interaction and answers at the part's original stream position.
Agent implementations decline or cancel requests raised without an active turn
because there is no response stream in which to represent them.

## New Session Flow

`createNewSession(workspaceUri, sessionTypeId)`:

1. Resolves the `ISessionType` and validates the workspace (`resolveWorkspace`).
2. Constructs a `NewSession` draft, stores it in `_newSessions`, and fires `onDidChangeSessionConfig`. New-session model/mode selection is seeded by the existing model/agent pickers and sent on the first message.
3. If a connection exists and authentication is **not** pending, resolves the draft's dynamic config (the schema and defaults the picker chips render). While auth is pending the draft waits; `_resumeNewSessionAfterAuthenticationSettles` (driven by the `authenticationPending` observable going false) re-runs that config resolution for all pending drafts. **No backend session is created here.** The only host call a draft makes is the pre-session `resolveSessionConfig` RPC; `createSession` happens on first send (see [Send Flow](#send-flow)).

Because a draft has no host session, it has no host-computed session state to present before the first message, and the provider answers the per-session queries from client-side data instead:

- `changesets` is an empty list (`[]`, never `undefined`), so the Changes view reports "no changes" rather than waiting forever on a load that cannot arrive.
- `getWorkingDirectory` / `getWorkingDirectories` come from the draft's own `workspaceUri` (nothing for a quick chat).
- `getCustomAgents` merges the client-scanned agents (`NewSession.getClientCustomAgents()`) with the root-state `AgentInfo.customizations` for the draft's provider, and `getCustomizations` returns that root-state list. Those are container-level customizations (plugins, MCP servers); per-session host customizations only exist after the session is created.
- Workspace/Git information is the client-side `resolveWorkspace` result. Host-computed Git metadata (`applySessionMeta` from `SessionState._meta`) first arrives after the send.
- File completions in the composer cannot be answered from session state either, so the workbench passes the draft's working directories on the `completions` request as `_meta` (`vscode.chat.workingDirectories`) and `AgentHostFileCompletionProvider` falls back to that when no session state exists.

Workspace trust is therefore enforced entirely by the first-Send backstop in `AgentHostSessionHandler` — the provider no longer has an eager create to gate — while the interactive trust prompt still lives at folder-pick time (`newChatWidget`).

Portable string config picks are remembered in profile storage and seed later drafts. `branch` is deliberately excluded because it is repository-scoped; each new workspace instead gets the default branch for worktree isolation or the current branch for folder isolation from the host's Git-backed config resolution. Branch config and completions use local names such as `main`; when that local name denotes the repository default, worktree creation still uses its remote-tracking ref such as `origin/main` as the start point.

The session-state subscription opened by the first send does not compute Git metadata while the host session lifecycle is `Creating`: its initial working directory is the selected checkout, not the final isolated worktree. Materialization publishes the resolved working directory through a `notify/sessionSummaryChanged` delta (`project`/`workingDirectories`) and starts the first Git-state refresh against that path; the later `session/metaChanged` / `notify/sessionSummaryChanged` updates rebuild the adapter workspace with the resolved branch.

**Create Session from Pull Request** uses the standard `createAndSendNewChatRequest` flow with `worktreeBranchTrack` enabled, so the generated agent branch tracks the selected remote PR branch. The provider applies isolation, tracking, and branch as one config resolution; worktree creation fetches a missing PR branch into `origin/<branch>` before checkout. The provisional session is activated immediately while this setup and the bootstrap request continue. The bootstrap request is read-only and carries `hideFromTranscript`; the workbench hides its request/response pair immediately, and the Agent Host stores a durable hidden-message marker in `Message._meta` plus the persisted prompt prefix so restore keeps the turn hidden. `SessionGitHubInfoResolver` uses the upstream branch (without its remote-name prefix) for PR lookup instead of the generated local branch, so the session is associated with the selected pull request and excluded from later picker invocations.

`createQuickChat(sessionTypeId)` is the **workspace-less** counterpart of `createNewSession` (declared via `supportsQuickChats`). It reuses the same `ISessionType` as a normal session — a quick chat is "identical minus exclusions", not a separate stack — but skips `resolveWorkspace` and builds the `NewSession` draft with `workspace === undefined` and `quickChat === true`. Both paths funnel through the shared `_createDraftSession` helper, so tracking and config resolution are otherwise identical. The draft's `session.workspace` resolves to `undefined`, and the `createSession` its first send produces simply **omits `workingDirectory`** — there is no explicit quick-chat input flag on the wire. The agent host **infers workspace-less at create from the absent `workingDirectory`**, tags the session (`_meta.workspaceless` + the persisted `agentHost.workspaceless` session-database key) and runs it in a stable per-session scratch cwd, with a **repo-less system prompt** (`COPILOT_AGENT_HOST_QUICK_CHAT_INSTRUCTIONS` appended) that tells the agent its cwd is a throwaway scratch directory, to stay read-only on real repos, and to delegate code changes to a dedicated session. The first-Send workspace-trust backstop is naturally a no-op because a workspace-less draft has no folder to trust. Forks are **excluded** from this inference: `isWorkspaceless = !sessionConfig.fork && !sessionConfig.workingDirectory`, so a fork without an explicit `workingDirectory` inherits the source session's context rather than being tagged workspace-less.

**Restore (persistence).** Quick chats survive reloads via the normal catalog round-trip: `listSessions()` re-advertises them with the `_meta.workspaceless` tag (carried on the session summary) — but also with the throwaway scratch cwd the host assigned. `AgentHostSessionAdapter` **seeds** its session-kind at construction from `readSessionWorkspaceless(metadata._meta)` (`QuickChatSessionKind` vs `WorkspaceSessionKind`); `_computeWorkspace()` delegates to that kind, so a quick chat returns `undefined` regardless of the scratch working directory, and `ISession.isQuickChat` mirrors it. The kind is **monotonically promotable**: `_promoteToQuickChatIfWorkspaceless` (called from both `update()` and `setMeta()`) flips a session to a quick chat the first time an authoritative `_meta` reports it workspace-less, and never demotes it back — an absent marker means "not included", never "cleared". So a session born mis-classified (stale persisted cache, an older host that dropped `_meta` from its listing) heals as soon as any `_meta`-bearing metadata arrives, rather than leaking the scratch dir as a workspace forever. The tag should still ride on **every** adapter-construction path — `_refreshSessions()`/`listSessions` **and** the live `_handleSessionAdded(summary)` notification (which carries `summary._meta`) — because promotion only removes the *permanence* of the mis-classification, not the transient wrong grouping before the first heal. `_persistCache` overlays the adapter's live quick-chat state onto the serialized snapshot so a healed kind survives a reload instead of being resurrected from a stale `_metaByRawId` entry. On the host side, `AgentService.listSessions()` overlays `_meta.workspaceless` onto the provider listing from the persisted `agentHost.workspaceless` session-database key (`AH_META_WORKSPACELESS_DB_KEY`) (the providers themselves, e.g. `CopilotAgent.listSessions()`, do not emit it) so restored sessions carry the tag even after the state manager's live summary is gone. `restoreVisibleSessions` itself is workspace-agnostic — it resolves persisted slots by `sessionResource`, so a quick chat re-hydrates like any other session once the provider re-lists it.

Codex Desktop also persists chats created without a selected folder using a generated `Documents/Codex/<date>/<slug>` working directory. The Codex provider recognizes that canonical directory together with the rollout header's `Codex Desktop` originator and adds `_meta.workspaceless` while retaining the generated cwd for the runtime. Desktop chats created with an explicitly selected project keep their normal workspace identity.

Restored sessions with a working directory but no Agent Host-owned `configValues` are external folder sessions, so the host resolves them with `isolation: folder` instead of applying the new-session default (`worktree`). For Codex Desktop sessions, restore streams the rollout's model provenance: `session_meta.model_provider` plus each turn's `turn_context.model`. The latest selection seeds the default chat draft, each restored turn carries its own request/usage model for response labels, and live usage reports the selected model too. The Desktop rollout is authoritative over a stale Agent Host overlay: if an earlier VS Code build mapped the session URI to a replacement proxy thread, restore probes the original URI-backed Desktop thread, heals `codex.threadId`/`codex.model`, and resumes that original thread/provider. Continuing in VS Code therefore keeps the ChatGPT-visible history and appends new turns to the same rollout instead of creating an unsynchronized proxy thread.

An external folder session whose working directory is already a linked Git worktree keeps `isolation: folder` because the Agent Host does not own that checkout and must not create, archive, recreate, or delete it. Restore records only its primary repository identity (plus the diff base), so `project.uri` differs from the working directory and the workspace model exposes `workTreeUri`; this produces worktree presentation while leaving lifecycle ownership with the creating app. Workspace-less sessions skip this probe, and a primary checkout resolves to itself and remains an ordinary folder session.

A quick chat is a **single-chat session** (`supportsMultipleChats: false`, forced by the `QuickChatSessionKind`), so it has no peer chats; `applyChatCatalog` collapses any state-advertised chats to the default chat. The agents-window core consumes `ISession.isQuickChat` (via `isQuickChatSession(session)`) for list grouping and context keys, rather than inferring quick-chat from `workspace === undefined`. A later `SessionState._meta` **can** promote the kind (and `setMeta` reports the change so the list regroups even when the workspace was already `undefined`), and the host guarantees the tag rides on **both** the summary `_meta` and the subscribed `SessionState._meta` (`createSessionState(summary)` copies `summary._meta` onto the restored state), keeping the two channels consistent.

`createNewChat(chatId)` creates the chat session model (`IChatSessionsService.getOrCreateChatSession`) so the management service can open the widget, and returns the draft's main chat. For a committed multi-chat session, it asks the host to add a peer chat, waits for that chat to surface in the catalog, seeds its input state, and presents it as `Untitled` until its first request is sent.

## Send Flow

`sendRequest(chatId, chatResource, options)` for a draft session:

1. Requires the draft and an active connection.
2. Waits for any tracked dynamic-config resolution so a picker change cannot race the config captured for the first request.
3. Builds `IChatSendRequestOptions` (agent mode from the selected custom agent or the built-in agent, selected model, attached context, `agentHostSessionConfig` from `getCreateSessionConfig`, and `agentHostSessionMetadata` from the draft's initial metadata). Both of the latter two exist because the draft has no host session yet: they are the only way its config values and creation metadata reach the `createSession` the handler is about to issue.
4. Loads the chat model and seeds the selected model / custom agent into the input state so the pickers reflect the choice immediately.
5. Snapshots existing cache keys, then `IChatService.sendRequest` (which the registered `AgentHostSessionHandler` routes to the backend).
6. Marks the draft as sent (`markSent`) — which is what publishes its row, titled from the first line of the query — and announces it through `onDidChangeSessions`. See [Session-list state](#session-list-state-two-tables-and-one-hand-over): from here the draft owns the row for the `rawId` it claimed and the committed adapter under that id stays masked.
7. Waits for the committed backend session (`_waitForNewSession`); on arrival the draft **graduates** (it holds no host resources, so it only cancels its own lifetime and stops accepting config mutations — no `disposeSession` is ever sent for a draft), config is preserved, the draft is dropped from `_newSessions` (handing its row to the committed adapter), and `onDidReplaceSession` fires from skeleton → committed session. If commit detection times out or the connection is lost, retiring the draft retracts the row and `sendRequest` rejects rather than returning an `InProgress` session that has no remaining lifecycle owner.

The backend session itself is created on the other side of that `sendRequest`, in the workbench `AgentHostSessionHandler._invokeAgent`: for an Agents-window resource there is no eagerly-created state to adopt (`_readEagerlyCreatedSessionState` returns `undefined`), so it takes the `_createAndSubscribe` branch and issues exactly one `createSession` using the same raw id as the chat resource, the request's `agentHostSessionConfig` on top of the initial session config, and `_meta` merged from `getInitialSessionMetadata()` and the request's `agentHostSessionMetadata`. Discarding a draft before that first send therefore leaves nothing behind on the host.

For an already-committed session (including a newly-created peer chat), `sendRequest` loads and holds the target chat model through `IChatService.sendRequest`, applies the cached model/agent input state before dispatch, clears the draft afterwards, then clears the provider-side "new chat" flag so status returns to the host-reported value. Holding the model reference is required for peer chats opened by the lightweight new-chat composer, because no `ChatWidget` owns that model while the first message is dispatched.

Running-chat `setModel` / `setAgent` calls update the active chat's cached selection and the loaded chat model's input state. `AgentHostSessionHandler` debounces `IChatModel.inputModel.state` changes back into `chat/draftChanged`, so text/attachment/model/mode drafts survive reloads and restore from `ChatState.draft` when the chat is re-opened. The agent host persists drafts in the per-session database's `chat_drafts` table, keyed by chat URI.

When restoring Copilot SDK history, `mapSessionEvents` best-effort reconstructs each user message's model, launch/resume custom-agent fallback, and SDK-persisted attachments. Model selection is inferred from `session/model_change` events plus the launch fallback; SDK `subagent.selected` agent names are not treated as AHP agent URIs. Attachments come from the SDK `user.message` attachment payload.

The Agents-window subagent transcript pill surfaces the child turn's current model as quiet inline metadata and shows only the newest child tool on an attached single-line row. Terminal tools prefer `ToolCallBase.intention` over the raw invocation message/command; other tools use the SDK/provider-authored invocation message with the display name as fallback. The view uses shared chat markdown/file-widget rendering for editor-quality file chips and inline commands, animates replacements with the rotating-placeholder wipe/shimmer, and snaps immediately for reduced motion.

## CRUD & Stubbed Operations

- `archiveSession` / `unarchiveSession` / `deleteSession` — round-trip to the backend. `deleteSessions` is the batch variant (used when multiple sessions are selected): it disposes each backend session and emits a single removal change event. Sessions advertise `capabilities.supportsDelete`, so the shared sessions-list "Delete..." action (contributed by the sessions workbench, gated on `SessionSupportsDeleteContext`) confirms and invokes deletion — there is no provider-specific delete action.
- `renameChat` — renames a single chat independently of the session title. For an additional peer chat it dispatches `SessionTitleChanged` on that chat's channel; for the default/main chat it dispatches on the default chat channel (`setDefaultChatTitle`). The host persists the new title under `customChatTitle:<chatUri>` and re-applies it on restore — the default chat's title is seeded back through `restoreSession`/`_ensureDefaultChat`, peer chats through `_restorePeerChats` — so an independently-renamed main/peer chat survives a process restart or idle eviction instead of reverting to the session title.
- `renameSession` — updates the session-level title.
- `deleteChat` — no-op (agent host sessions don't model individually deletable chats).
- `forkChat(sessionId, sourceChat, turnId)` — multi-chat only. Mints a peer chat URI and calls `connection.createChat(sessionUri, chatUri, { fork: { source, turnId } })`, where `source` is the backend chat URI (a `chatId` fragment addresses a peer chat, otherwise the session's default chat). The host seeds the new chat with the forked history; the provider waits for it to surface in `cached.chats` and returns it. Routed from the **Fork Conversation** gesture via `ISessionsManagementService.forkChatInSession`; single-chat sessions instead fork into a new session (the workbench `AgentHostSessionHandler.forkSession`).
- `createSideChat(sessionId, sourceChat, turnId)` — gated on `capabilities.supportsSideChat` (currently Claude and Copilot), mirroring `forkChat`'s multi-chat gating and backend-URI resolution. Calls `connection.createChat(sessionUri, chatUri, { model, sideChat: { source, turnId } })`. The anchor may be the source chat's completed or active turn. The node host validates and persists the `SideChat` origin, then passes the source handle to the provider. Claude/Copilot use their SDK fork primitives for hidden context, locking creation on the new chat so they can snapshot provider context accumulated during an active source turn, and filter the inherited prefix from restored turns. The provider wraps the first SDK prompt with a private instruction to prefer explanation over action and to avoid doing work unless explicitly requested. When the active turn has streamed user-visible markdown that the native fork has not persisted, a bounded snapshot is included in the same wrapper. Provider reconstruction strips the wrapper from visible history. The source chat's model/agent selection is re-applied to the new chat once it surfaces, after which the Agents window treats it like any other user-created peer chat tab/menu entry; only tool-origin subagents remain hidden by default.

## Picker & Action Contributions

The provider ships a rich set of session-scoped UI in `browser/`:

| File | Responsibility |
|------|----------------|
| `agentHostSessionConfigPicker.ts` | The per-session config picker (isolation, branch, and host-declared dynamic properties) backed by the dynamic-session-config API; includes `media/agentHostSessionConfigPicker.css`. On desktop the `isolation` property renders as a "Worktree" checkbox (checked = worktree, unchecked = folder) instead of a dropdown; the phone layout keeps the chip so it can route to the unified repo sheet. |
| `agentHostAgentPicker.ts` | Custom-agent picker for a session. |
| `agentHostModePicker.ts` | Agent mode enum picker (extends a shared `AgentHostSessionEnumPicker`), rendered immediately before approvals in the secondary toolbar for new and active sessions. |
| `agentHostClaudePermissionModePicker.ts` | Claude-specific permission-mode picker. |
| `agentHostCodexApprovalsPicker.ts` | Codex-specific permissions-preset picker with Default Permissions, Auto-Review, and Full Access choices. Its bounded, wrapped action-list layout is shared with the editor composer through `vs/platform/agentHost/browser/codexApprovalsPicker.ts`. |
| `agentHostPermissionPickerActionItem.ts` / `agentHostPermissionPickerDelegate.ts` | Toolbar action item + delegate for the permission picker. |
| `agentHostSkillButtons.ts` | Defines the `sessions.isAgentHostSession` (`IsAgentHostSession`) context key and retains the disabled legacy skill-button registrations superseded by host-executed changeset operations. |
| `agentHostSessionChangesets.ts` / `agentHostDiffs.ts` | Changeset model, operation mapping/invocation, and diff conversion (`mapProtocolStatus` maps the protocol status bitset → `SessionStatus`). |
| `agentHostSessionBranchActions.ts` | Branch-related session actions. |
| `exportDebugLogsAction.ts` | "Export debug logs" developer action. |
| `openSessionEventsFileActions.ts` | "Open Copilot CLI State File" — Sessions-app variant resolving the session via `ISessionsManagementService.activeSession`. |
| `mobile/` | Phone-layout variants: `mobileAgentHostModePicker.ts`, the scoped-model-backed `mobileChatInputConfigPicker.ts`, and the provider-backed `mobileChatPhoneInputPresenter.ts`. |

Skill buttons and the `openSessionEventsFile` action are gated on `IsAgentHostSession` (and `ChatContextKeys.enabled`).

## Settings

The Agents window has its own Settings custom view (`sessions.settings`, contributed from `src/vs/sessions/contrib/settings/`). It is a graphical form over existing configuration keys and host root config — not a fork of VS Code Preferences, and not a second source of defaults. Open it from the titlebar gear, the account menu (**Settings**), Command Palette, or `Cmd/Ctrl+,`. Left nav is grouped as **General**, **Agents** (enablement / identity / models / runtime), and **Customizations** (Overview, Agents, Skills, Instructions, Hooks, MCP Servers, Plugins — hosted in the Settings pane from the existing management widgets, following the active harness). JSONC remains the expert escape hatch:

Two synthetic filesystem providers expose JSONC settings editors:

| Scheme | URI shape | Scope |
|--------|-----------|-------|
| `agent-host-settings` | `agent-host-settings://{providerId}/settings.jsonc` | Host-wide settings for a provider (`agentHostSettingsFileSystemProvider.ts`, registered by `agentHostSettings.contribution.ts`). |
| `agent-session-settings` | `agent-session-settings://{providerId}/{resourceScheme}{path}.jsonc` | Per-session settings, parseable back to a `sessionId` (`agentSessionSettingsFileSystemProvider.ts`, registered by `agentSessionSettings.contribution.ts`). |

`agentHostSettingsShared.ts` provides the shared schema/serialization helpers (`buildAgentHostConfigJsonSchema`, `convertPropertySchema`, `serializeAgentHostConfigDocument`) used by both providers.

## Local vs Remote Differences

| Aspect | Local (`LocalAgentHostSessionsProvider`) | Remote (`RemoteAgentHostSessionsProvider`) |
|--------|------------------------------------------|--------------------------------------------|
| Connection | In-process `IAgentHostService` (always present) | One live `IAgentConnection` per remote host |
| Instances | One | One per connection (created/disposed dynamically) |
| Resource scheme | `agent-host-${sessionType.id}` | `remote-${authority}-${agent.provider}` |
| Browse actions | none | host-filesystem "Folders" picker |
| Diff URIs | `toAgentHostUri(uri, 'local')` | host-scoped mapper |
| Startup session cache | Shared base persistence; fixed key `localAgentHost.cachedSessions` | Shared base persistence; key `remoteAgentHost.cachedSessions.${authority}` + `unpublishCachedSessions()` offline gate |
| Extra interface members | — | `connectionStatus`, `remoteAddress`, `connect`/`disconnect` |

## Tests

`test/browser/` covers the provider and its pickers: `localAgentHostSessionsProvider.test.ts`, `agentHostAgentPicker.test.ts`, `agentHostAgents.test.ts`, `mobileChatPhoneInputTarget.test.ts`, `agentHostClaudePermissionModePicker.test.ts`, `agentHostSkillButtons.test.ts`, `agentSessionSettingsFileSystemProvider.test.ts`, `openSessionEventsFile.test.ts`, and `agentHost/agentHostPermissionPickerDelegate.test.ts`.
