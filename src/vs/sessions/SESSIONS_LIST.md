# Sessions list

> **Specification change gate:** Do not update this document for row rendering,
> styling, actions, picker flows, or bug fixes. Update it only when placement
> precedence, state ownership, or a cross-surface list contract changes.

## Scope

The Sessions list is the primary navigation surface in the Agents Window. It
aggregates provider-neutral sessions into a grouped, filterable tree and owns
user presentation state such as pins, ordering, and collapsed sections.

This specification defines stable placement and state-ownership rules. Row
styling, labels, icons, action placement, animation, picker workflows, and
implementation algorithms belong in code and focused tests.

When `chat.omni.enabled` is enabled, the WORKSPACES header toolbar includes a `Codicon.arrowCircleUpSparkle` action that toggles the floating chat input window.

| Concern | Owner |
|---------|-------|
| Session catalog and lifecycle | `ISessionsManagementService` |
| Pin and per-sort ordering state | `ISessionsListModelService` |
| Workspace section order | `ISessionSectionOrderService` |
| Tree composition and presentation | `SessionsView` and `SessionsList` |

| File | Purpose |
|------|---------|
| `contrib/sessions/browser/views/sessionsView.ts` | `SessionsView` — ViewPane with sidebar nav, WORKSPACES header, find, sort/group/filter persistence |
| `contrib/sessions/browser/views/sessionsList.ts` | `SessionsList` — tree control, grouping/filtering logic, menu IDs, context keys |
| `services/sessions/browser/sessionsListModelService.ts` | `ISessionsListModelService` — pin/sort state + shared status icon (UI-only, not synced to providers) |
| `services/sessions/browser/sessionSectionOrderService.ts` | `ISessionSectionOrderService` — manual order of workspace sections and workspace promotion (UI-only) |
| `contrib/sessions/browser/views/sessionsViewActions.ts` | All registered actions (sort, group, filter, pin, archive, rename, navigate) |

## Inputs

The desktop sidebar chrome is a vertical **New Chat / Automations / Customize** nav (icon + label, no primary button), then a **WORKSPACES** section header carrying the three icon actions **New Chat**, **Search**, and **Filter** (in that order), then the sessions list. Search opens the existing find widget below the header; Automations opens the Automations custom view; Customize opens the AI Customizations overview. Opening search does not replace the nav. Automations is always shown in this chrome; scheduled dispatch remains gated on `chat.automations.enabled`.

---

Automation runs are excluded from the primary Sessions list. Surfaces that need
session-row presentation without sectioning use `SessionsFlatList`.

## Placement precedence

A session appears in exactly one primary section. Higher-precedence states win:

- **Status icon** — animated indicator for InProgress / NeedsInput / Error / Completed / Unread; unread takes precedence over completed-state glyphs such as a pull request, while quick chats never show a PR glyph (they have no GitHub PR association) and no per-row chat icon is shown either (Pinned or the surrounding workspace/date section already conveys identity)
- **Title** — the session's display title (observable)
- **Type icon** (regular sessions only) — folder/worktree/cloud icon indicating the workspace kind; omitted for quick chats
- **Workspace in the accessible name** — the workspace label is not rendered as a visual element in the row (the details row shows only the provider icon, status description, and compact timestamp); it is instead appended to the row's accessible name as `, in <workspace>` whenever the surrounding row/section doesn't already convey it: always when grouping by date, and when grouping by workspace only for Pinned and Done rows (an ordinary workspace-grouped row already sits under a section header naming that workspace). It is omitted for quick chats (no workspace) and whenever live status hides row details (InProgress/NeedsInput).
- **Diff stats** (regular sessions only) — `+insertions −deletions` when the session has pending changes; omitted for quick chats
- **Status description or timestamp** (regular sessions only) — InProgress/NeedsInput/Error show a status message, otherwise a compact relative timestamp (`5m`, `2h`, `1d`, `Jan 12`, or `Jan 12, 2023` once the date crosses into an earlier year; future timestamps clamp to `1m`); quick chats show none of this (their compact spinner status icon already conveys "in progress", and diff stats/timestamps are omitted for their more compact row)
- **Approval row** (optional) — pending agent approvals with an "Allow" button
- **Inline actions** (hover/selected on desktop, always on mobile) — pin, archive/mark as done, and rename as compact icon buttons overlaid on the right of the row. They are not in the title/time flex flow, so they stay clickable inside the fixed-height virtual list row. Hover/selection also reserves right padding and disables pointer events on the faded details row so the time/meta cannot intercept Archive clicks. They stay available from the right-click context menu. Filter/Group/Sort stay on the WORKSPACES header Filter icon.

