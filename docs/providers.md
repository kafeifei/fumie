# Providers and model configuration

Fumie presents agent and model as separate choices. A new session selects an
agent first; the model list is then filtered to models compatible with that
agent. After the first message creates a session, the agent remains fixed while
the model or reasoning effort can follow the provider's capabilities.

Claude Subscription and Codex Subscription are added to each profile by default.
Sign in through their provider rows in **Settings → Models**; their models appear
when the native agent publishes its account-backed catalog. Existing provider
names and settings are preserved. Removing either subscription provider keeps it
removed across restarts; it can be added again through **Add Models**.

All bundled agents are enabled by default. An explicit disabled setting is
preserved. Native runtime setup and agent-owned account sign-in retain their
existing flows where those account boundaries still apply.

The account menu separates GitHub sign-in for remote control, ChatGPT sign-in
for OpenAI models, and Claude sign-in for Claude. Claude has its own sign-out
action. ChatGPT credentials remain owned and refreshed by Codex; Copilot, Kimi,
DeepSeek, Pi, and OpenCode can also use that subscription through their native
Responses support. These model rows follow the shared ChatGPT sign-in state.
OpenCode only exposes models injected from Fumie's Provider catalog; its own
auto-loaded provider catalog is not projected into Fumie's model picker. Its
first managed launch copies the native OpenCode database into
`$FUMIE_HOME/providers/opencode/opencode.db`, removes the native OpenCode account
and active organization from that copy, and preserves existing transcripts and
tool-integration state. The two databases then evolve independently. Hiding all
compatible Provider models still allows old transcripts to be read, but new
turns are rejected until a compatible model is visible again.
Claude, including the Claude ACP adapter, keeps its native Claude account and
model boundary. Each harness exposes only the reasoning options its SDK can
send, and provider API keys remain a separate model source.

Provider configuration belongs to the upstream language-model catalog and the
user's settings and secret storage. A provider may be a local service, a
custom endpoint, or an account-backed integration. Fumie should project that
catalog into agent pickers rather than maintain a second hidden catalog.

Provider metadata is the source of truth for compatibility, wire format,
context limits, tool support, and reasoning options. Consumers must not infer
these properties from a model name or silently switch agents when a model is
selected.

Credentials stay behind the provider boundary. Harnesses receive only the
minimum short-lived or local connection information needed for a turn; keys
must not be placed in command arguments, logs, source files, or examples.

The implementation is experimental and may change with upstream Code OSS and
provider SDK releases. Update this document only when the user-visible
configuration or ownership contract changes.
