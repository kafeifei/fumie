# Kimi Agent Host provider

This provider adapts a Kimi-compatible SDK to the Agent Host. The SDK is kept
in the host process so the same provider boundary can serve local and remote
host modes while Fumie owns session state, permissions, workspaces, and the
user-facing projection.

The upstream SDK is not necessarily published as an npm package. When a local
source build needs it, the SDK manager resolves the pinned upstream source into
the ignored build directory. The generated SDK tree is not committed. This is
a packaging detail and does not authorize publishing private source, access
credentials, or organization-specific service configuration.

The provider receives configured models through the normal user-owned provider
catalog and secret storage. When Codex has an active ChatGPT subscription, it
also exposes that subscription catalog and uses the Kimi SDK's native OpenAI
Responses provider through Fumie's authenticated loopback proxy. The proxy
borrows current credentials for each request; Kimi never persists them. Keep
local SDK roots and credentials outside the repository and use generic
placeholders in examples.

The provider advertises only capabilities implemented end to end. Unsupported
forking, subagent, or tool behavior should remain hidden or return a clear
capability error until its Agent Host mapping and replay behavior are ready.
