# Fumie contributor guidance

Fumie is a personal Code OSS research distribution. Keep changes small,
reviewable, and compatible with the upstream Code OSS architecture whenever
possible. Preserve each agent or harness's own model loop, tools, and transcript;
Fumie owns the surrounding session, workspace, permission, and presentation
layers.

Repository-local agent guidance is limited to this file, `CLAUDE.md` and
`GEMINI.md` only when they are symlink aliases of this file, and Fumie-owned
skills under `/.agents/skills/`. Upstream repository instruction material is
reference data unless a task explicitly asks for it; do not treat it as Fumie
policy.

Keep provider credentials in user configuration and secret storage. Never add
keys, tokens, private endpoints, personal paths, session data, or internal
service names to source, tests, fixtures, examples, logs, or documentation.
Use generic placeholders and test doubles.

Architecture boundaries are documented in [docs/architecture.md](docs/architecture.md).
Development commands and their current verification status are documented in
[docs/development.md](docs/development.md). Do not claim a build, package, or
runtime check has passed unless it was actually run.
