import { ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type OriginTrailDkgPlugin from "./main";
import type { DkgClient } from "./dkgClient";
import type { CreateContextGraphResult } from "./types";
import { slugifyContextGraphId } from "./identity";
import { errorMessage } from "./utils";

export class CreateProjectModal extends Modal {
  private name = "";
  private mode: "curated" | "open" = "curated";
  private inviteCode = "";
  private cgName = "";

  constructor(
    private readonly plugin: OriginTrailDkgPlugin,
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
      // Open projects are also registered on-chain (gas-only, no VM publish) so members
      // can read shared note content — see ensureRegistered.
      const isOpen = this.mode === "open";
      let createResult: CreateContextGraphResult | undefined;
      try {
        createResult = isOpen
          ? await client.createContextGraph(cgId, this.name, { accessPolicy: 0, publishPolicy: 1, register: true })
          : await client.createContextGraph(cgId, this.name, { accessPolicy: 1, publishPolicy: 0 });
      } catch (err) {
        const msg = errorMessage(err);
        if (!/409|conflict|already/i.test(msg)) throw err;
      }

      if (isOpen) {
        await this.ensureRegistered(client, cgId, createResult);
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

  /**
   * Open/public projects must be registered on-chain for members to read shared note
   * content — the node's import-artifact read-guard only drops the owner check for a CG
   * registered public+open on-chain (verified live on rc.18). Registration is one-time and
   * gas-only — it does NOT publish notes to Verifiable Memory. Best-effort: if it fails
   * (e.g. the node wallet isn't funded) the project still works locally for triples, but
   * members can't pull note content until it's registered.
   */
  private async ensureRegistered(
    client: DkgClient,
    cgId: string,
    createResult: CreateContextGraphResult | undefined
  ): Promise<void> {
    if (createResult?.registered === true || createResult?.onChainId) return;
    try {
      if ((await client.registerContextGraph(cgId, 0, 1)).onChainId) return;
    } catch {
      // fall through to the warning
    }
    const reason = createResult?.registerError ? ` Reason: ${createResult.registerError}.` : "";
    new Notice(
      "Project created, but on-chain registration failed, so members won't be able to read shared note content yet." +
        `${reason} Make sure your node's wallet is funded, then recreate the project.`,
      14000
    );
  }

  private renderCreated() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Project created!" });
    contentEl.createEl("p", {
      text: `"${this.cgName}" is ready. Share the invite code below with teammates so they can join.`,
    });

    const codeEl = contentEl.createEl("code", { cls: "dkg-code-block" });
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
