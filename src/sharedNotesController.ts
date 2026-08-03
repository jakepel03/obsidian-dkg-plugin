import { Notice, TFile, TFolder } from "obsidian";
import type OriginTrailDkgPlugin from "./main";
import type { MaterializedNoteState, SubscribedContextGraph } from "./types";
import {
  buildSharedNotesQuery,
  parseSharedNoteRows,
  planProject,
  sanitizeFileName,
  type RemoteSharedNote,
} from "./sharedNotes";
import { sha256Hex } from "./identity";
import { errorMessage } from "./utils";

const POLL_INTERVAL_MS = 60_000;
const FIRST_REFRESH_DELAY_MS = 8_000;
/** How long to leave an unreachable note alone before retrying its byte-fetch. */
const FETCH_RETRY_BACKOFF_MS = 10 * 60_000;

/**
 * Keeps other members' shared notes materialized as real vault files, one
 * folder per project ("a project is a folder in your vault").
 *
 * Two-tier refresh: every tick LISTS each project's shared notes from the
 * local node (cheap — Shared Memory replicates here in the background), and
 * only notes that are new or changed get their prose pulled over P2P. The
 * fingerprint is the author-side `dkg:sourceFileHash` the daemon records on
 * the note's root entity, which replicates to members along with the triples.
 *
 * A file the user edited is never overwritten or trashed — updates for it are
 * skipped with a one-time notice until the user resolves the copy themselves.
 */
export class SharedNotesController {
  private started = false;
  private running = false;
  private myAddress = "";
  /** Per-entity retry gate after a failed P2P byte-fetch (cleared by manual refresh). */
  private readonly retryAfter = new Map<string, number>();
  /** Entities already warned about in this session (conflict / fetch failure). */
  private readonly notified = new Set<string>();
  /** For a future dashboard "updated N min ago" — epoch ms of the last completed refresh. */
  lastRefreshAt = 0;

  constructor(private readonly plugin: OriginTrailDkgPlugin) {}

  /** Begin background refreshing (call once, after the workspace layout is ready). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.plugin.registerInterval(window.setTimeout(() => void this.refreshAll(), FIRST_REFRESH_DELAY_MS));
    this.plugin.registerInterval(window.setInterval(() => void this.refreshAll(), POLL_INTERVAL_MS));
  }

  /** Refresh every project. `manual` also retries backed-off fetches and reports "no changes". */
  async refreshAll(manual = false): Promise<void> {
    const settings = this.plugin.settings;
    if (this.running) return;
    if (!settings.defaultContextGraphId) {
      if (manual) new Notice('Connect this vault to DKG first (run "Connect this vault").');
      return;
    }
    if (!settings.materializeSharedNotes && !manual) return;
    const projects = settings.subscribedContextGraphs.filter((cg) => cg.materialize !== false);
    if (projects.length === 0) {
      if (manual) new Notice("No shared projects to refresh.");
      return;
    }
    if (manual) this.retryAfter.clear();

    this.running = true;
    try {
      if (!(await this.ensureMyAddress())) {
        if (manual) new Notice("Could not resolve this node's identity — check the node connection.");
        return;
      }
      await this.pruneLeftProjects();
      let changed = 0;
      let failures = 0;
      for (const cg of projects) {
        try {
          const res = await this.refreshProject(cg, manual);
          changed += res.changed;
          failures += res.failures;
        } catch (err) {
          // One unreachable project must not stop the others.
          console.warn(`[DKG] shared-notes refresh failed for ${cg.id}:`, err);
          if (manual) new Notice(`Refresh failed for "${cg.name || cg.id}": ${errorMessage(err)}`, 8000);
        }
      }
      this.lastRefreshAt = Date.now();
      if (manual && changed === 0 && failures === 0) new Notice("Shared notes are up to date.");
    } finally {
      this.running = false;
    }
  }

  /**
   * Drop sync state for projects the user is no longer subscribed to. The
   * files are deliberately kept — leaving a project must never delete notes —
   * they just stop updating and become the user's own copies.
   */
  private async pruneLeftProjects(): Promise<void> {
    const settings = this.plugin.settings;
    const subscribed = new Set(settings.subscribedContextGraphs.map((cg) => cg.id));
    const stale = Object.entries(settings.materializedNotes).filter(([, s]) => !subscribed.has(s.cgId));
    if (stale.length === 0) return;
    for (const [entityUri] of stale) delete settings.materializedNotes[entityUri];
    await this.plugin.saveSettings();
  }

  private async ensureMyAddress(): Promise<boolean> {
    if (this.myAddress) return true;
    try {
      this.myAddress = (await this.plugin.client().getIdentity()).agentAddress ?? "";
    } catch (err) {
      console.warn("[DKG] shared-notes refresh skipped — could not resolve agent identity:", err);
    }
    return !!this.myAddress;
  }

