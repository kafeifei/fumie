# Architecture

Fumie is a Code OSS distribution with a session-first multi-agent workbench.
It hosts several native agent harnesses while keeping each harness responsible
for its model loop, tools, and transcript. Fumie owns the surrounding shell:
sessions, workspaces, changes, permissions, model selection, and layout.

The guiding rule is **represent, don't orchestrate**. The host records the
state and capabilities exposed by a harness and routes user actions to it. It
does not implement a second model loop or a second transcript renderer.

The Agents Window uses the upstream chat surface as its transcript base. Fumie
may provide its own chrome, session navigation, and theme, while content such
as markdown, tool output, reasoning, and diffs should continue to use the
shared rendering contracts.

Provider-specific behavior belongs in provider-owned adapters and metadata.
Shared UI consumes capabilities and stable event kinds; it should not branch
on private provider names or model-name guesses. Provider configuration and
credentials remain user-owned catalog data, as described in
[Providers and model configuration](providers.md).

## Code map

| Area | Location | Responsibility |
| --- | --- | --- |
| Agent host | `src/vs/platform/agentHost/` | Harness adapters, protocol state, and SDK integration |
| Session persistence | `src/vs/platform/agentHost/node/fumie/` | Session catalog, lifecycle, and worktree services |
| Agent workbench | `src/vs/sessions/` | Session navigation, composer, settings, and workspace views |
| Shared chat surface | `src/vs/workbench/contrib/chat/` | Upstream transcript and tool rendering |
| SDK/build tooling | `build/agent-sdk/`, `scripts/` | Dependency pins, source launch, and local packaging |
| Browser/mobile entry | `mobile-entry/` | Optional web entry for remote-host experiments |

Fumie keeps its data under `FUMIE_HOME` (default `~/.fumie`); the Electron profile
uses the operating system's Fumie application-data directory. Harnesses retain
ownership of their native model loops and transcript formats.
