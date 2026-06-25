# Production-Readiness Review — OriginTrail DKG for Obsidian

**Date:** 2026-06-25
**Reviewed version:** `0.2.0` (branch `release-0.2.0`, tag `0.2.0`)
**Target node:** OriginTrail DKG `v10.0.0-rc.19`
**Scope:** correctness, test/build health, rc.19 API sync, structure, code smells, efficiency, and Obsidian-store submission readiness.

---

## 1. Verdict

**The plugin is in good shape and close to production-grade.** It builds clean, the test suite passes, the committed artifact matches source, and every DKG endpoint it calls is verified present and compatible at the `v10.0.0-rc.19` tag. The architecture is modular and the code is defensive (graceful fallbacks, best-effort cleanup, honest UI states).

There are **no critical bugs and no release blockers**. What remains is a short list of polish items: two latent robustness smells, a handful of stale post-rename references, `any`-typing cleanup, a release/branch-hygiene gap, and one efficiency opportunity for large-vault first imports.

### Health snapshot

| Check | Result |
|---|---|
| `tsc --noEmit` (typecheck) | ✅ clean |
| `vitest run` | ✅ 25/25 passing (4 files) |
| `eslint` | ✅ 0 errors, ⚠️ 10 `any` warnings |
| `esbuild` production build | ✅ committed `main.js` byte-identical to fresh build |
| Working tree | ✅ clean |
| rc.19 endpoint sync | ✅ all 23 endpoints present & compatible |
| Obsidian guideline scan | ✅ no `innerHTML`, no leaf-detach on unload, no `console.log`, no inline styles |

---

## 2. Is it in sync with rc.19? — Yes, verified

The "Require rc.19" commit (`08ee240`) was **README-only**; no code changed. So the real question is whether the rc.18-era code still matches rc.19's daemon. I diffed against the actual `v10.0.0-rc.19` tag in the sibling `dkg/` repo (the local `dkg/` working tree is 102 commits *behind* rc.19, so the tag — not the checkout — was used as the source of truth).

**All 23 endpoints the plugin calls exist at rc.19** and are routed as expected:

- Status/identity: `GET /api/status`, `GET /api/agent/identity`
- Context graphs: `list`, `create`, `register`, `subscribe`, `unsubscribe`, `{id}/sign-join`, `{id}/request-join`, `{id}/join-requests`, `{id}/approve-join`, `{id}/reject-join`, `{id}/participants`, `{id}/add-participant`, `{id}/remove-participant`
- Knowledge assets: `{name}/wm/import-file`, `{name}/wm/extraction-status`, `{name}/swm/share`, `{name}/wm/discard`, `semantic-enrichment/write`, `import-artifact/read`, `import-artifact/read-markdown`
- Query: `POST /api/query`

**The rc.19 requirement is genuinely justified, not cosmetic.** The plugin's per-note share uses `swm/share` with `skipSeal: true` so notes can be edited and re-shared without the "already finalized with a different merkleRoot" failure. The `skipSeal` field was **added in the rc.18→rc.19 diff** (`knowledge-assets.ts`: a non-boolean now 400s; older nodes silently ignored it). The edit/re-share flow therefore only behaves correctly on rc.19 — so `rc.19` is the correct floor, and the README/manifest are right to require it.

**Resilience to rc.19's expanded responses is good.** `import-artifact/read` gained statuses (`fetchable`, `denied`, `unavailable`, `hash_mismatch`) on top of `local`/`fetched`/`unverified`. `readArtifactMarkdown` accepts only the three "bytes available" statuses and returns `null` otherwise → Discover/Fork falls back to a reconstructed stub rather than breaking. That degradation path is correct.

**Minor — doc currency only (not a sync break):** several code comments still say *"verified against DKG rc.18"* / *"verified live on rc.18"* (`dkgClient.ts:88,96,249,338`, `createProjectModal.ts:120`). These remain historically accurate, but since rc.19 is now the floor they should be re-verified once against a live rc.19 node and relabeled.

---

## 3. Bugs & correctness findings

No critical or user-facing bugs were found. Two latent robustness issues:

### 3.1 Shared mutable default arrays (latent) — `src/types.ts` + `src/main.ts:142`
`loadSettings()` does `Object.assign({}, DEFAULT_SETTINGS, stored)`. This is a **shallow** merge: on first run (no `data.json`), `settings.subscribedContextGraphs` and `settings.folderDestinations` are the *same array references* as the module-level `DEFAULT_SETTINGS`. Any `push`/`filter`-reassign that mutates the array in place (e.g. creating/joining a project before the first save) mutates the shared default.

Real-world impact is low (Obsidian runs one instance; the module is re-imported fresh on reload, and the first `saveSettings()` then persists a real array that subsequent loads read back). But it's a genuine smell worth removing.

