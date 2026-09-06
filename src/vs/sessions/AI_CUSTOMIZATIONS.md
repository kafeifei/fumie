# AI customizations architecture

> **Specification change gate:** Do not update this document for UI changes,
> migrations, discovery fixes, or race handling. Update it only when shared
> ownership, an interface, the item pipeline, or harness semantics changes.

## Scope

The AI customizations experience discovers and manages agents, skills,
instructions, prompts, hooks, MCP servers, tools, and plugins across workspace,
user, extension, built-in, and external sources.

This specification defines stable ownership and extension contracts shared by
the editor workbench and Agents Window. Individual controls, migration flows,
copy, styling, and bug behavior belong in code, component fixtures, and focused
tests.

## Ownership

The shared management editor and contracts live under:

- `vs/workbench/contrib/chat/browser/aiCustomization/`;
- `vs/workbench/contrib/chat/common/`.

The Agents Window contributes:

- the customizations tree and overview under
  `vs/sessions/contrib/aiCustomizationTreeView/`;
- Sessions-specific workspace and harness adapters under
  `vs/sessions/contrib/chat/`;
- Sessions sidebar entry points under `vs/sessions/contrib/sessions/`.

Shared workbench code owns reusable discovery and management behavior. Sessions
code adapts active-session context and provider-backed harnesses without adding
Sessions dependencies to `vs/workbench`.

## Service boundary

### `IAICustomizationWorkspaceService`

This service supplies per-window policy to the shared editor:

- available management sections;
- whether the surface is in the Agents Window;
- the active project root;
- welcome-page capabilities.

The editor workbench resolves project context from its workspace. The Agents
Window resolves it from the scoped active session.

### `ICustomizationHarnessService`

A harness represents the execution environment that consumes customizations.
Storage answers where an item came from; a harness answers which runtime can use
it.

The service owns:

- registered harness descriptors;
- the active harness;
- dynamic external harness registration;
- harness-specific item and enablement providers.

Core workbench registrations may expose Local, Copilot CLI, and Claude harnesses
when their backing agents are available. The Agents Window exposes harnesses
backed by registered session content providers and does not assume a Local
fallback.

### `IHarnessDescriptor`

Descriptors declare presentation and discovery policy. Widgets consume the
descriptor rather than branching on a harness identifier.

A descriptor may define:

- visible management sections;
- per-section creation behavior;
- hidden or renamed item types;
- MCP collection exclusions that do not hide host-published servers;
- required agent availability;
- external items, enablement, and plugin actions.

When a new descriptor field is added, update every descriptor factory and both
workbench registrations.

### Customization sources

`AICustomizationSource` distinguishes local, user, extension, plugin, and
built-in items. Source providers and workspace services apply their applicable
discovery policy before view-model grouping. Filtering changes presentation
only; it does not mutate the underlying customization.

## Item pipeline

Customization sources adapt their data into the shared item contract. The
management model aggregates those items, applies harness and storage filters,
and projects list items for the active section.

```text
source providers
    -> customization item contract
    -> harness and storage filtering
    -> management model and section counts
    -> list/tree presentation
```

Section counts and rendered rows consume the same filtered model so hidden or
disabled sources cannot appear in one surface but not the other.

Prompt-based items use the prompts service adapter. MCP servers, tools, plugins,
and external harness items use their owning providers directly when their data
does not fit the prompt-file contract.

## Active-session context

In the Agents Window, the customization harness and project root track
`ISessionsService.activeSession`. Opening the editor synchronizes it with the
currently active session, and switching the active session can update the
editor's harness and project context. A transient project-root override takes
precedence while it is set.

The management-editor command may select a section, target a session type, and
reveal a URI-addressable customization. Operations that migrate files bind
destination resolution and confirmation to their initiating session and stop if
the active session changes.

Provider-backed items retain provider identity through the shared contract.
Shared widgets must not import or branch on provider implementations.

## External customization providers

Extensions may contribute customization items through the proposed
`chatSessionCustomizationProvider` API. Its internal contract is
`ICustomizationItemProvider` and `ICustomizationItem`.

Changes to that item shape must remain aligned across:

1. the proposed extension API;
2. extension-host protocol DTOs;
3. extension-host mapping;
4. main-thread mapping;
5. the internal customization item.

