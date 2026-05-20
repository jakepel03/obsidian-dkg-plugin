import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type OriginTrailSharedMemoryPlugin from "./main";
import { SetupWizardModal } from "./wizard";
import { runConnectionTest } from "./utils";

export class OriginTrailSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: OriginTrailSharedMemoryPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "OriginTrail Shared Memory" });

    // ── Setup ────────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Setup" });

    new Setting(containerEl)
      .setName("Setup wizard")
      .setDesc("Re-run the step-by-step setup to connect to a DKG node and power up this vault.")
      .addButton((btn) =>
        btn.setButtonText("Run setup wizard").onClick(() => new SetupWizardModal(this.plugin).open())
      );

    // ── Connection ───────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("DKG node URL")
      .setDesc("Local DKG node API base URL.")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:9200")
          .setValue(this.plugin.settings.dkgNodeUrl)
          .onChange(async (value) => {
            this.plugin.settings.dkgNodeUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("Bearer token for the local DKG node. Stored only in this vault's plugin data.json.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Paste DKG auth token")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    const CONN_IDLE_DESC = "Checks /api/status and /api/agent/identity with the current settings.";
    const testConnSetting = new Setting(containerEl).setName("Test connection").setDesc(CONN_IDLE_DESC);
    testConnSetting.addButton((btn) => {
      btn.setButtonText("Test").onClick(async () => {
        const skipIdentity = !this.plugin.settings.authToken.trim();
        await runConnectionTest(this.plugin.client(), testConnSetting, btn, skipIdentity);
      });
    });

    // ── Vault ────────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Vault" });

    new Setting(containerEl)
      .setName("Linked DKG Project")
      .setDesc(
        this.plugin.settings.defaultContextGraphId
          ? "The DKG context graph ID for this vault's project."
          : "No project linked yet — run the setup wizard."
      )
      .addText((text) =>
        text
          .setPlaceholder("context graph id")
          .setValue(this.plugin.settings.defaultContextGraphId)
          .onChange(async (value) => {
            this.plugin.settings.defaultContextGraphId = value.trim();
            await this.plugin.saveSettings();
            this.plugin.updateStatusBar();
          })
      );

    new Setting(containerEl)
      .setName("Power up vault")
      .setDesc("Creates/links a DKG Project from this vault name and imports all Markdown notes into Working Memory.")
      .addButton((btn) =>
        btn
          .setButtonText("Power up vault")
          .setCta()
          .onClick(() =>
            this.plugin.createProjectFromVaultAndSyncNotes().catch((err) => {
              console.error(err);
              new Notice(`Create/sync failed: ${err instanceof Error ? err.message : String(err)}`, 12000);
            })
          )
      );

    // ── Sync behaviour ───────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync behaviour" });

    new Setting(containerEl)
      .setName("Auto-sync saved notes")
      .setDesc("Imports saved Markdown notes into DKG Working Memory for the linked Project.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
          this.plugin.updateStatusBar();
        })
      );

    new Setting(containerEl)
      .setName("Promote to Shared Memory")
      .setDesc(
        "When enabled, synced notes are promoted from Working Memory to Shared Memory. Leave off during early testing."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoPromote).onChange(async (value) => {
          this.plugin.settings.autoPromote = value;
          await this.plugin.saveSettings();
          this.plugin.updateStatusBar();
        })
      );

    new Setting(containerEl)
      .setName("Debounce (ms)")
      .setDesc("Milliseconds to wait after a note is modified before syncing.")
      .addText((text) =>
        text
          .setPlaceholder("1500")
          .setValue(String(this.plugin.settings.syncDebounceMs))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 250) {
              this.plugin.settings.syncDebounceMs = parsed;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
