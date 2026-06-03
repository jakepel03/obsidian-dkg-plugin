import { Modal, Notice, Setting } from "obsidian";
import type OriginTrailSharedMemoryPlugin from "./main";
import { errorMessage } from "./utils";

export class ManageMembersModal extends Modal {
  private addAddressInput = "";

  constructor(
    private readonly plugin: OriginTrailSharedMemoryPlugin,
    private readonly contextGraphId: string,
    private readonly projectName: string,
    private readonly curated?: boolean
  ) {
    super(plugin.app);
  }

  onOpen() {
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Manage members — ${this.projectName}` });

    const client = this.plugin.client();

    // ── Invite code ───────────────────────────────────────────────────────────
    contentEl.createEl("h3", { text: "Invite code" });
    const inviteContainer = contentEl.createDiv();

    if (this.curated === false) {
      const inviteCode = this.contextGraphId;
      const codeEl = inviteContainer.createEl("code");
      codeEl.style.cssText =
        "display: block; padding: 10px; background: var(--background-secondary);" +
        " border-radius: 6px; word-break: break-all; margin: 8px 0; font-size: 0.82em; white-space: pre-wrap;";
      codeEl.setText(inviteCode);
      const desc = inviteContainer.createEl("p", { text: "Share this ID with teammates. They paste it into 'Join shared project'." });
      desc.style.cssText = "color: var(--text-muted); font-size: 0.85em; margin: 0 0 8px;";
      new Setting(inviteContainer)
        .addButton((btn) =>
          btn
            .setButtonText("Copy invite code")
            .setCta()
            .onClick(async () => {
              await navigator.clipboard.writeText(inviteCode);
              btn.setButtonText("Copied!");
              setTimeout(() => btn.setButtonText("Copy invite code"), 2000);
            })
        );
    } else {
      const statusEl = inviteContainer.createEl("p", { text: "Loading…" });
      statusEl.style.color = "var(--text-muted)";

      client.getIdentity().then((identity) => {
        inviteContainer.empty();
        const inviteCode = `${this.contextGraphId}\n${identity.peerId}`;
        const codeEl = inviteContainer.createEl("code");
        codeEl.style.cssText =
          "display: block; padding: 10px; background: var(--background-secondary);" +
          " border-radius: 6px; word-break: break-all; margin: 8px 0; font-size: 0.82em; white-space: pre-wrap;";
        codeEl.setText(inviteCode);
        new Setting(inviteContainer)
          .addButton((btn) =>
            btn
              .setButtonText("Copy invite code")
              .setCta()
              .onClick(async () => {
                await navigator.clipboard.writeText(inviteCode);
                btn.setButtonText("Copied!");
                setTimeout(() => btn.setButtonText("Copy invite code"), 2000);
              })
          );
      }).catch(() => {
        statusEl.setText("Could not load invite code.");
        statusEl.style.color = "var(--color-red)";
      });
    }

    // Fetch data in parallel
    let participants: string[] = [];
    let joinRequests: any[] = [];

    const loadingEl = contentEl.createEl("p", { text: "Loading…" });
    loadingEl.style.color = "var(--text-muted)";

    try {
      [{ allowedAgents: participants }, joinRequests] = await Promise.all([
        client.listParticipants(this.contextGraphId).catch(() => ({ allowedAgents: [] })),
        client.listJoinRequests(this.contextGraphId).catch(() => []),
      ]);
    } catch (err) {
      loadingEl.setText(`Failed to load: ${errorMessage(err)}`);
      loadingEl.style.color = "var(--color-red)";
      return;
    }

    loadingEl.remove();

    // ── Pending join requests ─────────────────────────────────────────────────
    if (joinRequests.length > 0) {
      contentEl.createEl("h3", { text: "Pending join requests" });

      for (const req of joinRequests) {
        const addr: string = req.agentAddress ?? req.delegation?.agentAddress ?? "(unknown)";
        const label = req.agentName ? `${req.agentName} (${addr})` : addr;

        new Setting(contentEl)
          .setName(label)
          .addButton((btn) =>
            btn
              .setButtonText("Approve")
              .setCta()
              .onClick(async () => {
                btn.setButtonText("Approving…").setDisabled(true);
                try {
                  await client.approveJoinRequest(this.contextGraphId, addr);
                  new Notice(`Approved ${label}`);
                  this.render();
                } catch (err) {
                  new Notice(`Approve failed: ${errorMessage(err)}`, 8000);
                  btn.setButtonText("Approve").setDisabled(false);
                }
              })
          );
      }
    }

    // ── Current members ───────────────────────────────────────────────────────
    contentEl.createEl("h3", { text: "Current members" });

    if (participants.length === 0) {
      contentEl.createEl("p", { text: "No members yet." }).style.color = "var(--text-muted)";
    } else {
      for (const addr of participants) {
        new Setting(contentEl)
          .setName(addr)
          .addButton((btn) =>
            btn
              .setButtonText("Remove")
              .setWarning()
              .onClick(async () => {
                btn.setButtonText("Removing…").setDisabled(true);
                try {
                  await client.removeParticipant(this.contextGraphId, addr);
                  new Notice(`Removed ${addr}`);
                  this.render();
                } catch (err) {
                  new Notice(`Remove failed: ${errorMessage(err)}`, 8000);
                  btn.setButtonText("Remove").setDisabled(false);
                }
              })
          );
      }
    }

    // ── Add member ────────────────────────────────────────────────────────────
    contentEl.createEl("h3", { text: "Add member" });

    new Setting(contentEl)
      .setName("Agent address")
      .setDesc("Ethereum address of the agent to invite.")
      .addText((text) =>
        text
          .setPlaceholder("0x…")
          .setValue(this.addAddressInput)
          .onChange((v) => (this.addAddressInput = v.trim()))
      )
      .addButton((btn) =>
        btn
          .setButtonText("Add")
          .setCta()
          .onClick(async () => {
            if (!this.addAddressInput) {
              new Notice("Enter an agent address.");
              return;
            }
            btn.setButtonText("Adding…").setDisabled(true);
            try {
              await client.addParticipant(this.contextGraphId, this.addAddressInput);
              new Notice(`Added ${this.addAddressInput}`);
              this.addAddressInput = "";
              this.render();
            } catch (err) {
              new Notice(`Add failed: ${errorMessage(err)}`, 8000);
              btn.setButtonText("Add").setDisabled(false);
            }
          })
      );
  }
}
