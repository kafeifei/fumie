# Development

Use Node.js at the version in `.nvmrc` (or a newer patch of the same major), npm,
and the [Code - OSS build prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute).

```sh
npm ci
npm run build-fast
npm run typecheck-client
./scripts/code.sh --agents
```

The source application uses the Fumie identity and its own profile. To run an
isolated UI check, pass a temporary `--user-data-dir`, `--shared-data-dir`, and
`--extensions-dir`, and set `FUMIE_HOME` to a temporary directory.

Focused Node tests accept source paths:

```sh
npm run test-node -- --run src/vs/platform/agentHost/test/node/claudeModelSelection.test.ts
```

Tests that require native modules built for Electron should use the development
Electron executable with `ELECTRON_RUN_AS_NODE=1` and `test/unit/node/index.js`.
Browser tests use `npm run test-browser-no-install -- --browser chromium --run
<source-test-path>` after the matching Playwright browser has been installed.

The macOS packaging entry point is `scripts/build-darwin-debug-app.sh`. It builds
and installs a local development app; choose an explicit `--output` and
`--profile` when testing. Source validation and an installed package are
separate checks. Other platforms retain upstream build entry points and need
platform-specific validation.

Agent SDK pins live in `build/agent-sdk/agents/`. Generated SDK installations,
credentials, local profiles, and logs stay outside Git. Configure models through
**Settings → Models**; see [Providers](providers.md).

Some upstream prompt and simulation suites use Git LFS fixtures. Fetch the
required objects from the Code - OSS upstream before running those suites;
a pointer file alone is not a usable fixture. These fixtures are separate from
the source build prerequisites.
