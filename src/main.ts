import { Notice, Plugin, TFile, requestUrl } from "obsidian";
import { DkgClient } from "./dkgClient";
import { makeVaultId, slugifyContextGraphId } from "./identity";
import { syncAllMarkdownFiles, syncMarkdownFile, shouldSkipPath, type SyncOptions } from "./noteSync";
import { OriginTrailSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type OriginTrailSettings } from "./types";
import { SetupWizardModal } from "./wizard";
import { CreateProjectModal } from "./createProjectModal";
import { JoinProjectModal } from "./joinProjectModal";
import { ShareNoteModal } from "./shareNoteModal";
import { errorMessage } from "./utils";

export default class OriginTrailSharedMemoryPlugin extends Plugin {
  settings: OriginTrailSettings;
  private statusBarEl: HTMLElement;
  private pendingSyncTimers = new Map<string, number>();
  private activeSyncs = 0;
  private hadSyncError = false;
  private savedStatusTimer: number | null = null;
  private cachedAgentAddress?: string;

  async onload() {
    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("origintrail-sm-status");
    this.updateStatusBar();

    this.addSettingTab(new OriginTrailSettingTab(this.app, this));

    this.addCommand({
      id: "test-dkg-connection",
      name: "Test DKG connection",
      callback: () => this.testConnection(),
    });

    this.addCommand({
      id: "create-project-from-current-vault-and-sync-notes",
      name: "Power up current vault with OriginTrail DKG",
      callback: () => new SetupWizardModal(this).open(),
    });

    this.addCommand({
      id: "sync-current-note-to-dkg-working-memory",
      name: "Sync current note to DKG Working Memory",
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

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.scheduleAutoSync(file);
      })
    );

    this.app.workspace.onLayoutReady(() => this.maybeShowPowerUpPrompt());
  }

  onunload() {
    for (const timer of this.pendingSyncTimers.values()) window.clearTimeout(timer);
    this.pendingSyncTimers.clear();
    if (this.savedStatusTimer !== null) window.clearTimeout(this.savedStatusTimer);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.vaultId) {
      this.settings.vaultId = makeVaultId();
      await this.saveSettings();
    }
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
      autoPromote: this.settings.autoPromote,
      subscribedContextGraphs: this.settings.subscribedContextGraphs,
      agentAddress: this.cachedAgentAddress,
    };
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
    const layer = this.settings.autoPromote ? "Shared Memory" : "Working Memory";
    const sync = this.settings.autoSync ? "auto-sync on" : "auto-sync off";
    this.statusBarEl.setText(`DKG: ${project} · ${layer} · ${sync}`);
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
      if (this.settings.authToken.trim()) await client.identity();
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
    this.settings.hasSeenPowerUpPrompt = true;
    await this.saveSettings();
    this.updateStatusBar();

    notify(`Syncing Markdown notes to DKG Working Memory...`);
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
        `DKG Project linked: ${this.settings.defaultContextGraphId}. Synced ${results.length} notes to ${this.settings.autoPromote ? "Shared Memory" : "Working Memory"}.`,
        10000
      );
    }

    return results.length;
  }

  async syncFile(file: TFile, silent = false) {
    if (!this.settings.defaultContextGraphId) {
      new Notice('This vault is not powered up yet. Run "Power up current vault with OriginTrail DKG" first.');
      return;
    }
    if (file.extension !== "md" || shouldSkipPath(file.path)) return;

    if (this.activeSyncs === 0) this.hadSyncError = false;
    this.activeSyncs++;
    this.setStatusSyncing();
    try {
      await this.ensureAgentAddress();
      const result = await syncMarkdownFile(this.app, this.client(), file, this.syncOptions());
      if (result.warning) new Notice(`DKG: ${result.warning}`, 8000);
      if (!silent) new Notice(`DKG ${result.status}: ${file.path}`);
    } catch (error) {
      this.hadSyncError = true;
      console.error(error);
      new Notice(`DKG sync failed for ${file.path}: ${errorMessage(error)}`, 10000);
    } finally {
      this.activeSyncs--;
      if (this.activeSyncs === 0) {
        if (this.hadSyncError) this.updateStatusBar();
        else this.setStatusSaved();
      }
    }
  }

  async unshareNote(file: TFile) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.shared = false;
      delete fm.shared_to;
    });
    new Notice(
      `"${file.basename}" will no longer be promoted on sync. Note: any copy already shared to a project stays there until discarded.`,
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

  private maybeShowPowerUpPrompt() {
    if (this.settings.defaultContextGraphId || this.settings.hasSeenPowerUpPrompt) return;
    new SetupWizardModal(this).open();
  }
}
