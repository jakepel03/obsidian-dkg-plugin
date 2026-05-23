import { Notice, Plugin, TFile, requestUrl } from "obsidian";
import { DkgClient } from "./dkgClient";
import { makeVaultId, slugifyContextGraphId } from "./identity";
import { syncAllMarkdownFiles, syncMarkdownFile, shouldSkipPath } from "./noteSync";
import { OriginTrailSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type OriginTrailSettings } from "./types";
import { SetupWizardModal } from "./wizard";
import { errorMessage } from "./utils";

export default class OriginTrailSharedMemoryPlugin extends Plugin {
  settings: OriginTrailSettings;
  private statusBarEl: HTMLElement;
  private pendingSyncTimers = new Map<string, number>();

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
      callback: () =>
        this.createProjectFromVaultAndSyncNotes().catch((err) => {
          console.error(err);
          new Notice(`Create/sync failed: ${errorMessage(err)}`, 12000);
        }),
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

  updateStatusBar() {
    if (!this.statusBarEl) return;
    const project = this.settings.defaultContextGraphId || "unlinked";
    const layer = this.settings.autoPromote ? "Shared Memory" : "Working Memory";
    const sync = this.settings.autoSync ? "auto-sync on" : "auto-sync off";
    this.statusBarEl.setText(`DKG: ${project} · ${layer} · ${sync}`);
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
    const results = await syncAllMarkdownFiles(
      this.app,
      client,
      this.settings.defaultContextGraphId,
      this.settings.vaultId,
      this.settings.autoPromote,
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

  async syncFile(file: TFile) {
    if (!this.settings.defaultContextGraphId) {
      new Notice('This vault is not powered up yet. Run "Power up current vault with OriginTrail DKG" first.');
      return;
    }
    if (file.extension !== "md" || shouldSkipPath(file.path)) return;

    try {
      const result = await syncMarkdownFile(
        this.app,
        this.client(),
        this.settings.defaultContextGraphId,
        this.settings.vaultId,
        file,
        this.settings.autoPromote
      );
      new Notice(`DKG ${result.status}: ${file.path}`);
    } catch (error) {
      console.error(error);
      new Notice(`DKG sync failed for ${file.path}: ${errorMessage(error)}`, 10000);
    }
  }

  private scheduleAutoSync(file: TFile) {
    if (!this.settings.autoSync || !this.settings.defaultContextGraphId) return;
    if (file.extension !== "md" || shouldSkipPath(file.path)) return;

    const existing = this.pendingSyncTimers.get(file.path);
    if (existing) window.clearTimeout(existing);

    const timer = window.setTimeout(() => {
      this.pendingSyncTimers.delete(file.path);
      this.syncFile(file);
    }, this.settings.syncDebounceMs);
    this.pendingSyncTimers.set(file.path, timer);
  }

  private maybeShowPowerUpPrompt() {
    if (this.settings.defaultContextGraphId || this.settings.hasSeenPowerUpPrompt) return;
    new SetupWizardModal(this).open();
  }
}
