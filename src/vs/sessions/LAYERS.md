# Sessions Layer Rules

> **Specification change gate:** Do not update this document for a bug fix that
> restores the existing import hierarchy. Update it only when the enforced
> layering contract intentionally changes.

This document describes the import layering rules for `src/vs/sessions/`, enforced by the `local/code-import-patterns` ESLint rule.

The sessions layer sits above `vs/workbench` in the VS Code source code hierarchy. For the broader VS Code layer rules (base → platform → editor → workbench → sessions), see `.github/instructions/source-code-organization.instructions.md`.

## Layer Hierarchy

```
┌─────────────────────────────────────────────────────┐
│  Entry Points                                       │
│  sessions.common.main.ts / .desktop.main.ts /       │
│  .web.main.ts / .web.main.internal.ts               │
│  (can import everything below)                      │
└──────────────────────┬──────────────────────────────┘
                       │
       ┌───────────────┼───────────────┐
       │               │               │
       ▼               ▼               ▼
┌────────────┐  ┌────────────┐  ┌────────────────┐
│ contrib/*  │  │ contrib/   │  │                │
│ (chat,     │  │ providers/ │  │  services/*    │
│  sessions, │  │ (agentHost,│  │                │
│  changes,  │  │  copilot,  │  │                │
│  ...)      │  │  remote)   │  │                │
└─────┬──────┘  └─────┬──────┘  └───────┬────────┘
      │               │                │
      │               │                │
      ▼               ▼                ▼
┌─────────────────────────────────────────────────────┐
│  sessions/~  (core: browser/, common/, electron-browser/) │
└─────────────────────────────────────────────────────┘
```

## Rules by Target

### `sessions/~` — Sessions Core

**Path:** `src/vs/sessions/{browser,common,electron-browser}/**`

The foundational layer. It may import from the sessions **services** layer, but not from any `contrib/` code above it.

**Can import from:**
- `vs/base/~`, `vs/base/parts/*/~`
- `vs/platform/*/~`
- `vs/editor/~`, `vs/editor/contrib/*/~`
- `vs/workbench/~`, `vs/workbench/browser/**`, `vs/workbench/services/*/~`
- `vs/sessions/~` (self), `vs/sessions/services/*/~`

> **Note:** The desktop bootstrap entry `src/vs/sessions/electron-browser/sessions.ts` has its own, **more restrictive** rule: it may import only `vs/base/~`, `vs/base/parts/*/~`, `vs/platform/*/~`, `vs/sessions/~`, and `vs/sessions/sessions.desktop.main.js`.

**Cannot import from:**
- ❌ `vs/sessions/contrib/*` — no contrib dependencies
- ❌ `vs/sessions/contrib/providers/*` — no provider dependencies

---

### `sessions/services/*/~` — Sessions Services

**Path:** `src/vs/sessions/services/*/{browser,common}/**`

Service layer sits alongside core. Provides shared service interfaces and implementations.

**Can import from:**
- Everything `sessions/~` can import (**except** `vs/workbench/browser/**`, which is not granted to services), plus:
- `vs/sessions/services/*/~` (sibling services)
- `vs/workbench/contrib/*/~`

**Cannot import from:**
- ❌ `vs/sessions/contrib/*` — no contrib dependencies
- ❌ `vs/sessions/contrib/providers/*` — no provider dependencies

---

### `sessions/contrib/*/~` — Contributions (non-provider)

**Path:** `src/vs/sessions/contrib/*/{browser,common}/**` (excluding `contrib/providers/`)

Feature contributions like `chat`, `sessions`, `changes`, `terminal`, etc.

**Can import from:**
- Everything `sessions/services/*/~` can import, plus:
- `vs/sessions/contrib/*/~` (sibling contributions)

**Cannot import from:**
- ❌ `vs/sessions/contrib/providers/*/~` — **providers are isolated from non-provider contribs**

---

### `sessions/contrib/providers/*/~` — Session Providers

**Path:** `src/vs/sessions/contrib/providers/*/{browser,common}/**`

Provider implementations (`agentHost`, `copilotChatSessions`, `remoteAgentHost`). These are the compute backends that register with `ISessionsProvidersService`.

**Can import from:**
- Everything `sessions/contrib/*/~` can import, plus:
- `vs/sessions/contrib/providers/*/~` (sibling providers)

This is the **most permissive** contrib layer — providers can reach into non-provider contribs and sibling providers, but not vice versa.

---

### Entry Points

| File | Layer | Notes |
|------|-------|-------|
| `sessions.common.main.ts` | `browser` | Shared contributions for all platforms |
| `sessions.desktop.main.ts` | `electron-browser` | Desktop-specific, imports `sessions.common.main.js` |
| `sessions.web.main.ts` | `browser` | Web-specific, imports `sessions.common.main.js` |
| `sessions.web.main.internal.ts` | `browser` | Internal web variant, imports `sessions.web.main.js` |

Entry points can import from all sessions layers: `sessions/~`, `services/*/~`, `contrib/*/~`, and `contrib/providers/*/~`.

### Entry-point reachability

The two entry points import their own registration files, so a registration the
web entry never reaches is a silent web-only defect: it compiles, the desktop app
works, and the browser gets an empty or missing UI.

`src/vs/sessions/test/browser/webEntry.smoke.ts` guards the user-facing side of
this. It imports `sessions.web.main.ts` — so it sees exactly the registrations
the web bundle ships — and walks the constructor-injection graph of the Settings
overlay, the sessions list and the new-session composer, failing with the widget
and the unregistered service by name. Run it on its own browser page:

```
npm run test-sessions-web-entry
```

It is deliberately not named `*.test.ts`: importing the web entry registers the
real file editor factory, which `workbench/test/browser/workbenchTestServices.ts`
also registers, and sharing a page with the normal suite would make one of the
two fail to load.

The other half — a registration put behind the Electron-only door in the first
place — is caught statically by the `local/code-no-electron-only-registration`
ESLint rule, which runs on `src/vs/sessions/**/{electron-browser,electron-main,electron-utility,node}/**`.
It reports a top-level `registerSingleton`, `registerWorkbenchContribution2`,
`registerWorkbenchContribution` or `registerAction2` whose class comes from a
`browser/` or `common/` module under `src/vs/sessions/`, or is declared in place
and needs nothing from Electron. A neutral class from `vs/workbench` or
`vs/platform` is left alone, because those are usually bridges whose only
consumer is Electron-only. The rule's own doc comment records the rest of what it
cannot see; `.eslint-plugin-local/tests/code-no-electron-only-registration-test.ts`
is its fixture, where each expected report is pinned by an
`eslint-disable-next-line` that ESLint reports as unused if the rule stops
firing.

---

## Key Constraint

```
contrib/*  ──✕──▶  contrib/providers/*
```

Non-provider contributions **must not** import from provider code. If a provider exposes a symbol needed by non-provider code, that symbol should be extracted to a shared location (`vs/sessions/services/`, `vs/sessions/common/`, or a shared contrib module).

Providers **can** import from non-provider contributions and from sibling providers.
