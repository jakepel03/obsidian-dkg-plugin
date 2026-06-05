import { Modal, Notice, Setting } from "obsidian";
import type OriginTrailSharedMemoryPlugin from "./main";
import { errorMessage } from "./utils";

export class ManageMembersModal extends Modal {
  constructor(
    private readonly plugin: OriginTrailSharedMemoryPlugin,
    private readonly contextGraphId: string,
    private readonly projectName: string,
    private readonly curated?: boolean
  ) {
    super(plugin.app);
  }

  onOpen() {
    void this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Manage members — ${this.projectName}` });

    const client = this.plugin.client();

    // Resolve my own identity once (best-effort): used for the curated invite
    // code and to mark / protect my own row in the member list.
    let myAddress = "";
    let myPeerId = "";
    try {
      const id = await client.getIdentity();
      myAddress = (id.agentAddress ?? "").toLowerCase();
      myPeerId = id.peerId ?? "";
    } catch {
      // Non-fatal: invite falls back to an error line, self-row just won't be tagged.
    }

    // ── Invite code ───────────────────────────────────────────────────────────
    contentEl.createEl("h3", { text: "Invite code" });
    const desc = contentEl.createEl("p", {
      text: "Share this code with teammates. They paste it into “Join shared project”, then their request appears below for you to approve.",
    });
    desc.style.cssText = "color: var(--text-muted); font-size: 0.85em; margin: 0 0 8px;";

    if (this.curated === false) {
      this.renderInviteCode(contentEl, this.contextGraphId);
    } else if (myPeerId) {
      this.renderInviteCode(contentEl, `${this.contextGraphId}\n${myPeerId}`);
    } else {
      contentEl.createEl("p", { text: "Could not load invite code." }).style.color = "var(--color-red)";
    }

    // ── Load members + join requests ──────────────────────────────────────────
    const loadingEl = contentEl.createEl("p", { text: "Loading members…" });
    loadingEl.style.color = "var(--text-muted)";

    let participants: string[] = [];
    let joinRequests: Array<Record<string, unknown>> = [];
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
        const delegation = req.delegation as Record<string, unknown> | undefined;
        const addr = String(req.agentAddress ?? delegation?.agentAddress ?? "(unknown)");
        const label = req.agentName ? `${String(req.agentName)} (${addr})` : addr;
        new Setting(contentEl).setName(label).addButton((btn) =>
          btn
            .setButtonText("Approve")
            .setCta()
            .onClick(async () => {
              btn.setButtonText("Approving…").setDisabled(true);
              try {
                await client.approveJoinRequest(this.contextGraphId, addr);
                new Notice(`Approved ${label}`);
                void this.render();
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
      contentEl.createEl("p", { text: "No members yet. Share the invite code above." }).style.color =
        "var(--text-muted)";
      return;
    }
    for (const addr of participants) {
      const isMe = !!myAddress && addr.toLowerCase() === myAddress;
      const setting = new Setting(contentEl).setName(isMe ? `${addr}  —  You` : addr);
      // You can't remove yourself — that would lock you out of your own project.
      if (isMe) continue;
      setting.addButton((btn) =>
        btn
          .setButtonText("Remove")
          .setWarning()
          .onClick(async () => {
            btn.setButtonText("Removing…").setDisabled(true);
            try {
              await client.removeParticipant(this.contextGraphId, addr);
              new Notice(`Removed ${addr}`);
              void this.render();
            } catch (err) {
              new Notice(`Remove failed: ${errorMessage(err)}`, 8000);
              btn.setButtonText("Remove").setDisabled(false);
            }
          })
      );
    }
  }

  private renderInviteCode(container: HTMLElement, code: string): void {
    const codeEl = container.createEl("code");
    codeEl.style.cssText =
      "display: block; padding: 10px; background: var(--background-secondary);" +
      " border-radius: 6px; word-break: break-all; margin: 8px 0; font-size: 0.82em; white-space: pre-wrap;";
    codeEl.setText(code);
    new Setting(container).addButton((btn) =>
      btn
        .setButtonText("Copy invite code")
        .setCta()
        .onClick(async () => {
          await navigator.clipboard.writeText(code);
          btn.setButtonText("Copied!");
          setTimeout(() => btn.setButtonText("Copy invite code"), 2000);
        })
    );
  }
}