**Fix:** clone the defaults — `this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...stored }` — or initialize the array fields explicitly.

### 3.2 `loadSettings()` writes `data.json` on every load — `src/main.ts:156`
`await this.saveSettings()` runs unconditionally at the end of `loadSettings()`, so the plugin writes its data file on **every** launch even when nothing changed. It's there to persist the legacy-key migration and a freshly generated `vaultId`, but those are one-time.

**Fix:** track whether anything actually changed (migration applied, or `vaultId` generated) and only `saveSettings()` then.

### 3.3 Minor UX edge — Discover "content mode" badge can hang on "checking…"
`joinProjectModal` records member projects without a `curated` flag (`src/joinProjectModal.ts:147`), so `DiscoverModal.contentMode()` depends on `projectReadiness().accessPolicy`. If readiness resolves to `null` (node briefly unreachable), the per-project badge stays `checking…` instead of settling. Not a functional bug (Fork still works and falls back), just a cosmetic dead-end. Consider defaulting the badge to a neutral state after the readiness probe completes.

---

## 4. Structure & organization — solid

The layout is clean and idiomatic for an Obsidian plugin. No restructuring is needed.

```
src/   15 files, ~3,360 LoC   (one concern per file; largest is dkgClient 459 LoC)
tests/  4 files,   224 LoC     (pure logic: client, identity, routing, utils)
```

Strengths worth keeping:
- **Clear separation:** `dkgClient` (HTTP), `noteSync` (pure routing/sync logic), `syncController` (debounce/lifecycle/state), `dashboardView` + modals (UI), `identity`/`utils` (helpers). The pure logic (`resolveRouting`, identity hashing, invite parsing) is isolated and unit-tested.
- **Transport injection:** `DkgClient` takes a `RequestTransport`, which is what makes it testable without a network. Good call.
- **Defensive daemon parsing:** `listContextGraphs` tolerates array/`contextGraphs`/`graphs` shapes; SPARQL binding flattening handles both `{value}` and raw forms.
- **Honest async UX:** join/subscribe waits on *real* readiness signals (allowlist for curated, `synced` for public) rather than arbitrary timers, and surfaces a truthful "still syncing" state.

---

## 5. Stale / redundant / inconsistent items

These are all leftovers from the **"OriginTrail Shared Memory" → "OriginTrail DKG"** rename and the **rc.18 → rc.19** bump. Low-effort, high-tidiness.

| # | Location | Issue | Fix |
|---|---|---|---|
| 1 | `.github/copilot-instructions.md:5` | Says plugin ID `origintrail-shared-memory` — **wrong**, actual id is `origintrail-dkg`. Also old "Shared Memory promotion" framing. | Update id + wording. |
| 2 | `esbuild.config.mjs` banner | `/* OriginTrail Shared Memory for Obsidian */` — old name. | `OriginTrail DKG for Obsidian`. |
| 3 | `Makefile:15` | Comment "currently rc.18". | Update to rc.19. |
| 4 | `src/*` comments | "verified against/live on rc.18" (§2). | Re-verify on rc.19, relabel. |
| 5 | `docs/DESIGN_BRIEF.md` (tracked) | Bounty design brief shipped in a plugin-store repo. Harmless but arguably noise. | Optional: keep, or move under a clearly dev-facing path. `docs/private/` is correctly gitignored. |

### Internal naming inconsistency — "promote" vs "share"
The DKG API and the user-facing UI both moved to **"share"** (`swm/share`, buttons say *Share*, status says *Shared*), but the internal code still says **promote**: `promoteAssertion()`, `SyncResult.status: "imported" | "promoted"`, the `promote: boolean` routing flag, and assorted comments. The code even acknowledges it (`"the route formerly named promote"`). This is cosmetic, not a bug, but for a production codebase it's worth aligning: rename `promoteAssertion → shareAssertion`, `"promoted" → "shared"`, `promote → share`. (Touches `dkgClient.test.ts`.) Do it in one pass or leave a tracking note — just don't let the two vocabularies drift further.

---

## 6. Code quality / lint

- **10 `@typescript-eslint/no-explicit-any` warnings**, all in `dkgClient.ts`, on the join-flow methods (`signJoinRequest`, `requestJoin`, `listJoinRequests`, `approve/reject`, `listParticipants`) and the SPARQL row mapper. They're warnings, not errors, and CI passes — but typing these responses (even loosely, e.g. `{ delegation?: unknown }`, `{ requests?: unknown[] }`) would take the lint output to zero and document the daemon contracts. Recommended before store submission for a clean bill of health.
- Otherwise the style is consistent (Prettier-enforced, 120-col), comments are high-value (they explain *why*, e.g. the `skipSeal`/seal rationale and the curator-peer pin), and there are no `TODO`/`FIXME`/`HACK` markers left behind.