Quick-chat rows (`.session-item.quick-chat`, driven by the reactive `ISession.isQuickChat` observable) are single-line entries: the details (second) row is hidden entirely and its content is never built — smaller icon, one line of title only, tighter row height (see `SessionsTreeDelegate.ITEM_HEIGHT_QUICK_CHAT`). Regular sessions keep the standard two-line row (title + details row).

Continuous row animations preserve their existing appearance while limiting rendering work: the title shimmer follows the same three-second path with at most 30 visual updates per second, then rests for three seconds before repeating. Both it and the shared pixel spinner pause outside the viewport and whenever their document is hidden, while their visibility tracking survives temporary row-template detachment. Status icons cross-fade only for state changes within the same session; when virtualization rebinds a row template to another session, the new icon renders immediately so stale status is never shown.

`SessionsFlatList` reuses the same session row renderer for sectionless surfaces, including the approval row and dynamic row height updates. Consumers that size their own container listen for content-height changes and relayout the list. When embedded inside another hover, consumers disable row hovers so moving over the list does not replace the parent hover.

### Grouping

Sessions are organized into sections with fixed priority:

```
1. Pinned        ← always first, not reorderable
2. Regular       ← grouped by workspace, date, or agent
3. Done/Archived ← always last, not reorderable
```

Workspace-less **quick chats** are detected via the `isQuickChatSession(session)` helper (which reads the session's own `ISession.isQuickChat` observable — **not** `workspace === undefined`, which can be transiently undefined for workspace-bound sessions too). They are **not** a dedicated list section: there is no Chats header, no empty Chats shell, and no **"No chats"** placeholder — including when a provider advertises `supportsQuickChats`. A pinned quick chat still appears in Pinned (pin wins), and an archived one still goes to Done (archive wins). Otherwise they render as ordinary rows in the current grouping (the **Unknown** workspace when grouping by workspace; the matching calendar bucket when grouping by date). **New Quick Chat** remains available from the Command Palette and **Cmd+K Cmd+N**; Cmd+N always creates a new **session**, not a quick chat. Quick-chat rows never show a per-row chat/PR glyph as their **status icon**, have no type icon in the details row, never include the workspace in their accessible name, and carry no diff stats/timestamp (see Session Row above). The Pinned section header carries a **leading icon** (`Codicon.pinned`).

The active session remains visible even when a filter would otherwise exclude
it.

## Grouping

- **By Date** (default for new profiles; stored `sessionsViewPane.grouping` is still honored) — sessions fall into the fixed calendar sections **Today**, **Yesterday**, **Last 7 days**, and **Older**. Empty buckets are omitted and there is no per-bucket cap.
- **By Workspace** — one section per workspace label, in a single freely-reorderable user-managed order below Pinned. Workspaces default to newest-project-first until the user drags them. A workspace header includes a **Create Session from Pull Request** icon action unless the section is backed only by `github-remote-file` cloud workspaces. The Quick Pick opens immediately in a disabled busy state while repository identity resolves. Identity comes from hydrated session metadata when available; otherwise the action opens the checkout through `IGitService`, waits for its repository-state remotes to hydrate, and parses the GitHub remote. Closing the picker cancels that wait. The picker then runs fresh Waiting for My Review and Assigned to Me queries in parallel with the lightweight first-100 catalog query. Each group query returns complete rows, so Waiting can render without waiting for the full catalog; groups append in final display order so visible entries never move during enrichment. PRs that already have a local or remote-host checkout session are excluded; an existing `github-remote-file` cloud-agent session does not prevent creating a separate worktree session for the same PR. Typing a query that matches none of the loaded entries fetches subsequent pages until a match is found or the catalog is exhausted. After selection, the picker remains busy while it loads the PR details and all paged file patches, issue comments, and review comments and waits for the folder to advertise a worktree-capable session type; Escape cancels this wait. The provisional session then activates immediately and starts a worktree that tracks the PR head branch. The initial request and response are retained as hidden model context, while the PR JSON appears as a one-time context pill that moves into the first visible request.

Section order is user-managed only in workspace grouping, where it is owned by
`ISessionSectionOrderService`. Date and agent sections keep their fixed order.

### Quick chats

Quick chats are identified through `ISession.isQuickChat`, not by checking for
an absent workspace. They remain session rows; the list never exposes `IChat`
objects as top-level rows.

### Archived sessions

Archived sessions always render in the Done section, whatever the grouping mode.
User-facing archive terminology may vary, but the underlying archived state and
placement rule do not.

## Durable user intent

Pin and ordering state survives temporary provider-catalog removal.
Providers may transiently publish incomplete catalogs while reconnecting or
hydrating, so `onDidChangeSessions.removed` is not proof of deletion.

List-owned state is removed only when:

- the management service reports definitive deletion;
- the user explicitly changes or removes the state.

Stale entries that match no current session are inert and may be compacted by
their owning service.

## Sorting and filtering

The list supports created-time and updated-time sorting. Manual ordering stores
list-owned sort keys for each mode without changing provider timestamps.

Filters compose across session type, status, archive/read state, and provider.
The find widget matches session and section labels and bypasses presentation
capping while a search is active.

## Drag and drop

Drag and drop changes only list-owned presentation state or opens sessions
through the appropriate service:

- sessions may reorder within valid sections;
- non-archived sessions may move into the pinned section;
- workspace sections may reorder in workspace grouping;
- dropping sessions on the Sessions grid opens them through `ISessionsService`.

The **Pinned** section starts **collapsed on first open** (its default collapse state is `PreserveOrCollapsed` when no saved state exists). Once the user expands or collapses it, that choice is persisted per-section under `sessionsListControl.sectionCollapseState` and honored on subsequent loads.

## Reactive presentation

Rows derive title, status, workspace, changes, capabilities, and quick-chat
identity from session observables. Renderers must support tree virtualization:
reusing a row template for another session must not retain stale state,
animations, hovers, or disposables.

Row renderers use tree-supported row classes and APIs rather than traversing
tree-owned DOM structure.

## Persistence

- **Storage** — reordering stores a synthetic numeric *sort key* per session in `ISessionsListModelService` (persisted locally, not synced). It is used **only** for sorting; the provider's real `createdAt`/`updatedAt` are never modified. A separate override map is kept for each sort mode (Created vs Updated).
- **Sort key** — on drop, the new key is the midpoint between the effective keys of the sessions immediately above and below the drop point. Dropping above the first session uses the current time (so it sorts to the top). Dropping below the last session steps below the last key.
- **Dropping the fake value** — if a session's natural timestamp already sorts it into the dropped slot (e.g. after dragging it down and back), the stored override is removed so the list falls back to natural ordering.
- **Grouping by Date** — the regular list is one continuous sequence, so dragging can move a session across date buckets (e.g. to the top makes it "Today").
- **Grouping by Workspace** — reordering is restricted to within the same workspace group; drops onto another workspace are rejected.
- **Pinned** — dropping a non-archived session on the Pinned header pins it and lets it sort naturally. Dropping it on a pinned session shows an insertion line, pins it, and stores the sort key needed to place it at that location.
- **Scope** — archived (Done) sessions do not reorder. Drops onto the Done section, unsupported section headers, and "show more" rows are rejected.
- **Multi-selection** — dragging multiple selected sessions moves them as a contiguous block, preserving their relative order. The drag label reads `"N sessions"`. Dragging sessions into the sessions grid opens all of them.

## Change policy

Update this specification only when placement precedence, state ownership, or a
cross-surface list invariant changes. Express concrete row behavior, menu
enablement, picker flows, and regressions in focused tests instead.

## Related specifications

The insertion line relies on the base list widget's `drop-target-before`/`drop-target-after` feedback (colored by `list.dropBetweenBackground`). The widget converts an "after" indicator on row *i* into a "before" indicator on row *i+1*, so hovering the bottom half of the upper row and the top half of the lower row render the exact same DOM line with no shift.

The session-row context menu is contributed through `SessionItemContextMenuId`; it is owned for the menu lifetime and disposed when it closes. Blank space, section headers, and "show more" rows have no context menu.

### Read / Unread

- Read/unread state is **owned by the sessions provider** and surfaced via `ISession.isRead`. Marking happens through `ISessionsManagementService.markRead` / `markUnread` / `markAllRead`, which route to the provider's `setSessionReadState`. The agent-host provider persists it via the protocol `IsRead` status bit; the Copilot Chat provider via its agent session model (`setRead`); the local chat provider via its persisted session metadata.
- For agent-host sessions the `IsRead` status bit is the only representation — the host persists it, publishes it on `SessionSummary.status`, and fans changes out to every connected client. The **editor window** shares that state via the item controller (`IChatSessionsService.canSetChatSessionItemRead` / `setChatSessionItemRead`), mirroring the archive bridge, so marking a session read in either window shows up in the other.
- Sessions start as **unread**
- A session becomes **read** when the user opens it or explicitly marks it
- Automation run history uses the linked session's `ISession.isRead` state directly. The Automations shortcut and run cards react to that observable, and **Mark All as Read** delegates to `ISessionsManagementService.markAllRead`; there is no separate automation-run read store.
- A session becomes **unread** when it produces new output in the background — a turn completes, is cancelled, or errors while the session is not being viewed. Each provider detects this and marks its own session unread: the agent-host provider server-side in `agentSideEffects`, the local chat provider via its tracked session model, and the Copilot Chat provider on the `InProgress` → terminal transition. `SessionsService` keeps the **active** agent-window session marked read, while `AgentSessionsModel` writes unsolicited unread state back to an owning provider when the session remains open in an editor-window chat widget. A deliberate **Mark as Unread** is preserved.
- Legacy view-level read state (previously persisted by `SessionsListModelService` under `sessionsListControl.readSessions`) is migrated once into provider ownership by `SessionsListModelService.migrateLegacyReadState`. The migration is additive — it only ever promotes a session to read (never back to unread) — and runs once per session. `AgentSessionsModel.migrateReadStateToProvider` does the same for the editor window's read timestamps.
- Pin/sort state is cleaned up when a provider reports a real session removal; remote agent host disconnects hide cached sessions without reporting them as removed

### Navigation

- **Clicking a session** marks it read and calls `SessionsManagementService.openSession()`
- **Double-clicking a rename-capable session title** opens the existing **Rename...** Quick Input after the first click opens the session. The title handler consumes the `dblclick` so it does not issue a second open. The gesture is gated live on `ISession.capabilities.supportsRename`, applies only to the main `SessionsList` (not `SessionsFlatList` consumers), and is limited to unmodified primary-button double-clicks on the rendered title text. Keyboard users can focus the row, open its context menu (for example with Shift+F10), and choose **Rename...**.
- **Active session tracking** — the list auto-scrolls to and selects the active session via an `autorun` on `activeSession`
- **Keyboard shortcuts** — `Ctrl/Cmd+1..9` opens sessions by index; `Ctrl/Cmd+PageUp` / `Ctrl/Cmd+PageDown` navigates the visible list (`Cmd+Alt+Left` / `Cmd+Alt+Right` and `Cmd+Shift+[` / `Cmd+Shift+]` on macOS); `Ctrl+Alt+-` / `Ctrl+Alt+Shift+-` for back/forward navigation
- **Mobile** — opening a session also closes the sidebar drawer

### Mobile

On phone layout (`IsPhoneLayoutContext`):

- Session rows are taller for touch targets; pin/archive icons are always visible (no hover)
- A **filter chips** row appears below the header with status toggles (Completed, In Progress, Failed) and a Sort chip
- Sort/Group options open as a **bottom sheet** instead of a menu

---

## Menu Entry Points

The sessions list defines menu IDs that contributions can target to add actions. All are exported from `sessionsList.ts` and `sessionsView.ts`.

### Session Item Menus

| Menu | Constant | Where it appears | Use for |
|------|----------|------------------|---------|
| `SessionItemToolbar` | `SessionItemToolbarMenuId` | Compact pin / archive / rename icons on each session row (hover on desktop, always on mobile) | Pin, archive/mark as done, and rename as inline icon buttons. The same actions remain on the context menu. Do not overflow these into a ⋯ popup. |
| `SessionItemContextMenu` | `SessionItemContextMenuId` | Right-click context menu on session rows | Secondary actions like rename, mark read/unread, and "Open Pull Request" (in the `navigation`/open group, gated on `sessionHasPullRequest`). Groups: `navigation`, `0_pin`, `0_read`, `1_edit`. |

### Section Header Menu

| Menu | Constant | Where it appears | Use for |
|------|----------|------------------|---------|
| `SessionSectionToolbar` | `SessionSectionToolbarMenuId` | Toolbar on section headers (Pinned, workspace sections, Done) | Section-scoped actions like "New Session for Workspace", GitHub-backed "Create Session from Pull Request", and the selected "Archive All"/"Mark All as Done" action. The Done section restores/unarchives sessions individually (or via multi-selection) rather than with a section-wide action. Section headers also show a collapsible chevron on hover/focus; the chevron uses the same ghost icon hover background token as toolbar icon buttons. |

### View Title Menus

| Menu | Constant | Where it appears | Use for |
|------|----------|------------------|---------|
| `SessionsViewPaneFilterSubMenu` | `SessionsViewFilterSubMenu` | Filter/sort dropdown in the view title bar | Sort, group, and workspace capping toggles. |
| `SessionsViewPaneFilterOptionsSubMenu` | `SessionsViewFilterOptionsSubMenu` | Nested under the filter sub-menu | Session type and status filter checkboxes. |

### Contributing an Action

Register an `Action2` and target one of the menu IDs above. Use the context keys (below) in `when` clauses to scope the action to the right sessions or sections.

```typescript
registerAction2(class MySessionAction extends Action2 {
    constructor() {
        super({
            id: 'myExtension.mySessionAction',
            title: localize2('myAction', "My Action"),
            menu: {
                id: SessionItemContextMenuId,
                group: '1_edit',
                when: ContextKeyExpr.equals('sessionType', 'my-session-type'),
            },
        });
    }
    run(accessor: ServicesAccessor, ...args: unknown[]): void {
        // action logic
    }
});
```

---

## Context Keys

Context keys available for `when` clauses when contributing to session list menus.

### Per-Session Item

| Key | Type | Description |
|-----|------|-------------|
| `sessionItem.isPinned` | boolean | Whether the session is pinned |
| `sessionIsArchived` | boolean | Whether the session is archived |
| `sessionIsRead` | boolean | Whether the session has been read |
| `sessionItem.hasBranchName` | boolean | Whether the session has a git branch name |
| `sessionType` | string | Session type ID (use to scope actions to specific providers) |
| `sessionProviderId` | string | Provider ID |
| `sessionHasPullRequest` | boolean | Whether the session is associated with a GitHub pull request |

### Per-Section

| Key | Type | Description |
|-----|------|-------------|
| `sessionSection.type` | string | `'pinned'`, `'archived'`, `'workspace:<label>'`, `'today'`, `'yesterday'`, `'last7days'`, `'older'`, etc. |
| `sessionSection.hasGitHubRepository` | boolean | Whether the workspace section contains a GitHub-backed repository. |
| `sessionSection.hasNonCloudRepository` | boolean | Whether the workspace section contains a folder not backed by the `github-remote-file` cloud scheme. |

The repository context keys are driven by an element-scoped autorun over each session's `workspace` and folder `gitHubInfo` observables, so toolbar availability updates when provider metadata hydrates after the section template first renders. A mixed section can obtain GitHub identity from its cloud session and the usable checkout from a separate non-cloud session in that same section; when no session has identity metadata, the action resolves it from the checkout's Git remotes.

### View-Level

| Key | Type | Description |
|-----|------|-------------|
| `sessionsViewPane.grouping` | string | Current grouping mode (`'date'`, `'workspace'`, or `'agent'`). New profiles default to `'date'`. |
| `sessionsViewPane.sorting` | string | Current sorting mode (`'created'` or `'updated'`) |
| `sessionsViewPane.workspaceGroupCapped` | boolean | Whether workspace and agent sections are capped or fully expanded |
