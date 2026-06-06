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
  private step: 1 | 2 | 3 = 1;
  private connectionTested = false;
  private syncedCount = 0;
  private readonly initialUrl: string;
  private readonly initialToken: string;

  constructor(
    private readonly plugin: WizardPlugin,
    private readonly onAfterClose?: () => void
  ) {
    super(plugin.app);
    this.initialUrl = plugin.settings.dkgNodeUrl;
    this.initialToken = plugin.settings.authToken;
  }

  onOpen() {
    this.renderStep();
  }

  onClose() {
    this.contentEl.empty();
    this.plugin.settings.hasCompletedSetup = true;
    if (this.step < 3) {
      // Wizard didn't complete — discard any credential edits from step 1
      this.plugin.settings.dkgNodeUrl = this.initialUrl;
      this.plugin.settings.authToken = this.initialToken;
    } else {
      this.onAfterClose?.();
    }
    void this.plugin.saveSettings();
  }

  private renderStep() {
    const { contentEl } = this;
    contentEl.empty();
    this.renderProgressIndicator();
    if (this.step === 1) this.renderStep1();
    else if (this.step === 2) this.renderStep2();
    else this.renderStep3();
  }

  private renderProgressIndicator() {
    const { contentEl } = this;
    const steps = ["Connect", "Import", "Done"];
    const wrapper = contentEl.createDiv({ cls: "dkg-progress-bar-row" });

    steps.forEach((label, i) => {
      const stepNum = (i + 1) as 1 | 2 | 3;
      const isActive = stepNum === this.step;
      const isDone = stepNum < this.step;

      const pill = wrapper.createDiv({ cls: "dkg-progress-pill" });

      const bar = pill.createDiv({ cls: "dkg-step-bar" });
      if (isActive || isDone) bar.addClass("is-active");

      const lbl = pill.createEl("span", { cls: "dkg-step-label", text: label });
      if (isActive) lbl.addClass("is-active");
    });
  }

  private wizardFooter(el: HTMLElement): HTMLElement {
    return el.createDiv({ cls: "dkg-wizard-footer" });
  }

  private ghostButton(container: HTMLElement, label: string): ButtonComponent {
    const btn = new ButtonComponent(container).setButtonText(label);
    btn.buttonEl.addClass("dkg-ghost-btn");
    return btn;
  }

  private renderStep1() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Connect to your DKG node" });
    contentEl.createEl("p", {
      text: "This wizard links your vault to a DKG node so your notes can be stored as structured knowledge. Start by pointing the plugin at your node and verifying the connection.",
    });

    const IDLE_DESC = "Verify that the plugin can reach your DKG node with the credentials above.";
    const refs: { nextBtn?: ButtonComponent; testSetting?: Setting } = {};

    const invalidateTest = () => {
      this.connectionTested = false;
      refs.nextBtn?.setDisabled(true);
      if (refs.testSetting) {
        refs.testSetting.setDesc(IDLE_DESC);
        refs.testSetting.descEl.removeClasses(["dkg-status-ok", "dkg-status-error"]);
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

    refs.testSetting = new Setting(contentEl).setName("Test connection").setDesc(IDLE_DESC);

    refs.testSetting.addButton((btn) => {
      btn.setButtonText("Test").onClick(async () => {
        const ok = await runConnectionTest(this.plugin.client(), refs.testSetting!, btn);
        if (ok) {
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

    contentEl.createEl("h2", { text: "Import your notes" });
    contentEl.createEl("p", {
      text: "This links a DKG project to your vault and imports all your Markdown notes into it. Everything stays private to your own node until you choose to share a note to a project.",
    });

    const infoBox = contentEl.createDiv({ cls: "dkg-info-box" });
    infoBox.createEl("div", { text: `Vault: ${vaultName}` });
    infoBox.createEl("div", { text: `DKG Project: ${contextGraphId}` });

    const statusEl = contentEl.createEl("p", { cls: "dkg-wizard-status", text: "" });

    // Footer: [← Back] ........... [Import notes]
    const footer = this.wizardFooter(contentEl);
    const backBtn = this.ghostButton(footer, "← Back");
    const powerBtn = new ButtonComponent(footer);

    backBtn.onClick(() => {
      this.step = 1;
      this.connectionTested = false;
      this.renderStep();
    });

    powerBtn
      .setButtonText("Import notes")
      .setCta()
      .onClick(async () => {
        powerBtn.setDisabled(true);
        powerBtn.setButtonText("Working...");
        backBtn.setDisabled(true);
        statusEl.removeClass("dkg-status-error");
        try {
          this.syncedCount = await this.plugin.createProjectFromVaultAndSyncNotes({
            onStatus: (msg) => statusEl.setText(msg),
            onProgress: (done, total) => statusEl.setText(`Syncing... ${done + 1} / ${total}`),
          });
          this.step = 3;
          this.renderStep();
        } catch (err) {
          statusEl.setText(`Failed: ${errorMessage(err)}`);
          statusEl.addClass("dkg-status-error");
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
      text: `Vault linked to DKG project "${this.plugin.settings.defaultContextGraphId}". ${this.syncedCount} note${this.syncedCount === 1 ? "" : "s"} imported privately to your vault graph.`,
    });
    contentEl.createEl("p", {
      text: "Auto-sync is now on, so your notes stay in sync with your DKG node. Everything is private until you share a note to a project.",
    });
    contentEl.createEl("p", {
      text: "You can change these settings at any time from Settings → OriginTrail DKG.",
    });

    const footer = this.wizardFooter(contentEl);
    footer.addClass("end");
    new ButtonComponent(footer)
      .setButtonText("Close")
      .setCta()
      .onClick(() => this.close());
  }
}
