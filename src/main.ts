import { Notice, Plugin, TFile, requestUrl } from "obsidian";
import { DkgClient } from "./dkgClient";
import { makeVaultId, slugifyContextGraphId, makeAssertionName } from "./identity";
import { syncAllMarkdownFiles, syncMarkdownFile, shouldSkipPath, resolveRouting, type SyncOptions } from "./noteSync";
import { OriginTrailSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type OriginTrailSettings, type SyncResult } from "./types";
import { SetupWizardModal } from "./wizard";
import { CreateProjectModal } from "./createProjectModal";
import { JoinProjectModal } from "./joinProjectModal";
import { ShareNoteModal } from "./shareNoteModal";
import { DiscoverModal } from "./discoverModal";
import { DkgDashboardView, DKG_DASHBOARD_VIEW } from "./dashboardView";
import { errorMessage } from "./utils";

export default class OriginTrailDkgPlugin extends Plugin {
  settings!: OriginTrailSettings;
  private statusBarEl!: HTMLElement;
  private pendingSyncTimers = new Map<string, number>();
  private activeSyncs = 0;
  private hadSyncError = false;
  private savedStatusTimer: number | null = null;
  private cachedAgentAddress?: string;
  /** Last sync outcome per note path, so the dashboard can show "✓ N triples · just now". */
  readonly lastSync = new Map<string, { status: SyncResult["status"]; tripleCount?: number; at: number }>();

