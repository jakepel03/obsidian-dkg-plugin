import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import type OriginTrailSharedMemoryPlugin from "./main";
import { SetupWizardModal } from "./wizard";
import { CreateProjectModal } from "./createProjectModal";
import { JoinProjectModal } from "./joinProjectModal";
import { ManageMembersModal } from "./manageMembersModal";
import { ShareNoteModal } from "./shareNoteModal";
import { DiscoverModal } from "./discoverModal";

export const DKG_DASHBOARD_VIEW = "dkg-dashboard";

type ConnState = "checking" | "online" | "offline";

const STATUS_LABEL: Record<ConnState, string> = {
  checking: "Checking…",
  online: "Connected",
  offline: "Offline",
};

interface BtnOpts {
  icon?: string;
  text: string;
  cta?: boolean;
  ghost?: boolean;
  full?: boolean;
  onClick: () => void;
}

/**
 * One panel for everything you *do* with the plugin: live status, actions on
 * the current note, projects, and discover. Settings keeps only configuration.
 */
export class DkgDashboardView extends ItemView {
  private noteSectionEl: HTMLElement | null = null;
  private statusPill: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;
  private lastStatus: ConnState = "checking";

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OriginTrailSharedMemoryPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return DKG_DASHBOARD_VIEW;
  }
  getDisplayText(): string {
    return "OriginTrail DKG";
  }
  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    this.render();
    // Keep the "This note" section in sync with the active editor.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.noteSectionEl) this.renderThisNote(this.noteSectionEl);
      })
    );
    // Live connection polling so the dot reflects the node coming up/down.
    this.registerInterval(window.setInterval(() => void this.checkConnection(), 7000));
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("dkg-dashboard");
    this.renderHeader(root);
    this.renderStatusCard(root);
    this.noteSectionEl = root.createDiv();
    this.renderThisNote(this.noteSectionEl);
    this.renderProjects(root);
    this.renderFooter(root);
  }

  // ── Header + live status pill ───────────────────────────────────────────────
  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv("dkg-header");
    const title = header.createDiv("dkg-title");
    setIcon(title.createSpan("dkg-glyph"), "git-fork");
    title.createSpan({ text: "OriginTrail DKG" });

    const pill = header.createDiv(`dkg-pill is-${this.lastStatus}`);
    pill.createSpan("dkg-dot");
    this.statusText = pill.createSpan({ text: STATUS_LABEL[this.lastStatus] });
    pill.setAttr("aria-label", "Click to re-check connection");
    pill.onclick = () => void this.checkConnection();
    this.statusPill = pill;

    void this.checkConnection();
  }

  private setStatus(state: ConnState): void {
    this.lastStatus = state;
    const pill = this.statusPill;
    if (!pill || !this.statusText) return;
    pill.classList.remove("is-checking", "is-online", "is-offline");
    pill.classList.add(`is-${state}`);
    this.statusText.setText(STATUS_LABEL[state]);
  }

  private async checkConnection(): Promise<void> {
    try {
      await this.plugin.client().status();
      this.setStatus("online");
    } catch {
      this.setStatus("offline");
    }
  }

  // ── Status card ─────────────────────────────────────────────────────────────
  private renderStatusCard(root: HTMLElement): void {
    const s = this.plugin.settings;
    const card = root.createDiv("dkg-card");
    kv(card, "Node", s.dkgNodeUrl || "(not set)", true);
    kv(card, "Project", s.defaultContextGraphId || "Not linked");

    const chips = card.createDiv("dkg-chips");
    this.chip(chips, s.autoPromote ? "Shared Memory" : "Working Memory", s.autoPromote, async () => {
      this.plugin.settings.autoPromote = !this.plugin.settings.autoPromote;
      await this.plugin.saveSettings();
      this.plugin.updateStatusBar();
    });
    this.chip(chips, s.autoSync ? "Auto-sync on" : "Auto-sync off", s.autoSync, async () => {
      this.plugin.settings.autoSync = !this.plugin.settings.autoSync;
      await this.plugin.saveSettings();
      this.plugin.updateStatusBar();
    });

    if (!s.defaultContextGraphId) {
      const a = card.createDiv("dkg-actions");
      btn(a, {
        icon: "zap",
        text: "Power up vault",
        cta: true,
        full: true,
        onClick: () => new SetupWizardModal(this.plugin, () => this.render()).open(),
      });
    }
  }

  private chip(parent: HTMLElement, label: string, active: boolean, onClick: () => void): void {
    const c = parent.createDiv("dkg-chip" + (active ? " is-active" : ""));
    c.createSpan("dkg-dot-sm");
    c.createSpan({ text: label });
    c.onclick = onClick;
  }

  // ── This note ───────────────────────────────────────────────────────────────
  private renderThisNote(el: HTMLElement): void {
    el.empty();
    el.addClass("dkg-section");
    sectionHead(el, "file-text", "This note");
    const card = el.createDiv("dkg-card");

    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      card.createEl("p", { cls: "dkg-empty", text: "Open a note to sync or share it." });
      return;
    }
    if (!this.plugin.settings.defaultContextGraphId) {
      card.createEl("p", { cls: "dkg-empty", text: "Power up the vault first." });
      return;
    }

    card.createDiv({ cls: "dkg-note-title", text: file.basename });

    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const sharedTo = typeof fm?.shared_to === "string" ? fm.shared_to : "";
    if (sharedTo) kv(card, "Shared to", sharedTo);

    const actions = card.createDiv("dkg-actions");
    btn(actions, { icon: "refresh-cw", text: "Sync now", cta: true, onClick: () => void this.plugin.syncFile(file) });
    if (this.plugin.settings.subscribedContextGraphs.length) {
      btn(actions, { icon: "share-2", text: "Share…", onClick: () => new ShareNoteModal(this.plugin, file).open() });
    }
    if (sharedTo) {
      btn(actions, {
        icon: "minus-circle",
        text: "Stop sharing",
        ghost: true,
        onClick: () => void this.plugin.unshareNote(file).then(() => this.renderThisNote(el)),
      });
    }
  }

  // ── Projects ────────────────────────────────────────────────────────────────
  private renderProjects(root: HTMLElement): void {
    const sec = root.createDiv("dkg-section");
    sectionHead(sec, "users", "Projects");
    const card = sec.createDiv("dkg-card");

    const subs = this.plugin.settings.subscribedContextGraphs;
    if (subs.length === 0) {
      card.createEl("p", { cls: "dkg-empty", text: "No shared projects yet." });
    } else {
      for (const cg of subs) {
        const row = card.createDiv("dkg-proj");
        const name = row.createDiv("name");
        name.createSpan({
          cls: "dkg-badge" + (cg.role === "owner" ? " owner" : ""),
          text: cg.role === "owner" ? "Owner" : "Member",
        });
        name.createSpan({ cls: "label", text: cg.name || cg.id }).setAttr("title", cg.id);
        if (cg.role === "owner") {
          btn(row, {
            icon: "settings-2",
            text: "Manage",
            ghost: true,
            onClick: () => new ManageMembersModal(this.plugin, cg.id, cg.name || cg.id, cg.curated).open(),
          });
        }
      }
    }

    const actions = sec.createDiv("dkg-actions");
    btn(actions, {
      icon: "plus",
      text: "Create",
      cta: true,
      full: true,
      onClick: () => new CreateProjectModal(this.plugin, () => this.render()).open(),
    });
    btn(actions, {
      icon: "log-in",
      text: "Join",
      full: true,
      onClick: () => new JoinProjectModal(this.plugin, () => this.render()).open(),
    });
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  private renderFooter(root: HTMLElement): void {
    const actions = root.createDiv("dkg-actions col");
    btn(actions, {
      icon: "compass",
      text: "Discover shared notes",
      full: true,
      onClick: () => new DiscoverModal(this.plugin).open(),
    });
    btn(actions, {
      icon: "settings",
      text: "Settings",
      ghost: true,
      full: true,
      onClick: () => {
        const app = this.app as unknown as { setting: { open(): void; openTabById(id: string): void } };
        app.setting.open();
        app.setting.openTabById(this.plugin.manifest.id);
      },
    });
  }
}

function kv(card: HTMLElement, k: string, v: string, mono = false): void {
  const r = card.createDiv("dkg-row");
  r.createSpan({ cls: "k", text: k });
  r.createSpan({ cls: "v" + (mono ? " mono" : ""), text: v });
}

function sectionHead(parent: HTMLElement, icon: string, text: string): void {
  const h = parent.createDiv("dkg-section-head");
  setIcon(h.createSpan("dkg-section-icon"), icon);
  h.createSpan({ text });
}

function btn(parent: HTMLElement, opts: BtnOpts): HTMLButtonElement {
  const cls = ["dkg-btn"];
  if (opts.cta) cls.push("cta");
  if (opts.ghost) cls.push("ghost");
  if (opts.full) cls.push("full");
  const b = parent.createEl("button", { cls: cls.join(" ") });
  if (opts.icon) setIcon(b.createSpan("dkg-btn-icon"), opts.icon);
  b.createSpan({ text: opts.text });
  b.onclick = opts.onClick;
  return b;
}
