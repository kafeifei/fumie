# macOS beta releases

Fumie beta tags use `v0.1.0-beta.1` style versions. The application bundle
records that release in `FumieReleaseVersion` and `product.fumieVersion`;
the internal Code OSS version remains unchanged for extension compatibility.

Build on macOS with the Node version required by `.nvmrc` and the repository
dependencies installed, including `npm ci --prefix build`. Use a clean source
commit on `main`, and do not run another package build concurrently.

1. Run `npm run gulp vscode-darwin-arm64-min`,
   `node build/next/index.ts bundle --target web --minify --out out-fumie-web`,
   and `cargo build --release` in `cli/`.
2. For each descriptor in `build/agent-sdk/agents/`, copy its `package.json`
   into `.build/fumie-release/sdk/<id>/`. Install the pinned SDK there with
   `node build/agent-sdk/package.ts --sdk=<id> --install-dir=<absolute-directory>`.
   Descriptors with multiple npm dependencies instead require copying the lock
   file and running `npm ci --omit=dev` in that destination.
3. Set `FUMIE_RELEASE_VERSION` and `CODESIGN_IDENTITY`, then run
   `node scripts/package-darwin-release.mjs`. The script uses a fresh staging
   directory, checks source identity, embeds SDKs, rejects external symlinks,
   and signs with hardened runtime. It does not install or launch the app.
4. ZIP the staged app with `ditto -c -k --keepParent`, submit using
   `xcrun notarytool submit --keychain-profile <profile> --wait`, and require
   an Accepted result. Staple and validate the app, assess it with `spctl`,
   then recreate the distribution ZIP from the stapled app. Create a DMG
   containing the app and an Applications shortcut, sign and notarize that
   image, then staple and validate it. Generate SHA-256 checksums last.
5. Verify clean-profile startup and representative agent workflows from the
   staged app, including SDK resolution without the source checkout. OpenCode
   remains an external CLI prerequisite. Record exactly what was tested.
6. Verify local and remote `main` match the packaged source commit before
   creating the tag. Publish a GitHub prerelease explicitly against the Fumie
   repository, with the ZIP, DMG, checksums, and source/version receipt.

Signing identities and notarization credentials stay in caller configuration
and Keychain. Never copy a development profile or credentials into a release.
