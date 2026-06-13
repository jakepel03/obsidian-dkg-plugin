import { Notice, Plugin, TFile, requestUrl } from "obsidian";
import { DkgClient } from "./dkgClient";
import { makeVaultId, slugifyContextGraphId } from "./identity";
import { syncAllMarkdownFiles } from "./noteSync";
import { OriginTrailSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type OriginTrailSettings } from "./types";
import { SetupWizardModal } from "./wizard";
import { CreateProjectModal } from "./createProjectModal";
import { JoinProjectModal } from "./joinProjectModal";
import { ShareNoteModal } from "./shareNoteModal";
import { DiscoverModal } from "./discoverModal";
import { DkgDashboardView, DKG_DASHBOARD_VIEW } from "./dashboardView";
import { SyncController } from "./syncController";
import { errorMessage } from "./utils";

export default class OriginTrailDkgPlugin extends Plugin {
  settings!: OriginTrailSettings;
  sync!: SyncController;
  private statusBarEl!: HTMLElement;
  private savedStatusTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.sync = new SyncController(this);

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("dkg-statusbar");
    this.updateStatusBar();

    this.addSettingTab(new OriginTrailSettingTab(this.app, this));

    this.registerView(DKG_DASHBOARD_VIEW, (leaf) => new DkgDashboardView(leaf, this));
    this.addRibbonIcon("git-fork", "OriginTrail DKG dashboard", () => this.activateDashboard());
    // Command names deliberately omit "DKG"/the plugin name: the palette
    // already prefixes them with "OriginTrail DKG:" (Obsidian guideline).
    // Ids stay unchanged so existing hotkey bindings keep working.
    this.addCommand({
      id: "open-dkg-dashboard",
      name: "Open dashboard",
      callback: () => this.activateDashboard(),
    });

    this.addCommand({
      id: "test-dkg-connection",
      name: "Test connection",
      callback: () => this.testConnection(),
    });

    this.addCommand({
      id: "connect-vault",
      name: "Connect this vault",
      callback: () => new SetupWizardModal(this).open(),
    });

    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.sync.syncFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "create-shared-dkg-project",
      name: "Create shared project",
      callback: () => new CreateProjectModal(this, () => this.updateStatusBar()).open(),
    });

    this.addCommand({
      id: "join-shared-dkg-project",
      name: "Join shared project",
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
        if (!checking) void this.unshareNote(file);
        return true;
      },
    });

    // Register vault listeners only after layout is ready: Obsidian fires a
    // "create" event for every existing file during initial load, and handling
    // those would trigger a full re-sync on every startup.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile) this.sync.scheduleAutoSync(file);
        })
      );
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile) this.sync.scheduleAutoSync(file);
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if (file instanceof TFile) void this.sync.handleRename(file, oldPath);
        })
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (file instanceof TFile) void this.sync.handleDelete(file);
        })
      );
      this.maybeShowSetupPrompt();
    });
  }

  onunload() {
    this.sync.dispose();
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

  updateStatusBar() {
    if (!this.statusBarEl) return;
    this.setStatusBarText();
    this.refreshDashboard();
  }

  private setStatusBarText(): void {
    const project = this.settings.defaultContextGraphId || "unlinked";
    const sync = this.settings.autoSync ? "synced" : "auto-sync off";
    this.statusBarEl.setText(`DKG: ${project} · ${sync}`);
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

  /** Refresh only the dashboard's "This note" section (cheap — no network calls). */
  refreshDashboardNote(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DKG_DASHBOARD_VIEW)) {
      const view = leaf.view;
      if (view instanceof DkgDashboardView) view.refreshNote();
    }
  }

  /** Transient status-bar feedback while a sync is in flight (driven by SyncController). */
  setStatusSyncing(): void {
    if (this.savedStatusTimer !== null) {
      window.clearTimeout(this.savedStatusTimer);
      this.savedStatusTimer = null;
    }
    this.statusBarEl.setText("DKG: syncing…");
  }

  setStatusSaved(): void {
    this.statusBarEl.setText("DKG: saved ✓");
    // A finished sync only changes the "This note" card — re-rendering the
    // whole dashboard here would refire its readiness/connection checks on
    // every autosave.
    this.refreshDashboardNote();
    this.savedStatusTimer = window.setTimeout(() => {
      this.savedStatusTimer = null;
      this.setStatusBarText();
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
    await this.sync.ensureAgentAddress();
    const results = await syncAllMarkdownFiles(
      this.app,
      client,
      this.sync.syncOptions(),
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

  async unshareNote(file: TFile) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      delete fm.shared_to;
      delete fm.shared;
    });
    new Notice(
      `"${file.basename}" is now private. Any copy already shared to a project stays there until discarded.`,
      8000
    );
    await this.sync.syncFile(file);
  }

  private maybeShowSetupPrompt() {
    if (this.settings.defaultContextGraphId || this.settings.hasCompletedSetup) return;
    new SetupWizardModal(this).open();
  }
}
