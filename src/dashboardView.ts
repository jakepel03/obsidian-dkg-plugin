import { ItemView, Notice, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
import type OriginTrailDkgPlugin from "./main";
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
  tooltip?: string;
  onClick: (btnEl: HTMLButtonElement) => void;
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
    private readonly plugin: OriginTrailDkgPlugin
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
    setTooltip(pill, "Connection to your DKG node — click to re-check.");
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
    kv(card, "Node", s.dkgNodeUrl || "(not set)", {
      mono: true,
      tooltip: "The local DKG node this vault talks to.",
    });
    kv(card, "Vault graph", s.defaultContextGraphId || "Not linked", {
      tooltip: "Your private knowledge graph on this node. Every note lives here unless you share it to a project.",
    });

    if (!s.defaultContextGraphId) {
      const a = card.createDiv("dkg-actions");
      btn(a, {
        icon: "zap",
        text: "Connect vault",
        cta: true,
        full: true,
        tooltip: "Link this vault to your DKG node and import your notes.",
        onClick: () => new SetupWizardModal(this.plugin, () => this.render()).open(),
      });
      return;
    }

    card.createEl("p", {
      cls: "dkg-hint",
      text: "Your notes are private to this node. Share one to a project to make it visible to others.",
    });

    const a = card.createDiv("dkg-actions");
    btn(a, {
      icon: "refresh-cw",
      text: "Sync whole vault",
      ghost: true,
      full: true,
      tooltip: "Re-import every note in this vault into your DKG node.",
      onClick: async (b) => {
        await runWithFeedback(b, "Syncing…", async () => {
          const n = await this.plugin.sync.syncWholeVault();
          new Notice(`DKG: synced ${n} notes.`);
        });
        this.render();
      },
    });
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
      card.createEl("p", { cls: "dkg-empty", text: "Connect your vault first to sync notes." });
      return;
    }

    card.createDiv({ cls: "dkg-note-title", text: file.basename });

    const dest = this.plugin.sync.noteDestination(file);
    kv(
      card,
      "Status",
      dest.shared ? `Shared to ${dest.projectName}${dest.viaFolderRule ? " (folder rule)" : ""}` : "Private",
      {
        tooltip: dest.shared
          ? "Promoted into this project's shared memory, visible to its members."
          : "Only on your node. Use Share to publish it to a project.",
      }
    );

    const last = this.plugin.sync.lastSync.get(file.path);
    if (last) {
      const triples = last.tripleCount != null ? `${last.tripleCount} triples · ` : "";
      kv(card, "Last sync", `${triples}${relativeTime(last.at)}`, {
        tooltip: "When this note was last pushed to your DKG node, and how many graph triples it produced.",
      });
    }

    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const explicitShare = typeof fm?.shared_to === "string" && fm.shared_to.trim().length > 0;

    const actions = card.createDiv("dkg-actions");
    btn(actions, {
      icon: "refresh-cw",
      text: "Sync now",
      cta: true,
      tooltip: "Push this note to your DKG node now.",
      onClick: async (b) => {
        await runWithFeedback(b, "Syncing…", async () => {
          await this.plugin.sync.syncFile(file);
        });
        this.renderThisNote(el);
      },
    });
    if (this.plugin.settings.subscribedContextGraphs.length) {
      btn(actions, {
        icon: "share-2",
        text: dest.shared ? "Change…" : "Share…",
        tooltip: "Publish this note into a project's shared memory.",
        onClick: () => new ShareNoteModal(this.plugin, file).open(),
      });
    }
    if (explicitShare) {
      btn(actions, {
        icon: "minus-circle",
        text: "Make private",
        ghost: true,
        tooltip: "Stop sharing this note. The already-shared copy ages out of the project over ~30 days.",
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
        const badge = name.createSpan({
          cls: "dkg-badge" + (cg.role === "owner" ? " owner" : ""),
          text: cg.role === "owner" ? "Owner" : "Member",
        });
        setTooltip(
          badge,
          cg.role === "owner" ? "You own this project — you can manage members." : "You're a member of this project."
        );
        name.createSpan({ cls: "label", text: cg.name || cg.id }).setAttr("title", cg.id);
        if (cg.role === "owner") {
          btn(row, {
            icon: "settings-2",
            text: "Manage",
            ghost: true,
            tooltip: "Manage members and copy the invite code.",
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
      tooltip: "Create a shared project others can join.",
      onClick: () => new CreateProjectModal(this.plugin, () => this.render()).open(),
    });
    btn(actions, {
      icon: "log-in",
      text: "Join",
      full: true,
      tooltip: "Join a project using an invite code.",
      onClick: () => new JoinProjectModal(this.plugin, () => this.render()).open(),
    });
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  private renderFooter(root: HTMLElement): void {
    const actions = root.createDiv("dkg-actions col");
    btn(actions, {
      icon: "compass",
      text: "Browse shared notes",
      full: true,
      tooltip: "Browse and search notes shared across your projects.",
      onClick: () => new DiscoverModal(this.plugin).open(),
    });
    btn(actions, {
      icon: "settings",
      text: "Settings",
      ghost: true,
      full: true,
      tooltip: "Open plugin settings.",
      onClick: () => {
        const app = this.app as unknown as { setting: { open(): void; openTabById(id: string): void } };
        app.setting.open();
        app.setting.openTabById(this.plugin.manifest.id);
      },
    });
  }
}

function kv(card: HTMLElement, k: string, v: string, opts: { mono?: boolean; tooltip?: string } = {}): void {
  const r = card.createDiv("dkg-row");
  r.createSpan({ cls: "k", text: k });
  r.createSpan({ cls: "v" + (opts.mono ? " mono" : ""), text: v });
  if (opts.tooltip) setTooltip(r, opts.tooltip);
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
  b.createSpan({ cls: "dkg-btn-label", text: opts.text });
  if (opts.tooltip) setTooltip(b, opts.tooltip);
  b.onclick = () => opts.onClick(b);
  return b;
}

/**
 * Run an async action with inline feedback on the button itself: the icon spins
 * and the label switches to `busyText` while the work runs, then reverts.
 */
async function runWithFeedback(b: HTMLButtonElement, busyText: string, run: () => Promise<void>): Promise<void> {
  const label = b.querySelector<HTMLElement>(".dkg-btn-label");
  const original = label?.textContent ?? "";
  b.classList.add("is-busy");
  b.setAttribute("disabled", "true");
  label?.setText(busyText);
  try {
    await run();
  } finally {
    b.classList.remove("is-busy");
    b.removeAttribute("disabled");
    label?.setText(original);
  }
}

function relativeTime(then: number): string {
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
