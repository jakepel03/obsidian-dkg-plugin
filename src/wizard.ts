import { App, ButtonComponent, Modal, Setting, TFile } from "obsidian";
import { slugifyContextGraphId } from "./identity";
import type { DkgClient } from "./dkgClient";
import { errorMessage, runConnectionTest } from "./utils";
import type { OriginTrailSettings } from "./types";

interface WizardPlugin {
  readonly app: App;
  settings: OriginTrailSettings;
  saveSettings(): Promise<void>;
  client(): DkgClient;
  createProjectFromVaultAndSyncNotes(opts?: {
    onStatus?: (msg: string) => void;
    onProgress?: (done: number, total: number, file: TFile) => void;
  }): Promise<number>;
}

export class SetupWizardModal extends Modal {
  private step = 1;
  private connectionTested = false;
  private syncedCount = 0;

  constructor(private readonly plugin: WizardPlugin) {
    super(plugin.app);
  }

  onOpen() {
    this.renderStep();
  }

  onClose() {
    this.contentEl.empty();
    this.plugin.settings.hasSeenPowerUpPrompt = true;
    void this.plugin.saveSettings();
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

    const IDLE_DESC = "Verify that the plugin can reach your DKG node with the credentials above.";
    const refs: { nextBtn?: ButtonComponent; testSetting?: Setting } = {};

    const invalidateTest = () => {
      this.connectionTested = false;
      refs.nextBtn?.setDisabled(true);
      if (refs.testSetting) {
        refs.testSetting.setDesc(IDLE_DESC);
        refs.testSetting.descEl.style.color = "";
      }
    };

    new Setting(contentEl).setName("DKG node URL").addText((text) => {
      text.setPlaceholder("http://127.0.0.1:9200").setValue(this.plugin.settings.dkgNodeUrl);
      text.inputEl.addEventListener("input", () => {
        this.plugin.settings.dkgNodeUrl = text.getValue().trim();
        void this.plugin.saveSettings();
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
          void this.plugin.saveSettings();
          invalidateTest();
        });
      });

    refs.testSetting = new Setting(contentEl).setName("Test connection").setDesc(IDLE_DESC);

    refs.testSetting.addButton((btn) => {
      btn.setButtonText("Test").onClick(async () => {
        const ok = await runConnectionTest(this.plugin.client(), refs.testSetting!, btn);
        if (ok) {
          await this.plugin.saveSettings();
          this.connectionTested = true;
          refs.nextBtn?.setDisabled(false);
        } else {
          this.connectionTested = false;
          refs.nextBtn?.setDisabled(true);
        }
      });
    });

    // Footer: [Maybe later] ........... [Next →]
    const footer = this.wizardFooter(contentEl);
    this.ghostButton(footer, "Maybe later").onClick(() => this.close());
    refs.nextBtn = new ButtonComponent(footer);
    refs.nextBtn
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
    new ButtonComponent(footer)
      .setButtonText("Close")
      .setCta()
      .onClick(() => this.close());
  }
}