  private async refreshProject(
    cg: SubscribedContextGraph,
    manual: boolean
  ): Promise<{ changed: number; failures: number }> {
    const { vault } = this.plugin.app;
    const settings = this.plugin.settings;
    const rows = await this.plugin.client().querySparql(buildSharedNotesQuery(cg.id));
    // Stable order so first-tick filename-collision suffixes are deterministic.
    const notes = parseSharedNoteRows(rows, cg.id).sort((a, b) => a.entityUri.localeCompare(b.entityUri));

    const folder = `${settings.sharedFolderRoot}/${sanitizeFileName(cg.name || cg.id)}`;
    const takenPaths = new Set<string>();
    const folderNode = vault.getAbstractFileByPath(folder);
    if (folderNode instanceof TFolder) {
      for (const child of folderNode.children) if (child instanceof TFile) takenPaths.add(child.path);
    }

    const plan = planProject(notes, settings.materializedNotes, {
      cgId: cg.id,
      myAddress: this.myAddress,
      folder,
      takenPaths,
      fileExists: (path) => vault.getAbstractFileByPath(path) instanceof TFile,
      manual,
    });

    let created = 0;
    let updated = 0;
    let failures = 0;
    let stateDirty = false;

    for (const { note, path, isNew } of plan.fetch) {
      const gate = this.retryAfter.get(note.entityUri);
      if (gate && gate > Date.now()) continue;
      const outcome = await this.materialize(cg, note, path);
      if (outcome === "written") {
        stateDirty = true;
        if (isNew) created++;
        else updated++;
      } else if (outcome === "unavailable") {
        failures++;
        this.retryAfter.set(note.entityUri, Date.now() + FETCH_RETRY_BACKOFF_MS);
        if (manual && !this.notified.has(note.entityUri)) {
          this.notified.add(note.entityUri);
          new Notice(`Couldn't fetch "${note.name}" — the author's node may be offline. Will retry later.`, 6000);
        }
      }
      // "conflict" and "skipped" leave everything untouched.
    }

    for (const { entityUri, state } of plan.remove) {
      const removedState = await this.removeMaterialized(entityUri, state);
      if (removedState) stateDirty = true;
    }

    if (stateDirty) await this.plugin.saveSettings();
    if (settings.sharedNotesNotices && created + updated > 0) {
      const parts = [created && `${created} new`, updated && `${updated} updated`].filter(Boolean);
      new Notice(`DKG: "${cg.name || cg.id}" — ${parts.join(", ")} shared note${created + updated > 1 ? "s" : ""}.`);
    }
    return { changed: created + updated, failures };
  }

  /** Fetch one note's prose and write/overwrite its file, unless the user edited the copy. */
  private async materialize(
    cg: SubscribedContextGraph,
    note: RemoteSharedNote,
    path: string
  ): Promise<"written" | "unavailable" | "conflict" | "skipped"> {
    const { vault, fileManager } = this.plugin.app;
    const settings = this.plugin.settings;
    const existing = vault.getAbstractFileByPath(path);

    // Overwrite guard: only ever replace content the plugin itself wrote.
    if (existing instanceof TFile) {
      const state = settings.materializedNotes[note.entityUri];
      const digest = await sha256Hex(await vault.read(existing));
      if (!state || digest !== state.digest) {
        if (!this.notified.has(note.entityUri)) {
          this.notified.add(note.entityUri);
          new Notice(
            `"${existing.basename}" was updated in "${cg.name || cg.id}", but you edited your copy — ` +
              `keeping yours. Rename your copy (or delete it) to receive updates again.`,
            10000
          );
        }
        return "conflict";
      }
    } else if (existing) {
      return "skipped"; // a folder occupies the path — never fight it
    }

    // Pin the P2P byte-read at the curator when we captured their peer id at
    // join time (avoids the node probing every connected peer sequentially).
    const content = await this.plugin
      .client()
      .readArtifactMarkdown(note.cgId, note.entityUri, cg.curatorPeerId)
      .catch(() => null);
    if (content === null) return "unavailable";

    let file: TFile;
    if (existing instanceof TFile) {
      await vault.modify(existing, content);
      file = existing;
    } else {
      await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
      file = await vault.create(path, content);
    }

    // Provenance frontmatter (also what the write-side follow-up will key its
    // "not my note" skip on), then fingerprint the final bytes so the next
    // tick can tell our write from a user edit. The AUTHOR's sharing markers
    // are dropped: left in place, moving the copy out of the shared folder
    // would re-share it into the project under THIS user's identity.
    await fileManager.processFrontMatter(file, (fm) => {
      delete fm.shared_to;
      delete fm.shared;
      fm.dkg_origin = note.cgId;
      fm.dkg_author = note.author;
      if (note.hash) fm.dkg_hash = note.hash;
    });
    settings.materializedNotes[note.entityUri] = {
      path,
      hash: note.hash ?? "",
      digest: await sha256Hex(await vault.read(file)),
      cgId: note.cgId,
    };
    return "written";
  }

  /** Upstream entity is gone: trash our unedited copy; keep (and orphan) an edited one. */
  private async removeMaterialized(entityUri: string, state: MaterializedNoteState): Promise<boolean> {
    const { vault } = this.plugin.app;
    const settings = this.plugin.settings;
    const file = vault.getAbstractFileByPath(state.path);
    if (file instanceof TFile) {
      const digest = await sha256Hex(await vault.read(file));
      if (digest !== state.digest) {
        // The user changed the copy — it's theirs now. Forget it, keep the file.
        if (!this.notified.has(entityUri)) {
          this.notified.add(entityUri);
          new Notice(`"${file.basename}" is no longer shared, but you edited your copy — keeping it.`, 8000);
        }
      } else {
        await vault.trash(file, false);
      }
    }
    delete settings.materializedNotes[entityUri];
    return true;
  }

  private async ensureFolder(path: string): Promise<void> {
    const { vault } = this.plugin.app;
    const parts = path.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(vault.getAbstractFileByPath(cur) instanceof TFolder)) {
        await vault.createFolder(cur).catch(() => {});
      }
    }
  }
}
