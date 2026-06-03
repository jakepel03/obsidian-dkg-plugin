import { ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type OriginTrailSharedMemoryPlugin from "./main";
import { errorMessage } from "./utils";

type Step = "invite" | "pending" | "subscribing" | "done";

export class JoinProjectModal extends Modal {
  private inviteCode = "";
  private step: Step = "invite";
  private cgId = "";
  private pendingAgentAddress = "";

  constructor(
    private readonly plugin: OriginTrailSharedMemoryPlugin,
    private readonly onDone?: () => void
  ) {
    super(plugin.app);
  }

  onOpen() {
    this.renderInvite();
  }

  onClose() {
    this.contentEl.empty();
  }

  private renderInvite() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Join shared project" });
    contentEl.createEl("p", { text: "Paste the invite code you received from the project curator." });

    new Setting(contentEl)
      .setName("Invite code")
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.inputEl.style.cssText = "width: 100%; font-family: var(--font-monospace); font-size: 0.85em;";
        text
          .setPlaceholder("project-id\ncuratorPeerId")
          .onChange((v) => (this.inviteCode = v.trim()));
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Request to join")
        .setCta()
        .onClick(() => this.requestJoin(btn))
    );
  }

  private async requestJoin(btn: ButtonComponent) {
    if (!this.inviteCode) {
      new Notice("Paste the invite code first.");
      return;
    }

    btn.setButtonText("Connecting…").setDisabled(true);

    const parts = this.inviteCode.split("\n");
    const cgId = parts[0].trim();
    const curatorPeerId = parts[1]?.trim() ?? "";

    try {
      const client = this.plugin.client();
      const identity = await client.getIdentity();
      this.cgId = cgId;
      this.pendingAgentAddress = identity.agentAddress;

      if (curatorPeerId) {
        const signResult = await client.signJoinRequest(cgId);
        const delegation = signResult.delegation ?? signResult;
        const result = await client.requestJoin(cgId, delegation, identity.name ?? identity.agentAddress, curatorPeerId);

        if (result?.alreadyMember || result?.status === "already-member") {
          await this.subscribe();
        } else {
          this.step = "pending";
          this.renderPending();
        }
      } else {
        await this.subscribe();
      }
    } catch (err) {
      const msg = errorMessage(err);
      if (/403|not.*allowlist|not.*allow/i.test(msg)) {
        this.step = "pending";
        this.renderPending();
      } else {
        new Notice(`Join failed: ${msg}`, 10000);
        btn.setButtonText("Request to join").setDisabled(false);
      }
    }
  }

  private renderPending() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Waiting for approval" });
    contentEl.createEl("p", {
      text: "Your join request was sent to the curator. Once they approve, click the button below to subscribe.",
    });

    const hint = contentEl.createEl("p", { text: "Share your agent address with the curator if they ask for it:" });
    hint.style.cssText = "margin-top: 12px; font-size: 0.9em; color: var(--text-muted);";

    const addrEl = contentEl.createEl("code");
    addrEl.style.cssText =
      "display: block; padding: 10px; background: var(--background-secondary);" +
      " border-radius: 6px; word-break: break-all; margin: 4px 0 16px; font-size: 0.85em;";
    addrEl.setText(this.pendingAgentAddress);

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Copy agent address").onClick(async () => {
          await navigator.clipboard.writeText(this.pendingAgentAddress);
          btn.setButtonText("Copied!");
          setTimeout(() => btn.setButtonText("Copy agent address"), 2000);
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("I've been approved — subscribe now")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("Subscribing…").setDisabled(true);
            try {
              await this.subscribe();
            } catch (err) {
              new Notice(`Subscribe failed: ${errorMessage(err)}`, 10000);
              btn.setButtonText("I've been approved — subscribe now").setDisabled(false);
            }
          })
      );
  }

  private async subscribe() {
    this.step = "subscribing";
    this.renderSubscribing();

    const client = this.plugin.client();
    const result = await client.subscribeToContextGraph(this.cgId);

    if (result?.catchup?.status !== "done") {
      await this.pollCatchup(client);
    }

    const already = this.plugin.settings.subscribedContextGraphs.find((c) => c.id === this.cgId);
    if (!already) {
      this.plugin.settings.subscribedContextGraphs.push({ id: this.cgId, name: this.cgId, role: "member" });
      await this.plugin.saveSettings();
    }

    this.step = "done";
    this.renderDone();
    this.onDone?.();
  }

  private async pollCatchup(client: ReturnType<OriginTrailSharedMemoryPlugin["client"]>) {
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const status = await client.subscribeToContextGraph(this.cgId);
      const s = status?.catchup?.status;
      if (s === "done" || s === "failed" || s === "denied" || s === "unreachable") break;
    }
  }

  private renderSubscribing() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Subscribing…" });
    contentEl.createEl("p", {
      text: "Syncing promoted notes from the shared project. This may take a moment.",
    });
  }

  private renderDone() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Joined!" });
    contentEl.createEl("p", {
      text: `You are now subscribed to "${this.cgId}". Promoted notes from the project are available in your local DKG.`,
    });
    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Close")
        .setCta()
        .onClick(() => this.close())
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
