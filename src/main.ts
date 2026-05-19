import { ButtonComponent, Modal, Notice, Plugin, Setting, TFile, requestUrl } from "obsidian";
import { DkgClient } from "./dkgClient";
import { makeVaultId, slugifyContextGraphId } from "./identity";
import { syncAllMarkdownFiles, syncMarkdownFile, shouldSkipPath } from "./noteSync";
import { OriginTrailSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type OriginTrailSettings } from "./types";

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
      name: "Power up current vault with OriginTrail Shared Memory",
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
      new Notice(
        'This vault is not powered up yet. Run "Power up current vault with OriginTrail Shared Memory" first.'
      );
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

export class SetupWizardModal extends Modal {
  private step = 1;
  private connectionTested = false;
  private syncedCount = 0;

  constructor(private readonly plugin: OriginTrailSharedMemoryPlugin) {
    super(plugin.app);
  }

  onOpen() {
    this.renderStep();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.plugin.settings.hasSeenPowerUpPrompt) {
      this.plugin.settings.hasSeenPowerUpPrompt = true;
      this.plugin.saveSettings();
    }
  }

  private renderStep() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.step === 1) this.renderStep1();
    else if (this.step === 2) this.renderStep2();
    else this.renderStep3();
  }

  private wizardFooter(el: HTMLElement): HTMLElement {
    const footer = el.createDiv();
    footer.style.cssText =
      "display: flex; justify-content: space-between; align-items: center;" +
      " margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--background-modifier-border);";
    return footer;
  }

  private ghostButton(container: HTMLElement, label: string): ButtonComponent {
    const btn = new ButtonComponent(container).setButtonText(label);
    btn.buttonEl.style.cssText = "background: none; box-shadow: none; color: var(--text-muted);";
    return btn;
  }

  private renderStep1() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Step 1 of 3 — Connect to your DKG node" });

    let nextBtn: ButtonComponent | undefined;
    let testSetting: Setting | undefined;
    const IDLE_DESC = "Verify that the plugin can reach your DKG node with the credentials above.";

    const invalidateTest = () => {
      this.connectionTested = false;
      nextBtn?.setDisabled(true);
      if (testSetting) {
        testSetting.setDesc(IDLE_DESC);
        testSetting.descEl.style.color = "";
      }
    };

    new Setting(contentEl).setName("DKG node URL").addText((text) => {
      text.setPlaceholder("http://127.0.0.1:9200").setValue(this.plugin.settings.dkgNodeUrl);
      text.inputEl.addEventListener("input", () => {
        this.plugin.settings.dkgNodeUrl = text.getValue().trim();
        invalidateTest();
      });
    });

    new Setting(contentEl)
      .setName("Auth token")
      .setDesc("Auth token from your DKG node.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Paste DKG auth token").setValue(this.plugin.settings.authToken);
        text.inputEl.addEventListener("input", () => {
          this.plugin.settings.authToken = text.getValue().trim();
          invalidateTest();
        });
      });

    testSetting = new Setting(contentEl).setName("Test connection").setDesc(IDLE_DESC);

    testSetting.addButton((btn) => {
      btn.setButtonText("Test").onClick(async () => {
        btn.setButtonText("Testing...");
        btn.setDisabled(true);
        testSetting!.setDesc("Connecting...");
        testSetting!.descEl.style.color = "var(--text-muted)";

        let nodeOk = false;
        try {
          const client = this.plugin.client();
          await client.status();
          nodeOk = true;

          await client.identity();
          testSetting!.setDesc("Connected — node reachable, identity verified");
          testSetting!.descEl.style.color = "var(--color-green)";

          await this.plugin.saveSettings();
          this.connectionTested = true;
          nextBtn?.setDisabled(false);
        } catch (err) {
          console.error("[DKG wizard] connection test failed:", err);
          testSetting!.setDesc(
            nodeOk
              ? "Node reachable but identity check failed — check your auth token"
              : "Could not reach node — check the URL and that your node is running"
          );
          testSetting!.descEl.style.color = "var(--color-red)";
          this.connectionTested = false;
          nextBtn?.setDisabled(true);
        } finally {
          btn.setButtonText("Test");
          btn.setDisabled(false);
        }
      });
    });

    // Footer: [Maybe later] ........... [Next →]
    const footer = this.wizardFooter(contentEl);
    this.ghostButton(footer, "Maybe later").onClick(async () => {
      this.plugin.settings.hasSeenPowerUpPrompt = true;
      await this.plugin.saveSettings();
      this.close();
    });
    nextBtn = new ButtonComponent(footer);
    nextBtn
      .setButtonText("Next →")
      .setCta()
      .setDisabled(!this.connectionTested)
      .onClick(() => {
        this.step = 2;
        this.renderStep();
      });
  }

  private renderStep2() {
    const { contentEl } = this;
    const vaultName = this.plugin.app.vault.getName();
    const contextGraphId = slugifyContextGraphId(vaultName);

    contentEl.createEl("h2", { text: "Step 2 of 3 — Power up this vault" });
    contentEl.createEl("p", {
      text: "Power up creates a DKG Project linked to this vault and imports all Markdown notes into Working Memory. Shared Memory promotion stays off until you enable it in Settings.",
    });

    const infoBox = contentEl.createDiv();
    infoBox.style.cssText =
      "background: var(--background-secondary); border-radius: 6px;" +
      " padding: 10px 14px; margin: 12px 0; font-size: 0.9em; line-height: 1.8;";
    infoBox.createEl("div", { text: `Vault: ${vaultName}` });
    infoBox.createEl("div", { text: `Context graph: ${contextGraphId}` });

    const statusEl = contentEl.createEl("p", { text: "" });
    statusEl.style.cssText = "min-height: 1.4em; font-size: 0.9em; color: var(--text-muted);";

    // Footer: [← Back] ........... [Power up vault]
    const footer = this.wizardFooter(contentEl);
    const backBtn = this.ghostButton(footer, "← Back");
    const powerBtn = new ButtonComponent(footer);

    backBtn.onClick(() => {
      this.step = 1;
      this.connectionTested = false;
      this.renderStep();
    });

    powerBtn
      .setButtonText("Power up vault")
      .setCta()
      .onClick(async () => {
        powerBtn.setDisabled(true);
        powerBtn.setButtonText("Working...");
        backBtn.setDisabled(true);
        statusEl.style.color = "var(--text-muted)";
        try {
          this.syncedCount = await this.plugin.createProjectFromVaultAndSyncNotes({
            onStatus: (msg) => statusEl.setText(msg),
            onProgress: (done, total) => statusEl.setText(`Syncing... ${done + 1} / ${total}`),
          });
          this.step = 3;
          this.renderStep();
        } catch (err) {
          statusEl.setText(`Failed: ${errorMessage(err)}`);
          statusEl.style.color = "var(--color-red)";
          powerBtn.setDisabled(false);
          powerBtn.setButtonText("Retry");
          backBtn.setDisabled(false);
        }
      });
  }

  private renderStep3() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "All done!" });
    contentEl.createEl("p", {
      text: `Vault linked to DKG Project "${this.plugin.settings.defaultContextGraphId}". ${this.syncedCount} note${this.syncedCount === 1 ? "" : "s"} synced to Working Memory.`,
    });
    contentEl.createEl("p", {
      text: "Auto-sync is now on. Shared Memory promotion is off by default — enable it in Settings when ready.",
    });

    const footer = this.wizardFooter(contentEl);
    footer.style.justifyContent = "flex-end";
    new ButtonComponent(footer).setButtonText("Close").setCta().onClick(() => this.close());
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