New fields should be optional unless the proposal explicitly introduces a
breaking version.

## Enabling and disabling built-in skills

Built-in discovery and user enablement are separate stores. Discovery determines
which built-in items exist; enablement records the user's disabled set. Item
projection combines both and keeps the built-in source distinct from extension
and user storage.

Harness filtering must happen before enablement presentation so an item hidden
from a harness cannot be reintroduced by its stored enablement state.

## Feature gating

Customization surfaces are hidden when AI features are disabled. Contributions
use `ChatContextKeys.enabled` for declarative visibility and the applicable
entitlement state for programmatic hiding.

Optional sections and migrations remain behind their owning configuration or
capability. A disabled feature must not perform background discovery solely to
populate hidden UI.

## Testing

Use focused unit tests for filtering, grouping, counts, and service contracts.
Use component fixtures for layout, section presentation, narrow viewports, and
theme coverage. Cross-window descriptor changes must validate both the editor
workbench and Agents Window registrations.

The executable customization test plan lives in
[test/ai-customizations.test.md](test/ai-customizations.test.md).

## Change policy

Update this specification only when ownership, a shared service/interface, the
item pipeline, or harness semantics change. Do not append UI walkthroughs,
migration algorithms, race analyses, file inventories, or regression
narratives. Keep those in tests, short code comments, issues, and pull requests.

Available harnesses:

| Harness | Label | Description |
|---------|-------|-------------|
| `vscode` | Local | Shows all storage sources (default in core) |
| `cli` | Copilot CLI | Restricts user roots to `~/.copilot`, `~/.claude`, `~/.agents` |
| `claude` | Claude | Restricts user roots to `~/.claude`; hides Prompts + Plugins sections |

In core VS Code, all three harnesses are registered but CLI and Claude only appear when their respective agents are registered (`requiredAgentId` checked via `IChatAgentService`). VS Code is the default.
In sessions, the Local harness is not registered. Harnesses are accepted for any session type that has a registered content provider (checked via `IChatSessionsService.getContentProviderSchemes()`). The first provider harness becomes active until a session selects its own harness, and the editor uses no Local fallback label while none is available. AHP remote servers register directly via `registerExternalHarness`.

Remote agent hosts can also register **external harnesses** dynamically. Each remote agent harness may contribute:
- an `itemProvider` that surfaces plugins already configured on the remote host (or synced into the active remote session),
- a `disableProvider` that lets users opt out individual files/plugins from auto-sync, and
- `pluginActions` that add environment-specific commands such as "Add Remote Plugin" to the Plugins section add menu alongside the default install-from-source action. The create action remains a separate toolbar button.

Remote Agent Host registrations auto-sync enabled `PromptsStorage.user` agents, skills, instructions, and prompts from the client in addition to the extension, plugin, and built-in sources shared with local Agent Hosts. Local Agent Hosts exclude user storage from this client bundle because native discovery already reads the same machine's user home. Remote user files are flattened into the existing synthetic Open Plugin, retain their original URI for per-file opt-out, and remain grouped as client-originated after provenance recovery. Host-native user customizations remain separate entries; no client/host precedence or cross-tier deduplication is introduced. Hooks and singleton agent-instruction files such as `~/.claude/CLAUDE.md` and `~/.copilot/copilot-instructions.md` are outside this sync path.

The Plugins section renders remote harness `itemProvider` entries with `type: 'plugin'` directly. This is separate from the prompt-file pipeline used for Agents, Skills, Instructions, Prompts, and Hooks.

Local plugin discovery is aggregated by `IAgentPluginService` from priority-ordered discovery providers: configured paths, VS Code marketplace installs, extension-contributed plugins, and Copilot CLI installs. Each provider reports `undefined` until its initial scan completes; the service waits for every provider to complete before exposing plugins. Once ready, plugins are canonicalized into collision groups so the same plugin discovered from multiple install roots (for example a VS Code marketplace install and a Copilot CLI direct install) remains visible but only the highest-priority copy is enabled by default. Enabling one copy disables the other copies in the same collision group. Uninstalling a plugin discovered through `chat.pluginLocations` removes its configuration entry without deleting the plugin folder; users can open the folder separately when they want to remove its files.

