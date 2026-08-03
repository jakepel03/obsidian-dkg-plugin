import { Notice, TFile } from "obsidian";
import type OriginTrailDkgPlugin from "./main";
import { resolveRouting, shouldSkipPath, syncAllMarkdownFiles, syncMarkdownFile, type SyncOptions } from "./noteSync";
import { makeAssertionName } from "./identity";
import type { SyncResult } from "./types";
import { errorMessage } from "./utils";

export interface NoteDestination {
  shared: boolean;
  projectName?: string;
  viaFolderRule: boolean;
}

interface LastSyncEntry {
  status: SyncResult["status"];
  tripleCount?: number;
  at: number;
}

/**
 * Owns everything about pushing the vault into the DKG node: debounced
 * auto-sync, manual sync of one note or the whole vault, vault lifecycle
 * (rename/delete) handling, and the per-note last-sync record the dashboard
 * reads. Status-bar feedback is delegated back to the plugin.
 */
export class SyncController {
  private readonly pendingTimers = new Map<string, number>();
  private activeSyncs = 0;
  private hadError = false;
  private cachedAgentAddress?: string;
  /** Last sync outcome per note path, so the dashboard can show "✓ N triples · just now". */
  readonly lastSync = new Map<string, LastSyncEntry>();

  constructor(private readonly plugin: OriginTrailDkgPlugin) {}

  private get settings() {
    return this.plugin.settings;
  }

  syncOptions(): SyncOptions {
    return {
      primaryContextGraphId: this.settings.defaultContextGraphId,
      vaultId: this.settings.vaultId,
      subscribedContextGraphs: this.settings.subscribedContextGraphs,
      folderDestinations: this.settings.folderDestinations,
      agentAddress: this.cachedAgentAddress,
      sharedFolderRoot: this.settings.sharedFolderRoot,
    };
  }

  /** Where a note goes on sync: private, or shared to a project (and how). */
  noteDestination(file: TFile): NoteDestination {
    const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const { contextGraphId, promote } = resolveRouting(file.path, fm, this.syncOptions());
    if (!promote) return { shared: false, viaFolderRule: false };
    const match = this.settings.subscribedContextGraphs.find((c) => c.id === contextGraphId);
    const explicit = typeof fm?.shared_to === "string" && fm.shared_to.trim().length > 0;
    return { shared: true, projectName: match?.name || contextGraphId, viaFolderRule: !explicit };
  }

  /** Fetch and cache this node's agent address once; used to build entity URIs for link enrichment. */
  async ensureAgentAddress(): Promise<void> {
    if (this.cachedAgentAddress) return;
    try {
      const identity = await this.plugin.client().getIdentity();
      this.cachedAgentAddress = identity?.agentAddress;
    } catch (error) {
      // Best-effort: without it, link/name enrichment is skipped but sync still works.
      console.warn("[DKG] could not resolve agent address; link enrichment disabled:", error);
    }
  }

  async syncFile(file: TFile, silent = false): Promise<SyncResult | undefined> {
    if (!this.settings.defaultContextGraphId) {
      new Notice('This vault is not connected to DKG yet. Run "Connect this vault" first.');
      return undefined;
    }
    if (file.extension !== "md" || shouldSkipPath(file.path, this.settings.sharedFolderRoot)) return undefined;

    if (this.activeSyncs === 0) this.hadError = false;
    this.activeSyncs++;
    this.plugin.setStatusSyncing();
    try {
      await this.ensureAgentAddress();
      const result = await syncMarkdownFile(this.plugin.app, this.plugin.client(), file, this.syncOptions());
      this.lastSync.set(file.path, { status: result.status, tripleCount: result.tripleCount, at: Date.now() });
      if (result.warning) new Notice(`DKG: ${result.warning}`, 8000);
      if (!silent) new Notice(`DKG ${result.status}: ${file.path}`);
      return result;
    } catch (error) {
      this.hadError = true;
      console.error(error);
      new Notice(`DKG sync failed for ${file.path}: ${errorMessage(error)}`, 10000);
      return undefined;
    } finally {
      this.activeSyncs--;
      if (this.activeSyncs === 0) {
        if (this.hadError) this.plugin.updateStatusBar();
        else this.plugin.setStatusSaved();
      }
    }
  }