---

## 7. Efficiency

Most hot paths are already handled well: autosave is debounced, the dashboard no longer re-renders wholesale on every save (only the "This note" card), and project readiness is cached with a 30s TTL.

Two opportunities:

### 7.1 First-vault import is fully sequential — `noteSync.syncAllMarkdownFiles`
Bulk import awaits each note one at a time, and each note can: import → poll extraction up to **20 × 750ms = 15s** → enrich links → share. For a large vault (thousands of notes), the initial import (and "Sync whole vault") can take a long time. The sequential design is a deliberate "don't hammer the node" choice, but it's the single biggest UX cost on large vaults.

**Consider:** a small bounded concurrency (e.g. 3–4 in flight) *only* for the bulk path, leaving single-note autosync as-is. Even modest parallelism would cut first-run time substantially without overwhelming a local node.

### 7.2 Connection polling has no timeout — `dashboardView.checkConnection` (7s interval)
`requestUrl` has no `AbortSignal`, so if the node hangs, status checks can stack up across intervals. Low impact, but you already have `withTimeout` in `dkgClient` — wrapping the status probe with it would make the dashboard's connection dot strictly bounded.

---

## 8. Obsidian Community-Plugin submission readiness

**Largely ready.** Guideline-scan results:

✅ Passing:
- No `innerHTML`/`outerHTML`/`insertAdjacentHTML` — all DOM via `createEl`/`createDiv` helpers.
- No `detachLeavesOfType` in `onunload` (correctly avoids the documented anti-pattern); timers are cleared in `onunload`/`dispose`, intervals use `registerInterval`.
- No `console.log`; only `console.warn`/`error` on real failures.
- Styling lives in `styles.css` (98 selectors) — no inline `element.style`.
- Command names are sentence-case and omit the plugin prefix (Obsidian adds it); ids are stable for hotkeys.
- `manifest.json` valid: `isDesktopOnly: false`, `minAppVersion: 1.5.0`, description 137 chars with no "Obsidian", id has no "obsidian"/"plugin".
- Versions are lockstep across `manifest.json` / `versions.json` / `package.json` (all `0.2.0`); release tags are bare (`0.2.0`), as the store requires; `main.js`/`styles.css` committed and CI-enforced; `node_modules` not tracked.

⚠️ Watch / address before submitting:
- **Undocumented private API:** `dashboardView.ts:375` casts `app` to reach `app.setting.open()` / `app.setting.openTabById()`. It's widely used by community plugins, but reviewers do sometimes flag it. Keep it (there's no public equivalent) but be ready to justify, and guard the cast so a future API change can't throw.
- **External service / network model:** the plugin talks to a self-hosted DKG node with a bearer token. The README's *Privacy & safety* section covers this well; make sure the submission notes call out that it's a user-run local node, not a hosted third party.
- Optional niceties: add `fundingUrl` to the manifest; the `status-beta` badge + the testnet warning are appropriately honest for a first listing.

---

## 9. Release & repo hygiene

1. **`release-0.2.0` is not merged into `main`.** `main` is 2 commits behind the `0.2.0` tag (missing the rc.19 README commit and the "Release 0.2.0" commit). The tag itself correctly includes the rc.19 changes, but `main` should be fast-forwarded/merged so the default branch reflects the released state before (or right after) publishing.
2. **~26 local branches** linger (mostly squash-merged feature branches like `feat/issue-2-setup-wizard`, `share-model-redesign-32`, …). Prune them (`git branch -D …`) for a clean repo — purely cosmetic.

---

## 10. Prioritized action list

**Before store submission (recommended):**
1. Fix the stale rename/version references — copilot-instructions id, esbuild banner, Makefile rc.18 note (§5.1–5.3). *(trivial)*
2. Clone `DEFAULT_SETTINGS` in `loadSettings` to drop the shared-array smell (§3.1). *(trivial)*
3. Guard `loadSettings`'s unconditional `saveSettings` (§3.2). *(trivial)*
4. Type away the 10 `any` warnings in `dkgClient.ts` (§6). *(small)*
5. Merge `release-0.2.0` → `main` (§9.1). *(trivial)*

**Strongly recommended, slightly larger:**
6. Re-verify the daemon contracts against a live rc.19 node and relabel the rc.18 comments (§2). *(verification pass)*
7. Bounded concurrency for the first-import path (§7.1). *(small/medium)*

**Optional polish:**
8. Rename internal "promote" → "share" for vocabulary consistency (§5). *(cosmetic, touches a test)*
9. `withTimeout` around the dashboard status poll (§7.2); settle the Discover content-mode badge (§3.3); prune stale local branches (§9.2).

None of items 1–9 are release blockers. The plugin can ship as-is to BRAT/testers today; items 1–5 are quick wins that make it a clean store submission.