Agent Plugins use the portable Agent Plugin layout alongside the existing Copilot, Claude, and Open Plugin adapters. A package is recognized when root `plugin.json` declares an `agent-plugins.org` plugin schema. Compatible schema revisions are accepted, malformed optional metadata is ignored, and a recognized manifest takes precedence over `.plugin/plugin.json`. Agent Plugins contribute only immediate-child `skills/*/SKILL.md` skills and root `mcp.json` servers. They ignore legacy custom paths, inline components, `.mcp.json`, root `SKILL.md`, commands, agents, rules, hooks, LSP servers, and output styles.

The shared plugin discovery pipeline selects format-specific component paths while using the same permissive component readers. For Agent Plugins, compatible schema revisions are recognized, known valid manifest fields are retained, fixed `skills/` and `mcp.json` paths are used, and remote servers are normalized for existing MCP transport auto-detection. Discovery preserves unresolved harness-owned values such as `${PLUGIN_DATA}` rather than allocating or interpreting a plugin data directory. Legacy Open Plugin discovery, marketplace/cache/scope behavior, command namespacing, and the synthetic `.plugin/plugin.json` plus `.mcp.json` bundles used for synchronized customizations remain unchanged and do not claim Agent Plugins v1 conformance. Direct root-manifest installation is supported, but Agent Plugins v1 does not define a marketplace protocol.

Runtime projection is provider-specific. Copilot receives strict skills and MCP explicitly rather than through legacy SDK plugin-directory discovery. Codex receives strict skill roots plus MCP, with remote transport selected by its existing auto-detection. Claude excludes strict packages from legacy plugin discovery and can project remote MCP through its existing auto-detection, but its current SDK cannot register external skill directories or provide the per-server working directory required by strict stdio MCP, so those components are reported and skipped.

Claude Agent Host multi-root customization discovery is gated by the hidden, default-off `chat.agentHost.claudeAgent.multiRootEnabled` setting. When enabled, the primary working directory and each SDK `additionalDirectories` root contribute standalone `.claude/agents`, `.claude/skills`, and native plugin enablement to the Customizations editor. Roots are processed in session order, followed by user scope; same-named standalone agents or skills use the first visible definition as the display source. This display policy is centralized because the SDK reports standalone entries by name rather than source URI. Native plugin loaded state remains authoritative from the SDK snapshot. Rules, hooks, MCP configuration, commands, and CLAUDE.md remain primary-root/user scoped because Claude additional directories do not load those configuration types. Each contributing root has its own writable directory container, and secondary-root watchers observe only agents, skills, and plugin settings.

### IHarnessDescriptor

Key properties on the harness descriptor:

| Property | Purpose |
|----------|--------|
| `itemProvider` | `ICustomizationItemProvider` supplying items; when absent, falls back to `PromptsServiceCustomizationItemProvider` |
| `disableProvider` | `ICustomizationDisableProvider` enabling opt-out of individual items from auto-sync |
| `hiddenSections` | Sidebar sections to hide (e.g. Claude: `[Prompts, Plugins]`) |
| `workspaceSubpaths` | Restrict file creation/display to directories (e.g. Claude: `['.claude']`) |
| `hideGenerateButton` | Replace "Generate X" sparkle button with "New X" |
| `sectionOverrides` | Per-section `ISectionOverride` map for button behavior |
| `requiredAgentId` | Agent ID that must be registered for harness to appear |
| `instructionFileFilter` | Filename/path patterns to filter instruction items |

### IStorageSourceFilter

A per-type filter controlling which storage sources are visible.

```typescript
interface IStorageSourceFilter {
  sources: readonly PromptsStorage[];  // Which storage groups to display
}
```

The shared `applyStorageSourceFilter()` helper applies this filter to any `{uri, storage}` array.

**Sessions filter behavior (CLI harness):**

| Type | sources |
|------|---------|
| Hooks | `[local, plugin]` |
| Prompts | `[local, user, plugin, builtin]` |
| Agents, Skills, Instructions | `[local, user, plugin, builtin]` |

**Core VS Code filter behavior:**