  /** Sync every Markdown note in the vault (manual full re-sync from the dashboard). */
  async syncWholeVault(onProgress?: (done: number, total: number) => void): Promise<number> {
    if (!this.settings.defaultContextGraphId) {
      new Notice("Connect your vault to DKG first.");
      return 0;
    }
    await this.ensureAgentAddress();
    const results = await syncAllMarkdownFiles(
      this.plugin.app,
      this.plugin.client(),
      this.syncOptions(),
      (done, total) => {
        this.plugin.setStatusSyncing();
        onProgress?.(done, total);
      }
    );
    for (const r of results) {
      this.lastSync.set(r.filePath, { status: r.status, tripleCount: r.tripleCount, at: Date.now() });
    }
    this.plugin.setStatusSaved();
    return results.length;
  }

  scheduleAutoSync(file: TFile): void {
    if (!this.settings.autoSync || !this.settings.defaultContextGraphId) return;
    if (file.extension !== "md" || shouldSkipPath(file.path, this.settings.sharedFolderRoot)) return;

    const existing = this.pendingTimers.get(file.path);
    if (existing) window.clearTimeout(existing);

    const timer = window.setTimeout(() => {
      this.pendingTimers.delete(file.path);
      void this.syncFile(file, true);
    }, this.settings.syncDebounceMs);
    this.pendingTimers.set(file.path, timer);
  }

  /** Rename: drop the orphaned assertion at the old path, then sync the new one. */
  async handleRename(file: TFile, oldPath: string): Promise<void> {
    if (!this.settings.defaultContextGraphId) return;
    this.cancelPendingSync(oldPath);

    // The old path's stable assertion name no longer maps to any file — discard
    // it so the rename doesn't leave an orphan. (No-op if it was never synced.)
    if (oldPath.toLowerCase().endsWith(".md") && !shouldSkipPath(oldPath, this.settings.sharedFolderRoot)) {
      await this.discardAssertionForPath(oldPath);
    }

    // Re-sync under the new path unless it moved into an excluded area.
    if (
      this.settings.autoSync &&
      file.extension === "md" &&
      !shouldSkipPath(file.path, this.settings.sharedFolderRoot)
    ) {
      this.scheduleAutoSync(file);
    }
  }

  /** Delete: discard the assertion so the local DKG reflects the vault. */
  async handleDelete(file: TFile): Promise<void> {
    if (!this.settings.defaultContextGraphId) return;
    this.cancelPendingSync(file.path);

    if (file.extension === "md" && !shouldSkipPath(file.path, this.settings.sharedFolderRoot)) {
      await this.discardAssertionForPath(file.path);
    }
  }

  /** Cancel any pending debounce timers (called on plugin unload). */
  dispose(): void {
    for (const timer of this.pendingTimers.values()) window.clearTimeout(timer);
    this.pendingTimers.clear();
  }

  private cancelPendingSync(path: string): void {
    const pending = this.pendingTimers.get(path);
    if (pending) {
      window.clearTimeout(pending);
      this.pendingTimers.delete(path);
    }
  }

  /**
   * Discard the assertion mapped to a vault path from the primary context graph.
   * Best-effort: a missing assertion (never synced) or a network blip logs a
   * warning but never blocks the local file operation. Notes shared into a
   * separate project keep their promoted copy there until discarded — same
   * limitation as "Stop sharing".
   */
  private async discardAssertionForPath(path: string): Promise<void> {
    try {
      const assertionName = await makeAssertionName(this.settings.vaultId, path);
      await this.plugin.client().discardAssertion(this.settings.defaultContextGraphId, assertionName);
    } catch (error) {
      console.warn(`[DKG] could not discard assertion for ${path}:`, error);
    }
  }
}
