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

The provider receives model configuration through the normal user-owned
provider catalog and secret storage. It must not require a hard-coded model,
private inference service, shell key, or login state. Keep local SDK roots and
credentials outside the repository and use generic placeholders in examples.

The provider advertises only capabilities implemented end to end. Unsupported
forking, subagent, or tool behavior should remain hidden or return a clear
capability error until its Agent Host mapping and replay behavior are ready.