Local harness: all types use `[local, user, extension, plugin, builtin]`. Items from the default chat extension (`productService.defaultChatAgent.chatExtensionId`) are grouped under "Built-in" via `groupKey` override in the list widget. Synthetic per-extension tool sets group contributed tools in Chat Customizations and are hidden from the chat tool picker, where the tools are grouped directly by extension.

Voice customizations follow the same workspace/user split as Copilot instructions but are consumed directly by voice features rather than listed as standard prompt-file sections in the management editor. Voice Mode combines `~/.copilot/voice.md` with each trusted workspace's `.github/voice.md` and sends the result to the backend as `voice_instructions` on both session start and resume. Dictation separately combines `~/.copilot/dictation.md` with each trusted workspace's `.github/dictation.md` and appends the result to its language-model post-processing prompt for terminology and formatting guidance. Separate configure commands create or open either scope and are linked from their respective settings, microphone menus, and the management editor overview.

CLI harness (core):

| Type | sources |
|------|---------|
| Hooks | `[local, plugin]` |
| Prompts | `[local, user, plugin]` |
| Agents, Skills, Instructions | `[local, user, plugin]` |

Claude harness (core):

| Type | sources |
|------|---------|
| Hooks | `[local, plugin]` |
| Prompts | `[local, user, plugin]` |
| Agents, Skills, Instructions | `[local, user, plugin]` |

Claude additionally applies:
- `hiddenSections: [Prompts, Plugins]`
- `instructionFileFilter: ['CLAUDE.md', 'CLAUDE.local.md', '.claude/rules/', 'copilot-instructions.md']`
- `workspaceSubpaths: ['.claude']` (instruction files matching `instructionFileFilter` are exempt)
- `sectionOverrides`: Instructions → "Add CLAUDE.md" primary, "Rule" type label, `.md` file extension

### Built-in Extension Grouping (Core VS Code)

In core VS Code, customization items contributed by the default chat extension (`productService.defaultChatAgent.chatExtensionId`, typically `GitHub.copilot-chat`) are grouped under the "Built-in" header in the management editor list widget, separate from third-party "Extensions".

`PromptsServiceCustomizationItemProvider` handles this via `applyBuiltinGroupKeys()`: it builds a URI→extension-ID lookup from prompt file metadata, then sets `groupKey: BUILTIN_STORAGE` on items whose extension matches the chat extension ID (checked via the shared `isChatExtensionItem()` utility). The underlying `storage` remains `PromptsStorage.extension` — the grouping is a `groupKey` override that keeps `applyStorageSourceFilter` working while visually distinguishing chat-extension items from third-party extension items.

`BUILTIN_STORAGE` is defined in `aiCustomizationWorkspaceService.ts` (common layer) and re-exported by both `aiCustomizationManagement.ts` (browser) and `builtinPromptsStorage.ts` (sessions) for backward compatibility.

### Management Editor Item Pipeline

All customization sources — `IPromptsService`, extension-contributed providers, and AHP remote servers — produce items conforming to the same `ICustomizationItem` contract (defined in `customizationHarnessService.ts`). This contract carries `uri`, `type`, `name`, `description`, optional `storage`, `groupKey`, `badge`, plugin provenance (`pluginUri`/`pluginLabel`), and status fields.

```
promptsService ──→ PromptsServiceCustomizationItemProvider ──→ ICustomizationItem[]
                                                                       │
Extension Provider ───────────────────────────────────────→ ICustomizationItem[]
                                                                       │
AHP Remote Server ────────────────────────────────────────→ ICustomizationItem[]
                                                                       │
                                                                       ▼
                                              CustomizationItemSource (aiCustomizationItemSource.ts)
                                              ├── normalizes → IAICustomizationListItem[]
                                              ├── expands hooks from file content
                                              └── normalizes items from provider
                                                                       │
                                                                       ▼
                                                              List Widget renders
```

**Key files:**

