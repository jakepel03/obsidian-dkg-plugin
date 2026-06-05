import { ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type OriginTrailSharedMemoryPlugin from "./main";
import { slugifyContextGraphId } from "./identity";
import { errorMessage } from "./utils";

export class CreateProjectModal extends Modal {
  private name = "";
  private mode: "curated" | "open" = "curated";
  private inviteCode = "";
  private cgName = "";

  constructor(
    private readonly plugin: OriginTrailSharedMemoryPlugin,
    private readonly onDone?: () => void
  ) {
    super(plugin.app);
  }

  onOpen() {
    this.renderForm();
  }

  onClose() {
    this.contentEl.empty();
  }

  private renderForm() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Create shared project" });

    new Setting(contentEl)
      .setName("Project name")
      .setDesc("Display name for this shared project.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. Team Research")
          .setValue(this.name)
          .onChange((v) => (this.name = v.trim()))
      );

    new Setting(contentEl)
      .setName("Access mode")
      .setDesc("Curated: only invited agents can write. Open: any subscriber can write.")
      .addDropdown((dd) =>
        dd
          .addOption("curated", "Curated (invite-only)")
          .addOption("open", "Open (any subscriber)")
          .setValue(this.mode)
          .onChange((v) => (this.mode = v as "curated" | "open"))
      );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Create project")
        .setCta()
        .onClick(() => this.create(btn))
    );
  }

  private async create(btn: ButtonComponent) {
    if (!this.name) {
      new Notice("Enter a project name.");
      return;
    }

    btn.setButtonText("Creating…").setDisabled(true);

    try {
      const client = this.plugin.client();
      const identity = await client.getIdentity();
      const cgId = slugifyContextGraphId(this.name);

      // Curated: private allowlist + curated write. Open: public subscribe + open write.
      const createFn =
        this.mode === "curated"
          ? () => client.createContextGraph(cgId, this.name, { accessPolicy: 1, publishPolicy: 0 })
          : () => client.createContextGraph(cgId, this.name, { accessPolicy: 0, publishPolicy: 1 });

      try {
        await createFn();
      } catch (err) {
        const msg = errorMessage(err);
        if (!/409|conflict|already/i.test(msg)) throw err;
      }

      this.inviteCode = this.mode === "curated" ? `${cgId}\n${identity.peerId}` : cgId;

      this.cgName = this.name;

      const already = this.plugin.settings.subscribedContextGraphs.find((c) => c.id === cgId);
      if (!already) {
        this.plugin.settings.subscribedContextGraphs.push({
          id: cgId,
          name: this.name,
          role: "owner",
          curated: this.mode === "curated",
        });
        await this.plugin.saveSettings();
      }

      this.renderCreated();
      this.onDone?.();
    } catch (err) {
      new Notice(`Failed to create project: ${errorMessage(err)}`, 10000);
      btn.setButtonText("Create project").setDisabled(false);
    }
  }

  private renderCreated() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Project created!" });
    contentEl.createEl("p", {
      text: `"${this.cgName}" is ready. Share the invite code below with teammates so they can join.`,
    });

    const codeEl = contentEl.createEl("code");
    codeEl.style.cssText =
      "display: block; padding: 10px; background: var(--background-secondary);" +
      " border-radius: 6px; word-break: break-all; margin: 8px 0; font-size: 0.82em; white-space: pre-wrap;";
    codeEl.setText(this.inviteCode);

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Copy invite code")
          .setCta()
          .onClick(async () => {
            await navigator.clipboard.writeText(this.inviteCode);
            btn.setButtonText("Copied!");
            setTimeout(() => btn.setButtonText("Copy invite code"), 2000);
          })
      )
      .addButton((btn) => btn.setButtonText("Close").onClick(() => this.close()));
  }
}
