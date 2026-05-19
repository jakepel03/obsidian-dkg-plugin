# Copilot Cloud Agent Instructions

## Project

Obsidian plugin (ID: `origintrail-shared-memory`) that syncs vault Markdown notes into an [OriginTrail DKG v10](https://github.com/OriginTrail/dkg) node as Working Memory assertions, with optional Shared Memory promotion.

**Stack:** TypeScript (strict, ES2022) · pnpm · esbuild · Vitest · ESLint + Prettier

---

## Commands

```bash
pnpm install       # install deps
pnpm build         # type-check + build → main.js (always run after src changes)
pnpm test          # Vitest unit tests (no browser needed)
pnpm lint          # ESLint src + tests
pnpm format        # Prettier write
pnpm format:check  # Prettier check
```

Always run `pnpm test` and `pnpm lint` after code changes.

---

## Key files

| File | Role |
|---|---|
| `src/main.ts` | Plugin entry: commands, auto-sync debounce, first-run modal |
| `src/dkgClient.ts` | HTTP client for DKG REST API (transport injected for testability) |
| `src/noteSync.ts` | Sync one/all files; polls extraction status; optional promotion |
| `src/identity.ts` | Pure helpers: slugify, SHA-256, assertion name, vault UUID |
| `src/types.ts` | `OriginTrailSettings`, `DEFAULT_SETTINGS`, `RequestTransport`, `SyncResult` |
| `src/settings.ts` | Obsidian settings tab UI |
| `tests/identity.test.ts` | Unit tests for `src/identity.ts` |
| `main.js` | Committed build output — regenerate with `pnpm build` |
| `manifest.json` | Obsidian manifest (edit directly, not generated) |

---

## Conventions

- Always use `pnpm`, never `npm`/`yarn`.
- Import Obsidian APIs from `"obsidian"` — never bundle them.
- `main.js` is committed (Obsidian plugin convention); regenerate after every `src/` change.
- No comments unless explaining non-obvious logic.
- No new dependencies unless strictly necessary.
- `any` triggers a lint warning — add an inline comment if unavoidable.
- Auth token lives only in the vault's local `data.json` — never commit it.

---

## PR review guidelines

When reviewing a pull request, check for:

- **Correctness** — Does the logic match the DKG API contract? Are error paths handled?
- **TypeScript** — No new `any` without justification; no `noImplicitAny` or `strictNullChecks` suppressions.
- **Build output** — Is `main.js` regenerated when `src/` changes? If not, flag it.
- **Tests** — New pure logic in `src/identity.ts` or other testable helpers must have Vitest coverage.
- **Security** — Auth tokens must not appear in source, logs, or committed files.
- **Obsidian imports** — All Obsidian APIs must be imported from `"obsidian"`, not bundled.
- **Debounce/timers** — Any new `window.setTimeout` must be cleared in `onunload` to avoid leaks.
- **Settings persistence** — Settings changes must call `saveSettings()` and `updateStatusBar()` where relevant.
- **PR template** — Summary, type of change, and testing checklist must be filled in.

---

## Known limitations

- MVP v0.1.0 — no GitHub Releases ZIP; users install manually.
- DKG v10 is RC software on testnet — API may change.
- Extraction polling: 20 retries × 750 ms ≈ 15 s timeout.
- Verified Memory / on-chain publishing is out of scope.

---

## Errors encountered and workarounds

_Update this section if you encounter build, test, or tooling errors and find a workaround._
