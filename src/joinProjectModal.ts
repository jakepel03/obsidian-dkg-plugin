import { ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type OriginTrailDkgPlugin from "./main";
import type { DkgClient } from "./dkgClient";
import { errorMessage, parseInviteCode, sleep } from "./utils";

export class JoinProjectModal extends Modal {
  private inviteCode = "";
  private cgId = "";
  private curatorPeerId = "";
  private pendingAgentAddress = "";

  constructor(
    private readonly plugin: OriginTrailDkgPlugin,
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

    new Setting(contentEl).setName("Invite code").addTextArea((text) => {
      text.inputEl.rows = 3;
      text.inputEl.addClass("dkg-invite-input");
      text.setPlaceholder("project-id\ncuratorPeerId").onChange((v) => (this.inviteCode = v.trim()));
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

    const { cgId, curatorPeerId } = parseInviteCode(this.inviteCode);

    try {
      const client = this.plugin.client();
      const identity = await client.getIdentity();
      this.cgId = cgId;
      this.curatorPeerId = curatorPeerId;
      this.pendingAgentAddress = identity.agentAddress;

      if (curatorPeerId) {
        const signResult = await client.signJoinRequest(cgId);
        const delegation = signResult.delegation ?? signResult;
        const result = await client.requestJoin(
          cgId,
          delegation,
          identity.name ?? identity.agentAddress,
          curatorPeerId
        );

        if (result?.alreadyMember || result?.status === "already-member") {
          await this.subscribe();
        } else {
          this.renderPending();
        }
      } else {
        await this.subscribe();
      }
    } catch (err) {
      const msg = errorMessage(err);
      if (/403|not.*allowlist|not.*allow/i.test(msg)) {
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

    contentEl.createEl("p", {
      cls: "dkg-pending-hint",
      text: "Share your agent address with the curator if they ask for it:",
    });

    const addrEl = contentEl.createEl("code", { cls: "dkg-address-block" });
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
    this.renderSubscribing();

    const client = this.plugin.client();
    await client.subscribeToContextGraph(this.cgId);

    // Record the subscription up front: the catch-up runs server-side and
    // persists even if this modal is closed, so the project belongs in the
    // list regardless of whether we observe it finish here.
    const already = this.plugin.settings.subscribedContextGraphs.find((c) => c.id === this.cgId);
    if (!already) {
      this.plugin.settings.subscribedContextGraphs.push({
        id: this.cgId,
        name: this.cgId,
        role: "member",
        curatorPeerId: this.curatorPeerId || undefined,
      });
      await this.plugin.saveSettings();
    } else if (this.curatorPeerId && !already.curatorPeerId) {
      // Backfill the curator peer id for a project subscribed before we tracked it.
      already.curatorPeerId = this.curatorPeerId;
      await this.plugin.saveSettings();
    }
    this.onDone?.();

    // Wait for the project to become genuinely usable (gated/synced), not for
    // an arbitrary timer. If it doesn't settle within the window we say so
    // honestly rather than claiming success.
    const ready = await this.waitUntilReady(client);
    if (ready) {
      this.renderDone();
    } else {
      this.renderStillSyncing();
    }
  }

  /**
   * Poll the real readiness signal (allowlist for curated, `synced` for
   * public) until the project is usable. Returns false on timeout — the
   * catch-up keeps running server-side, so this is "not yet", not "failed".
   */
  private async waitUntilReady(client: DkgClient): Promise<boolean> {
    for (let i = 0; i < 45; i++) {
      const r = await client.projectReadiness(this.cgId).catch(() => null);
      if (r?.ready) return true;
      await sleep(2000);
    }
    return false;
  }

  private renderSubscribing() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Subscribing…" });
    contentEl.createEl("p", {
      text: "Syncing the project to this node. This can take up to a minute — please keep this open.",
    });
  }

  private renderDone() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Joined!" });
    contentEl.createEl("p", {
      text: `You're fully synced to "${this.cgId}". Promoted notes from the project are available on this node, and the curator can now share notes to you.`,
    });
    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Close")
        .setCta()
        .onClick(() => this.close())
    );
  }

  /**
   * Honest "not finished yet" state. The subscription is saved and the
   * catch-up continues in the background, so closing is safe; we offer a
   * one-shot re-check rather than spinning a blocking retry loop.
   */
  private renderStillSyncing() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Still syncing…" });
    contentEl.createEl("p", {
      text: `"${this.cgId}" is subscribed but hasn't finished syncing yet. This keeps running in the background — you can safely close this and check the project's status on the dashboard. Sharing to you won't work until it's fully synced.`,
    });
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Check again").onClick(async () => {
          b.setButtonText("Checking…").setDisabled(true);
          const ready = await this.plugin
            .client()
            .projectReadiness(this.cgId)
            .catch(() => null);
          if (ready?.ready) {
            this.renderDone();
          } else {
            b.setButtonText("Check again").setDisabled(false);
            new Notice("Not synced yet — give it a little longer.");
          }
        })
      )
      .addButton((b) =>
        b
          .setButtonText("Close")
          .setCta()
          .onClick(() => this.close())
      );
  }
}
