# macOS beta releases

Fumie beta tags use `v0.1.0-beta.1` style versions. The application bundle
records that release in `FumieReleaseVersion` and `product.fumieVersion`;
the internal Code OSS version remains unchanged for extension compatibility.

Build on macOS with the Node version required by `.nvmrc` and the repository
dependencies installed, including `npm ci --prefix build`. Use a clean source
commit on `main`, and do not run another package build concurrently.

1. Run `npm run gulp vscode-darwin-arm64-min`,
   `node build/next/index.ts bundle --target web --minify --out out-fumie-web`,
   and build `cli/` with static OpenSSL and the source commit embedded:
   `OPENSSL_STATIC=1 OPENSSL_DIR="$(brew --prefix openssl@3)" VSCODE_CLI_COMMIT="$(git rev-parse HEAD)" cargo build --release`.
   The OpenSSL prefix above is for Homebrew; another installation can supply its
   own prefix containing static libraries. Packaging rejects non-system dylib
   dependencies in the tunnel executable.
2. For each descriptor in `build/agent-sdk/agents/`, copy its `package.json`
   into `.build/fumie-release/sdk/<id>/`. Install the pinned SDK there with
   `node build/agent-sdk/package.ts --sdk=<id> --install-dir=<absolute-directory>`.
   Descriptors with multiple npm dependencies instead require copying the lock
   file and running `npm ci --omit=dev` in that destination.
3. Set `FUMIE_RELEASE_VERSION` and `CODESIGN_IDENTITY`, then run
   `node scripts/package-darwin-release.mjs`. The script uses a fresh staging
   directory, checks source identity, embeds SDKs, applies the same Copilot
   dependency pruning as Debug, rejects external symlinks,
   and signs with hardened runtime. It does not install or launch the app.
4. ZIP the staged app with `ditto -c -k --keepParent`, submit using
   `xcrun notarytool submit --keychain-profile <profile> --wait`, and require
   an Accepted result. Staple and validate the app, assess it with `spctl`,
   then recreate the distribution ZIP from the stapled app. Generate its
   SHA-256 checksum last. Publish one selected distribution format; compare
   equivalent ZIP/DMG candidates if choosing for download size.
5. Verify clean-profile startup and representative agent workflows from the
   staged app, including SDK resolution without the source checkout. OpenCode
   remains an external CLI prerequisite. Record exactly what was tested.
6. Verify local and remote `main` match the packaged source commit before
   creating the tag. Publish a GitHub prerelease explicitly against the Fumie
   repository, with the selected package. Include its checksum and source/version
   receipt in the release notes. Keep other build artifacts local.

Signing identities and notarization credentials stay in caller configuration
and Keychain. Never copy a development profile or credentials into a release.

For local size experiments, clone a staged app into a separate directory and run
`node scripts/prune-packaged-copilot.cjs <app>/Contents/Resources/app`. This changes
the bundle and invalidates its signature; sign the candidate again before runtime
validation. Compare dependency loads, extension activation, and agent workflows
with the baseline before treating the smaller candidate as release-ready.

Fumie omits the Copilot extension's `ChatSessionsContrib`, so its CLI/cloud
session providers do not register alongside Fumie's Agent Host providers.
This must be rebuilt before pruning `@github/copilot`: the Agent Host allowlist
alone does not disable the extension's separate registration path.

`prune-packaged-resources.cjs` removes source maps inside ASAR archives as well
as loose files, and trims foreign-platform prebuilds, declaration files and
non-runtime tests/docs from embedded SDKs. It preserves Mermaid, editor type
libraries, licenses, and Pi's runtime-referenced docs/examples. ASAR rewriting
preserves every non-map entry, including unpacked metadata and links.
