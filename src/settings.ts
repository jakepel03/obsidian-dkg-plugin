import { App, ButtonComponent, PluginSettingTab, Setting } from "obsidian";
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

    containerEl.createEl("h2", { text: "OriginTrail DKG" });

    const isLinked = Boolean(this.plugin.settings.defaultContextGraphId);

    // ── Status / Getting started ─────────────────────────────────────────────
    if (!isLinked) {
      containerEl.createEl("h3", { text: "Getting started" });

      new Setting(containerEl)
        .setName("This vault is not yet connected to a DKG node")
        .setDesc("Run the setup wizard to point the plugin at a DKG node and import your existing notes.")
        .addButton((btn) =>
          btn
            .setButtonText("Run setup wizard")
            .setCta()
            .onClick(() => new SetupWizardModal(this.plugin).open())
        );
    } else {
      containerEl.createEl("h3", { text: "Status" });

      const card = containerEl.createDiv();
      card.style.cssText =
        "display: flex; align-items: flex-start; justify-content: space-between;" +
        " background: var(--background-secondary); border-radius: 8px;" +
        " border-left: 3px solid var(--interactive-accent); padding: 12px 16px; margin: 4px 0 16px;";

      const info = card.createDiv();
      info.style.cssText = "display: flex; flex-direction: column; gap: 6px;";

      const makeRow = (label: string, value: string) => {
        const row = info.createDiv();
        row.style.cssText = "display: flex; gap: 10px; font-size: 0.88em; line-height: 1.4;";
        const lbl = row.createEl("span", { text: label });
        lbl.style.cssText = "color: var(--text-muted); min-width: 80px;";
        row.createEl("span", { text: value });
      };

      makeRow("DKG Project", this.plugin.settings.defaultContextGraphId);
      makeRow("Node", this.plugin.settings.dkgNodeUrl || "(not set)");

      const reconfigBtn = new ButtonComponent(card);
      reconfigBtn.setButtonText("Reconfigure →");
      reconfigBtn.buttonEl.style.cssText =
        "background: none; box-shadow: none; color: var(--text-muted); font-size: 0.85em; padding: 0; margin-top: 2px;";
      reconfigBtn.onClick(() => new SetupWizardModal(this.plugin).open());
    }

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

    // ── Sync behaviour ───────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync behaviour" });

    new Setting(containerEl)
      .setName("Auto-sync saved notes")
      .setDesc("Imports saved Markdown notes into DKG Working Memory for the linked DKG Project.")
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

    // ── Advanced ─────────────────────────────────────────────────────────────
    const details = containerEl.createEl("details");
    details.style.cssText = "margin-top: 28px;";
    const summary = details.createEl("summary");
    summary.style.cssText =
      "cursor: pointer; color: var(--text-muted); font-size: 0.88em; user-select: none; list-style: none;";
    summary.setText("▸ Advanced");
    details.addEventListener("toggle", () => {
      summary.setText(details.open ? "▾ Advanced" : "▸ Advanced");
    });

    const advancedEl = details.createDiv();
    advancedEl.style.cssText = "margin-top: 8px;";

    new Setting(advancedEl)
      .setName("Linked DKG Project")
      .setDesc(
        this.plugin.settings.defaultContextGraphId
          ? "Context graph identifier for this vault. Normally set by the wizard — only edit if you know what you are doing."
          : "No DKG Project linked yet — run the setup wizard."
      )
      .addText((text) =>
        text
          .setPlaceholder("dkg project id")
          .setValue(this.plugin.settings.defaultContextGraphId)
          .onChange(async (value) => {
            this.plugin.settings.defaultContextGraphId = value.trim();
            await this.plugin.saveSettings();
            this.plugin.updateStatusBar();
          })
      );
  }
}