  async onload() {
    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("dkg-statusbar");
    this.updateStatusBar();

    this.addSettingTab(new OriginTrailSettingTab(this.app, this));

    this.registerView(DKG_DASHBOARD_VIEW, (leaf) => new DkgDashboardView(leaf, this));
    this.addRibbonIcon("git-fork", "OriginTrail DKG dashboard", () => this.activateDashboard());
    this.addCommand({
      id: "open-dkg-dashboard",
      name: "Open DKG dashboard",
      callback: () => this.activateDashboard(),
    });

    this.addCommand({
      id: "test-dkg-connection",
      name: "Test DKG connection",
      callback: () => this.testConnection(),
    });

    this.addCommand({
      id: "connect-vault",
      name: "Connect this vault to OriginTrail DKG",
      callback: () => new SetupWizardModal(this).open(),
    });

    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note to DKG",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.syncFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "create-shared-dkg-project",
      name: "Create shared DKG project",
      callback: () => new CreateProjectModal(this, () => this.updateStatusBar()).open(),
    });

    this.addCommand({
      id: "join-shared-dkg-project",
      name: "Join shared DKG project",
      callback: () => new JoinProjectModal(this, () => this.updateStatusBar()).open(),
    });

    this.addCommand({
      id: "discover-shared-notes",
      name: "Discover shared notes from a project",
      callback: () => new DiscoverModal(this).open(),
    });

    this.addCommand({
      id: "share-current-note-to-project",
      name: "Share current note to a project",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (this.settings.subscribedContextGraphs.length === 0) return false;
        if (!checking) new ShareNoteModal(this, file).open();
        return true;
      },
    });

    this.addCommand({
      id: "stop-sharing-current-note",
      name: "Stop sharing current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.unshareNote(file);
        return true;
      },
    });

    // Register vault listeners only after layout is ready: Obsidian fires a
    // "create" event for every existing file during initial load, and handling
    // those would trigger a full re-sync on every startup.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile) this.scheduleAutoSync(file);
        })
      );
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile) this.scheduleAutoSync(file);
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if (file instanceof TFile) void this.handleRename(file, oldPath);
        })
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (file instanceof TFile) void this.handleDelete(file);
        })
      );
      this.maybeShowSetupPrompt();
    });
  }

  onunload() {
    for (const timer of this.pendingSyncTimers.values()) window.clearTimeout(timer);
    this.pendingSyncTimers.clear();
    if (this.savedStatusTimer !== null) window.clearTimeout(this.savedStatusTimer);
  }

  async loadSettings() {
    const stored = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);

    // Migrate legacy keys, then drop them so they stop being persisted:
    //  - `autoPromote`: the global "promote everything" switch was replaced by
    //    explicit per-note / per-folder sharing.
    //  - `hasSeenPowerUpPrompt` → `hasCompletedSetup` (renamed).
    const legacy = this.settings as unknown as Record<string, unknown>;
    delete legacy.autoPromote;
    if (stored.hasSeenPowerUpPrompt !== undefined && stored.hasCompletedSetup === undefined) {
      this.settings.hasCompletedSetup = Boolean(stored.hasSeenPowerUpPrompt);
    }
    delete legacy.hasSeenPowerUpPrompt;

    if (!this.settings.vaultId) this.settings.vaultId = makeVaultId();
    await this.saveSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  client(): DkgClient {
    return new DkgClient(this.settings.dkgNodeUrl, this.settings.authToken, requestUrl);
  }

  private syncOptions(): SyncOptions {
    return {
      primaryContextGraphId: this.settings.defaultContextGraphId,
      vaultId: this.settings.vaultId,
      subscribedContextGraphs: this.settings.subscribedContextGraphs,
      folderDestinations: this.settings.folderDestinations,
      agentAddress: this.cachedAgentAddress,
    };
  }

  /** Where a note goes on sync: private, or shared to a project (and how). */
  noteDestination(file: TFile): { shared: boolean; projectName?: string; viaFolderRule: boolean } {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const { contextGraphId, promote } = resolveRouting(file.path, fm, this.syncOptions());
    if (!promote) return { shared: false, viaFolderRule: false };
    const match = this.settings.subscribedContextGraphs.find((c) => c.id === contextGraphId);
    const explicit = typeof fm?.shared_to === "string" && fm.shared_to.trim().length > 0;
    return { shared: true, projectName: match?.name || contextGraphId, viaFolderRule: !explicit };
  }

  /** Fetch and cache this node's agent address once; used to build entity URIs for link enrichment. */
  private async ensureAgentAddress(): Promise<void> {
    if (this.cachedAgentAddress) return;
    try {
      const identity = await this.client().getIdentity();
      this.cachedAgentAddress = identity?.agentAddress;
    } catch (error) {
      // Best-effort: without it, link/name enrichment is skipped but sync still works.
      console.warn("[DKG] could not resolve agent address; link enrichment disabled:", error);
    }
  }

  updateStatusBar() {
    if (!this.statusBarEl) return;
    const project = this.settings.defaultContextGraphId || "unlinked";
    const sync = this.settings.autoSync ? "synced" : "auto-sync off";
    this.statusBarEl.setText(`DKG: ${project} · ${sync}`);
    this.refreshDashboard();
  }

  /** Open (or reveal) the dashboard panel in the right sidebar. */
  async activateDashboard(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(DKG_DASHBOARD_VIEW)[0] ?? null;
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: DKG_DASHBOARD_VIEW, active: true });
      leaf = right;
    }
    workspace.revealLeaf(leaf);
  }

  /** Re-render any open dashboard panel after state changes. */
  refreshDashboard(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DKG_DASHBOARD_VIEW)) {
      const view = leaf.view;
      if (view instanceof DkgDashboardView) view.render();
    }
  }

  private setStatusSyncing() {
    if (this.savedStatusTimer !== null) {
      window.clearTimeout(this.savedStatusTimer);
      this.savedStatusTimer = null;
    }
    this.statusBarEl.setText("DKG: syncing…");
  }

  private setStatusSaved() {
    this.statusBarEl.setText("DKG: saved ✓");
    this.savedStatusTimer = window.setTimeout(() => {
      this.savedStatusTimer = null;
      this.updateStatusBar();
    }, 3000);
  }

  async testConnection() {
    try {
      const client = this.client();
      await client.status();
      if (this.settings.authToken.trim()) await client.getIdentity();
      new Notice("OriginTrail DKG connection OK");
    } catch (error) {
      console.error(error);
      new Notice(`OriginTrail DKG connection failed: ${errorMessage(error)}`, 10000);
    }
  }

  async createProjectFromVaultAndSyncNotes(opts?: {
    onStatus?: (msg: string) => void;
    onProgress?: (done: number, total: number, file: TFile) => void;
  }): Promise<number> {
    const notify = opts?.onStatus ?? ((msg: string) => new Notice(msg));
    const vaultName = this.app.vault.getName();
    const contextGraphId = slugifyContextGraphId(vaultName);
    const client = this.client();

    notify(`Creating/linking DKG Project "${vaultName}"...`);
    const graph = await client.ensureContextGraph(contextGraphId, vaultName);
    this.settings.defaultContextGraphId = graph.id || contextGraphId;
    this.settings.autoSync = true;
    this.settings.hasCompletedSetup = true;
    await this.saveSettings();
    this.updateStatusBar();

    notify(`Importing Markdown notes into your vault graph...`);
    await this.ensureAgentAddress();
    const results = await syncAllMarkdownFiles(
      this.app,
      client,
      this.syncOptions(),
      opts?.onProgress ??
        ((done, total, file) => {
          if (done === 0 || done % 5 === 0) new Notice(`DKG sync ${done + 1}/${total}: ${file.path}`, 2500);
        })
    );

    if (!opts?.onStatus) {
      new Notice(
        `DKG Project linked: ${this.settings.defaultContextGraphId}. Synced ${results.length} notes privately to your vault graph.`,
        10000
      );
    }

    return results.length;
  }

  async syncFile(file: TFile, silent = false): Promise<SyncResult | undefined> {
    if (!this.settings.defaultContextGraphId) {
      new Notice('This vault is not connected to DKG yet. Run "Connect this vault to OriginTrail DKG" first.');
      return undefined;
    }
    if (file.extension !== "md" || shouldSkipPath(file.path)) return undefined;

    if (this.activeSyncs === 0) this.hadSyncError = false;
    this.activeSyncs++;
    this.setStatusSyncing();
    try {
      await this.ensureAgentAddress();
      const result = await syncMarkdownFile(this.app, this.client(), file, this.syncOptions());
      this.lastSync.set(file.path, { status: result.status, tripleCount: result.tripleCount, at: Date.now() });
      if (result.warning) new Notice(`DKG: ${result.warning}`, 8000);
      if (!silent) new Notice(`DKG ${result.status}: ${file.path}`);
      return result;
    } catch (error) {
      this.hadSyncError = true;
      console.error(error);
      new Notice(`DKG sync failed for ${file.path}: ${errorMessage(error)}`, 10000);
      return undefined;
    } finally {
      this.activeSyncs--;
      if (this.activeSyncs === 0) {
        if (this.hadSyncError) this.updateStatusBar();
        else this.setStatusSaved();
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
    const results = await syncAllMarkdownFiles(this.app, this.client(), this.syncOptions(), (done, total, file) => {
      this.setStatusSyncing();
      onProgress?.(done, total);
      void file;
    });
    for (const r of results) {
      this.lastSync.set(r.filePath, { status: r.status, tripleCount: r.tripleCount, at: Date.now() });
    }
    this.setStatusSaved();
    return results.length;
  }

  async unshareNote(file: TFile) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      delete fm.shared_to;
      delete fm.shared;
    });
    new Notice(
      `"${file.basename}" is now private. Any copy already shared to a project stays there until discarded.`,
      8000
    );
    await this.syncFile(file);
  }

  private scheduleAutoSync(file: TFile) {
    if (!this.settings.autoSync || !this.settings.defaultContextGraphId) return;
    if (file.extension !== "md" || shouldSkipPath(file.path)) return;

    const existing = this.pendingSyncTimers.get(file.path);
    if (existing) window.clearTimeout(existing);

    const timer = window.setTimeout(() => {
      this.pendingSyncTimers.delete(file.path);
      this.syncFile(file, true);
    }, this.settings.syncDebounceMs);
    this.pendingSyncTimers.set(file.path, timer);
  }

  /** Rename: drop the orphaned assertion at the old path, then sync the new one. */
  private async handleRename(file: TFile, oldPath: string) {
    if (!this.settings.defaultContextGraphId) return;
    this.cancelPendingSync(oldPath);

    // The old path's stable assertion name no longer maps to any file — discard
    // it so the rename doesn't leave an orphan. (No-op if it was never synced.)
    if (oldPath.toLowerCase().endsWith(".md") && !shouldSkipPath(oldPath)) {
      await this.discardAssertionForPath(oldPath);
    }

    // Re-sync under the new path unless it moved into an excluded area.
    if (this.settings.autoSync && file.extension === "md" && !shouldSkipPath(file.path)) {
      this.scheduleAutoSync(file);
    }
  }

  /** Delete: discard the assertion so the local DKG reflects the vault. */
  private async handleDelete(file: TFile) {
    if (!this.settings.defaultContextGraphId) return;
    this.cancelPendingSync(file.path);

    if (file.extension === "md" && !shouldSkipPath(file.path)) {
      await this.discardAssertionForPath(file.path);
    }
  }

  private cancelPendingSync(path: string) {
    const pending = this.pendingSyncTimers.get(path);
    if (pending) {
      window.clearTimeout(pending);
      this.pendingSyncTimers.delete(path);
    }
  }

  /**
   * Discard the assertion mapped to a vault path from the primary context graph.
   * Best-effort: a missing assertion (never synced) or a network blip logs a
   * warning but never blocks the local file operation. Notes shared into a
   * separate project keep their promoted copy there until discarded — same
   * limitation as "Stop sharing".
   */
  private async discardAssertionForPath(path: string) {
    try {
      const assertionName = await makeAssertionName(this.settings.vaultId, path);
      await this.client().discardAssertion(this.settings.defaultContextGraphId, assertionName);
    } catch (error) {
      console.warn(`[DKG] could not discard assertion for ${path}:`, error);
    }
  }

  private maybeShowSetupPrompt() {
    if (this.settings.defaultContextGraphId || this.settings.hasCompletedSetup) return;
    new SetupWizardModal(this).open();
  }
}