- **`aiCustomizationItemSource.ts`** — The browser-side pipeline: `IAICustomizationListItem` (view model), `IAICustomizationItemSource` (data contract for both customization rows and harness-provided source folders), `AICustomizationItemNormalizer` (maps `ICustomizationItem` → view model, inferring storage/grouping from URIs when the provider doesn't supply them), `ProviderCustomizationItemSource` (orchestrates provider + sync + normalizer), and shared utilities (`expandHookFileItems`, `getFriendlyName`, `isChatExtensionItem`).

- **`promptsServiceCustomizationItemProvider.ts`** — Adapts `IPromptsService` to `ICustomizationItemProvider`. Reads agents, skills, instructions, hooks, and prompts from the core service, expands instruction categories and hook entries, applies harness-specific filters (storage sources, workspace subpaths, instruction file patterns), and returns `ICustomizationItem[]` with `storage` set from the authoritative promptsService metadata. Used as the default item provider for harnesses that don't supply their own.

- **`customizationHarnessService.ts`** (common layer) — Defines `ICustomizationItem`, `ICustomizationItemProvider`, `ICustomizationDisableProvider`, and `IHarnessDescriptor`. A harness descriptor optionally carries an `itemProvider`; when absent, the widget falls back to `PromptsServiceCustomizationItemProvider`.

- **`promptMigration.ts`** — Shared prompt-file migration utilities used by the management editor: prompt-to-skill content conversion, source-folder selection, collision-safe skill naming, and the per-file migrate/write/delete workflow with partial-failure reporting.

### MCP server list active-session controls

The MCP Servers tab merges local/workspace MCP configuration with MCP servers reported by the active agent-host session. When a listed server also exists in the active session, row status follows the session-backed server and lifecycle controls (start/stop) target the agent host. Model-access and sampling-log actions are hidden for session-backed rows because those are not inline session controls. Runtime states render as semantic colored icons rather than text badges: running uses a green check, while stopped has no visual icon. Authentication-required rows expose an inline **Sign In** button, and an actionable error icon opens that server's local or agent-host output.

For agent-host sessions, the client publishes every known plugin and VS Code-owned MCP server with an explicit global decision derived only from the VS Code profile. The host owns durable workspace and session decisions and resolves their effective enablement. Bundled MCP servers carry their decision by child name because the host discovers them from the synthetic plugin's `.mcp.json`. A session action dispatches only a session decision; the temporary non-session action dispatches a global decision until the full scoped action matrix is available.

### Structured Detail Preview

For markdown-backed customizations (`.agent.md`, `SKILL.md`, `.instructions.md`, `.prompt.md`), the management editor opens a **structured preview** by default instead of showing the raw file immediately.

- The preview parses the file with `PromptFileParser`
- Header metadata is rendered as labeled rows
- Each row includes an inline help affordance whose hover text comes from `getAttributeDefinition(...)`
- The markdown body is rendered via `IMarkdownRendererService`
- A header button switches between the structured preview and the raw editor/viewer

Hooks and other non-markdown detail views continue to open directly in their existing raw/detail experiences.

### AgenticPromptsService (Sessions)

Sessions overrides `PromptsService` via `AgenticPromptsService` (in `promptsService.ts`):

- **Discovery**: `AgenticPromptFilesLocator` scopes workspace folders to the active session's worktree
- **Built-in skills**: Discovers bundled `SKILL.md` files from `vs/sessions/skills/{name}/` and surfaces them with `PromptsStorage.builtin` storage type
- **User override**: Built-in skills are omitted when a user or workspace skill with the same name exists
- **Creation targets**: `getSourceFolders()` override replaces VS Code profile user roots with `~/.copilot/{subfolder}` for CLI compatibility
- **Hook folders**: Falls back to `.github/hooks` in the active worktree

### Built-in Skills

All built-in customizations bundled with the Sessions app are skills, living in `src/vs/sessions/skills/{name}/SKILL.md`. They are:

- Discovered at runtime via `FileAccess.asFileUri('vs/sessions/skills')`
- Tagged with `PromptsStorage.builtin` storage type
- Shown in a "Built-in" group in the AI Customization tree view and management editor
- Filtered out when a user/workspace skill shares the same name (override behavior)
- Skills with UI integrations (e.g. `act-on-feedback`, `generate-run-commands`) display a "UI Integration" badge in the management editor

#### Enabling and Disabling Built-in Skills

The **Enable** / **Disable** actions on a built-in skill persist to `IPromptsService.setDisabledPromptFiles(PromptsType.skill, …)` (profile-scoped storage). This is a distinct store from the per-harness auto-sync opt-out owned by `ICustomizationSyncProvider`, which the Plugins section writes.

The two stores are consulted at different points, and deliberately not identically:

- **The wire** honors *both*. `enumerateLocalCustomizationsForHarness` marks a file disabled when either store opts it out, so a disabled skill is excluded from the synthetic Open Plugin bundle and never reaches the agent host.
- **The list** derives `enabled` from the prompts-service store *only*. `mergeBuiltinSkills` ignores the sync-provider store because that store holds **plugin** URIs — its sole writer is the Plugins section checkbox, and `isDisabled` matches URIs exactly rather than by containment — so it can never opt out an individual built-in skill. If a per-file sync opt-out is ever added, this derivation must account for it; otherwise a skill dropped from the wire would be re-listed as enabled, and the **Enable** action (which writes only the prompts store) could not correct it.

Two places must consult the prompts-service store for the toggle to take effect on an agent-host harness:

- **The wire.** As above — the skill is excluded from the bundle.
- **The list.** Because a disabled skill is no longer in the bundle, the agent-host item provider stops reporting it. `PureItemProviderItemSource` therefore merges built-in skills in from `IPromptsService.listPromptFilesForStorage(skill, builtIn)` (via the shared `mergeBuiltinSkills` helper, deduped by URI against provider rows) and derives their `enabled` state from `getDisabledPromptFiles`. This keeps a disabled built-in listed — greyed out, with an **Enable** action — instead of vanishing with no way to restore it. Its `onDidAICustomizationItemsChange` includes `onDidChangeSkills` so the row updates immediately.

`ItemProviderItemSource` (non-agent-host harnesses) uses the same helper, so both paths group, dedupe, and gate built-ins identically.

##### Scope: only built-in skills may be hidden by the user-disabled store

The wire consults `getDisabledPromptFiles` **only** for the `(type, storage)` combination the Customizations UI can re-enable, expressed by `isUserToggleableCustomization` in `chat/common/promptSyntax/service/promptsService.ts`. Both the management editor and the sessions tree view register their Enable/Disable actions solely for built-in skills, so that is the only toggleable combination today.

This gate is load-bearing rather than cosmetic. `getDisabledPromptFiles` is a shared store that the chat view agent picker also writes for `PromptsType.agent` ("hidden from agent picker"). Because callers drop opted-out files from the bundle entirely and the Agents-window lists are derived from that bundle, honoring the store for a customization the Customizations UI cannot re-enable would strand it: the row disappears, and the **Enable** action that would bring it back is only rendered for rows that are still listed. The agent picker is unaffected — it owns its own unhide affordance and does not read from the bundle.

Consequently, the wire gate and `mergeBuiltinSkills` must be kept in sync: anything the wire is allowed to hide must have a corresponding restore path in the list.

### UI Integration Badges

Skills that are directly invoked by UI elements (toolbar buttons, menu items) are annotated with a "UI Integration" badge in the management editor. The mapping is provided by `IAICustomizationWorkspaceService.getSkillUIIntegrations()`, which the Sessions implementation populates with the relevant skill names and tooltip descriptions. The badge appears on both the built-in skill and any user/workspace override, ensuring users understand that overriding the skill affects a UI surface.

### Count Consistency

Counts shown in the sidebar (per-link badges and the header total in `AICustomizationShortcutsWidget`) are driven by the same `IAICustomizationItemsModel` singleton (`workbench/contrib/chat/browser/aiCustomization/aiCustomizationItemsModel.ts`) that feeds the customizations editor's list widget. The model owns the per-active-harness `ProviderCustomizationItemSource` cache and exposes per-section `IObservable<readonly IAICustomizationListItem[]>`; sidebar consumers `read` `.length` from those observables. There is exactly one discovery path, so editor and sidebar counts cannot diverge. McpServers use `IMcpService.servers` directly. Plugins use `IAICustomizationItemsModel.getPluginCount()`, which combines locally installed plugins from `IAgentPluginService.plugins` with plugin rows supplied by the active remote customization provider.

Provider-supplied customization rows that include an explicit storage origin are treated as authoritative even when no local URI inference is available. In particular, `storage: PromptsStorage.plugin` keeps AHP remote host plugin customizations out of the User group when no local `pluginUri` exists, and `storage: BUILTIN_STORAGE` keeps provider-supplied built-ins in the Built-in group.

### MCP Active Session Status

The MCP Servers section combines locally known MCP servers with MCP servers reported by the active agent-host session (`IAgentHostCustomizationService.getMcpServers(activeSessionResource)`). Active-session servers are matched to known workspace, user, extension, plugin, or built-in rows by stable identifiers and display names so the row can show the active session's status, matching `MCP: List Servers`. Active-session servers that do not match any known local/runtime server are appended to the **Workspace** group and counted with the rest of the section.

The MCP list uses `WorkbenchList` as its sole scroll owner. Layout uses the widget's rendered content-box dimensions rather than the padded panel's outer dimensions, and the virtual delegate height matches each rendered row variant, including the taller two-line description row. These invariants keep the final row fully reachable at the bottom of the list.

### Sidebar Customizations Section

The Agents sidebar `AICustomizationShortcutsWidget` appears as a collapsible, vertically resizable section below the sessions list. Its resize sash is the horizontal separator above the section and uses the same `SplitView` styling as the Checks section in the changes view, with a 4px separator and sash inset on each side. The section's expanded minimum height is 129px, while its initial and maximum height are capped to the rendered content height so the pane does not open with empty space. When collapsed, the section shrinks to its header height and shows the total customization count to the left of the hover-revealed chevron. The collapsed/expanded state is persisted per profile (`StorageScope.PROFILE`) and restored on reload. New profiles start **collapsed** so the sessions list keeps the height; expanding once stores that choice.

The first sidebar entry is `Overview`, which opens the AI Customization management editor welcome page. The remaining per-category rows deep-link directly to their corresponding management editor section. All entries keep the active customization harness in sync with the active session before opening the editor.

### Item Badges

`IAICustomizationListItem.badge` is an optional string that renders as a small inline tag next to the item name. For context instructions, this badge shows the raw `applyTo` pattern (e.g. a glob like `**/*.ts`), while the tooltip (`badgeTooltip`) explains the behavior. For skills with UI integrations, the badge reads "UI Integration" with a tooltip describing which UI surface invokes the skill. The badge text is also included in search filtering.

### Embedded Detail Editors

The management editor opens inline detail panes for prompt files, MCP servers, and plugins. Prompt-file details use the standard text editor pane. MCP and plugin details render dedicated compact widgets — `EmbeddedMcpServerDetail` and `EmbeddedAgentPluginDetail` — purpose-built for the narrow split-pane host. They show the icon, name, scope/source, and description. Do **not** embed the full extension-editor panes inside the split-pane host: they assume a wide page-level layout and don't shrink cleanly.

The MCP detail fixture in `src/vs/workbench/test/browser/componentFixtures/sessions/aiCustomizationManagementEditor.fixture.ts` must open a real server row (not a group header) and use a local server with concrete config so the compact widget's scope/description rendering is covered by screenshots.

### Debug Panel

Toggle via Command Palette: "Toggle Customizations Debug Panel". Shows a diagnostic view of the item pipeline:

1. **Provider data** — items returned by the active `ICustomizationItemProvider`
2. **After filtering** — what was removed by storage source and workspace subpath filters
3. **Widget state** — allItems vs displayEntries with group counts
4. **Source/resolved folders** — creation targets and discovery order

## Key Services

- **Prompt discovery**: `IPromptsService` — parsing, lifecycle, storage enumeration
- **MCP servers**: `IMcpService` — server list, tool access
- **Active worktree**: `IActiveSessionService` — source of truth for workspace scoping (sessions only)
- **File operations**: `IFileService`, `ITextModelService` — file and model plumbing

Browser compatibility is required — no Node.js APIs.

## Feature Gating

All commands and UI respect `ChatContextKeys.enabled`.

### Commands

| Command ID | Purpose |
|-----------|---------|
| `aiCustomization.openManagementEditor` | Opens the management editor, optionally accepting an `AICustomizationManagementSection` to deep-link |
| `aiCustomization.openMarketplace` | Opens the management editor with marketplace browse mode active. Accepts an optional section (`mcpServers` or `plugins`); defaults to `mcpServers` |

## Settings

User-facing settings use the `chat.customizations.` namespace. Currently, no settings are exposed for the management editor.
