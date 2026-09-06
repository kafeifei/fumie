# Mobile Diff Boundaries

This document describes the mobile file diff and multi-file diff editor design
used by the Agents Window.

- Mobile review uses phone-native full-screen overlays and unified diffs, not
  desktop editor panes or side-by-side layouts.
- `MobileDiffView` owns a single-file surface; `MobileMultiDiffView` owns the
  continuous multi-file review surface.
- Keep the mobile payload independent of desktop multi-diff workbench types.
- Multi-file review preserves two virtualization ownership layers: file sections
  and the rows within a loaded file body.
- A file's full body height remains represented in the outer scroll range.
  Native CSS owns sticky headers; JavaScript must not reposition them per frame.
- Visible file bodies must always have stable content or a loading placeholder.
  Background prefetch must not outrank visible work or mount hidden DOM.
- Async reads and rendering must not publish into disposed or superseded views.
- Height accounting must remain deterministic as bodies load so scrolling does
  not jump.

Stop and discuss before importing desktop layout ownership, replacing native
scroll/sticky behavior with per-frame control, or removing either
virtualization boundary.
