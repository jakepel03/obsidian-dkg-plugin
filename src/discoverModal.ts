import { Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type OriginTrailDkgPlugin from "./main";
import type { ProjectReadiness, SubscribedContextGraph } from "./types";
import { errorMessage } from "./utils";
import { parseLiteral, sanitizeFileName } from "./sharedNotes";

interface DiscoveredNote {
  entityUri: string;
  assertionName: string;
  name: string;
  curator: string;
  cgId: string;
  cgName: string;
}

/**
 * Whether a project's note bodies can be pulled in full. As a project member you can
 * now fetch full note prose over P2P for any project you belong to — public-open via
 * open serve, and curated/private via the authorized-read path (a capable node verifies
 * you're on the allowlist). Fork still falls back to a title+links stub at fork time if
 * the source bytes can't be reached (curator offline, or a node predating curated reads).
 */
type ContentMode = "full" | "unknown";

const SCHEMA_NAME = "http://schema.org/name";
const SCHEMA_MENTIONS = "http://schema.org/mentions";

/**
 * Browse and fork shared (Shared Memory) notes, grouped by project: a project
 * rail on the left, the selected project's notes on the right. Search is scoped
 * to the selected project so notes from different projects never mix.
 *
 * Forking pulls the author's full Markdown over P2P for any project you're a member of
 * (public-open via open serve, curated/private via the authorized-read path). If the
 * source bytes can't be reached at fork time, it falls back to a reconstructed stub
 * (title + links) with an in-note warning.
 */
export class DiscoverModal extends Modal {
  private projects: SubscribedContextGraph[] = [];
  private byProject = new Map<string, DiscoveredNote[]>();
  private readonly readiness = new Map<string, ProjectReadiness | null>();
  private selectedCgId = "";
  private query = "";
  private myAddress = "";
  private loaded = false;

  private railEl: HTMLElement | null = null;
  private mainEl: HTMLElement | null = null;

  constructor(private readonly plugin: OriginTrailDkgPlugin) {
    super(plugin.app);
  }

  onOpen() {
    this.modalEl.addClass("dkg-browse-modal");
    this.projects = [...this.plugin.settings.subscribedContextGraphs];
    this.renderShell();
    void this.loadAll();
  }

  onClose() {
    this.contentEl.empty();
  }

  // ── Shell: title + two-pane container ─────────────────────────────────────────
  private renderShell() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Browse shared notes" });

    if (this.projects.length === 0) {
      contentEl.createEl("p", {
        cls: "dkg-text-muted",
        text: "You're not in any shared projects yet. Create or join one to browse shared notes.",
      });
      return;
    }

    const browse = contentEl.createDiv({ cls: "dkg-browse" });
    this.railEl = browse.createDiv({ cls: "dkg-browse-rail" });
    this.mainEl = browse.createDiv({ cls: "dkg-browse-main" });

    this.renderRail();
    this.renderMain();
  }

  // ── Left rail: one row per project with a live note count ─────────────────────
  private renderRail() {
    const rail = this.railEl;
    if (!rail) return;
    rail.empty();

    for (const cg of this.projects) {
      const count = this.byProject.get(cg.id)?.length;
      const row = rail.createDiv({ cls: "dkg-browse-proj" });
      if (cg.id === this.selectedCgId) row.addClass("is-active");

      const badge = row.createSpan({
        cls: "dkg-badge" + (cg.role === "owner" ? " owner" : ""),
        text: cg.role === "owner" ? "Owner" : "Member",
      });
      badge.setAttr("title", cg.id);

      row.createSpan({ cls: "label", text: cg.name || cg.id }).setAttr("title", cg.id);
      row.createSpan({
        cls: "dkg-sync-chip",
        text: !this.loaded ? "…" : String(count ?? 0),
      });

      row.onclick = () => this.select(cg.id);
    }
  }

  private select(cgId: string) {
    if (cgId === this.selectedCgId) return;
    this.selectedCgId = cgId;
    this.query = "";
    this.renderRail();
    this.renderMain();
  }

  // ── Right pane: selected project's header, scoped search, and note list ────────
  private renderMain() {
    const main = this.mainEl;
    if (!main) return;
    main.empty();

    if (!this.loaded) {
      main.createEl("p", { cls: "dkg-discover-status", text: "Loading shared notes…" });
      return;
    }
    const cg = this.projects.find((p) => p.id === this.selectedCgId);
    if (!cg) {
      main.createEl("p", { cls: "dkg-text-muted", text: "Select a project on the left." });
      return;
    }

    // Header: project name + content-type badge (full notes vs titles-only).
    const head = main.createDiv({ cls: "dkg-browse-main-head" });
    head.createSpan({ cls: "dkg-browse-main-title", text: cg.name || cg.id });
    const badge = head.createSpan({ cls: "dkg-sync-chip", text: "checking…" });

    const info = main.createEl("p", { cls: "dkg-browse-note-info", text: "" });
    this.applyContentMode(cg.id, badge, info);
    void this.ensureReadiness(cg.id).then(() => {
      if (this.selectedCgId === cg.id) this.applyContentMode(cg.id, badge, info);
    });

    // Scoped search.
    const search = main.createEl("input", { type: "text", cls: "dkg-search-input" });
    search.placeholder = "Search notes in this project…";
    search.value = this.query;
    const listEl = main.createDiv({ cls: "dkg-discover-list" });
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.renderNotes(listEl, cg.id);
    });

    this.renderNotes(listEl, cg.id);
  }

  /** Paint the content-mode badge + helper line for a project. */
  private applyContentMode(cgId: string, badge: HTMLElement, info: HTMLElement) {
    if (this.contentMode(cgId) === "full") {
      badge.setText("Full notes");
      badge.className = "dkg-sync-chip ok";
      info.setText(
        "Forking pulls the author's full note over the network. If the content can't be reached, a title + links stub is reconstructed instead."
      );
    } else {
      badge.setText("checking…");
      badge.className = "dkg-sync-chip";
      info.setText("");
    }
  }

  private contentMode(cgId: string): ContentMode {
    // Members can pull full prose for any project they belong to: public-open via open
    // serve, curated/private via the authorized-read path (the node checks you're on the
    // allowlist). Until we know the project is real, stay "unknown" so the badge shows
    // "checking…". Fork falls back to a stub if the bytes can't be reached at fork time.
    if (this.readiness.get(cgId)?.accessPolicy) return "full";
    const sub = this.projects.find((p) => p.id === cgId);
    if (typeof sub?.curated === "boolean") return "full";
    return "unknown";
  }

  private async ensureReadiness(cgId: string): Promise<void> {
    if (this.readiness.has(cgId)) return;
    const r = await this.plugin
      .client()
      .projectReadiness(cgId)
      .catch(() => null);
    this.readiness.set(cgId, r);
  }

  private renderNotes(container: HTMLElement, cgId: string) {
    container.empty();
    const all = this.byProject.get(cgId) ?? [];
    const notes = this.query
      ? all.filter((n) => n.name.toLowerCase().includes(this.query) || n.curator.toLowerCase().includes(this.query))
      : all;

    if (notes.length === 0) {
      container.createEl("p", {
        cls: "dkg-text-muted",
        text: this.query ? "No matches." : "No shared notes in this project yet.",
      });
      return;
    }

    for (const note of notes) {
      const mine = !!this.myAddress && note.curator.toLowerCase() === this.myAddress.toLowerCase();
      const setting = new Setting(container)
        .setName(note.name)
        .setDesc(`curator ${shortAddr(note.curator)}${mine ? " (you)" : ""}`);

      if (mine) {
        // Your own contribution — the original already lives in your vault.
        setting.addButton((btn) => btn.setButtonText("In your vault").setDisabled(true));
        continue;
      }

      setting.addButton((btn) =>
        btn
          .setButtonText("Fork to vault")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("Forking…").setDisabled(true);
            try {
              const file = await this.fork(note);
              new Notice(`Forked “${note.name}” → ${file.path}`);
              btn.setButtonText("Forked ✓").setDisabled(false);
              // Open in the background — don't let a slow leaf block the UI.
              this.app.workspace.getLeaf(true).openFile(file);
            } catch (err) {
              new Notice(`Fork failed: ${errorMessage(err)}`, 8000);
              btn.setButtonText("Fork to vault").setDisabled(false);
            }
          })
      );
    }
  }

  // ── Data loading ──────────────────────────────────────────────────────────────
  private async loadAll() {
    if (this.projects.length === 0) return;
    try {
      if (!this.myAddress) {
        this.myAddress =
          (
            await this.plugin
              .client()
              .getIdentity()
              .catch(() => null)
          )?.agentAddress ?? "";
      }
      const perCg = await Promise.all(
        this.projects.map((cg) => this.fetchPromotedNotes(cg.id, cg.name || cg.id).catch(() => [] as DiscoveredNote[]))
      );
      this.projects.forEach((cg, i) => {
        this.byProject.set(
          cg.id,
          perCg[i].sort((a, b) => a.name.localeCompare(b.name))
        );
      });
      this.loaded = true;
      // Default to the first project that actually has notes, else the first one.
      this.selectedCgId =
        this.projects.find((p) => (this.byProject.get(p.id)?.length ?? 0) > 0)?.id ?? this.projects[0]?.id ?? "";
    } catch (err) {
      if (this.mainEl) {
        this.mainEl.empty();
        this.mainEl.createEl("p", { cls: "dkg-status-error", text: `Failed to load: ${errorMessage(err)}` });
      }
      return;
    }
    this.renderRail();
    this.renderMain();
  }

  private async fetchPromotedNotes(cgId: string, cgName: string): Promise<DiscoveredNote[]> {
    const prefix = `did:dkg:context-graph:${cgId}/assertion/`;
    // Match only the note ROOT entity (URI ends with `/obsidian-note-<id>`). Without the
    // end-anchor, the structural extractor's skolemized sub-entities
    // (`…/obsidian-note-<id>/.well-known/genid/<uuid>`, e.g. each list item or heading,
    // which also carry a schema:name) would show up as separate "notes".
    const rows = await this.plugin.client().querySparql(
      `SELECT DISTINCT ?s ?name WHERE {
         GRAPH ?g { ?s <${SCHEMA_NAME}> ?name }
         FILTER(STRSTARTS(STR(?s), "${prefix}"))
         FILTER(REGEX(STR(?s), "/obsidian-note-[^/]+$"))
       } ORDER BY ?name`
    );
    return rows.map((r) => {
      const entityUri = r.s;
      const rest = entityUri.slice(prefix.length); // <agentAddress>/<assertionName>
      const slash = rest.indexOf("/");
      return {
        entityUri,
        cgId,
        cgName,
        curator: slash >= 0 ? rest.slice(0, slash) : "",
        assertionName: slash >= 0 ? rest.slice(slash + 1) : rest,
        name: parseLiteral(r.name) || rest,
      };
    });
  }

  // ── Fork ──────────────────────────────────────────────────────────────────────
  private async fork(note: DiscoveredNote): Promise<TFile> {
    const client = this.plugin.client();
    // Pull the curator's real prose over P2P. Works for any project you're a member of
    // (public-open via open serve, curated/private via the authorized-read path); falls
    // back to a graph-reconstructed stub if the node can't fetch it (curator unreachable,
    // or a node predating curated byte-reads). Pin the fetch at the curator's peer (when we
    // captured it at join time) so the node goes straight there instead of probing every
    // connected peer in turn — the difference between ~25ms and a multi-minute hang.
    const sub = this.plugin.settings.subscribedContextGraphs.find((p) => p.id === note.cgId);
    const real = await client.readArtifactMarkdown(note.cgId, note.entityUri, sub?.curatorPeerId);
    const content = real ?? (await this.reconstruct(note));

    const folder = `DKG Discover/${sanitizeFileName(note.cgName)}`;
    await this.ensureFolder(folder);
    const path = `${folder}/${sanitizeFileName(note.name)}.md`;

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return existing;
    }
    return await this.app.vault.create(path, content);
  }

  /** Build a Markdown stub from the graph when source bytes aren't on this node. */
  private async reconstruct(note: DiscoveredNote): Promise<string> {
    const nameByUri = new Map(this.allNotes().map((n) => [n.entityUri, n.name]));
    const rows = await this.plugin
      .client()
      .querySparql(`SELECT ?p ?o WHERE { GRAPH ?g { <${note.entityUri}> ?p ?o } }`);

    const links: string[] = [];
    for (const r of rows) {
      if (r.p === SCHEMA_MENTIONS && r.o.includes("/obsidian-note-")) {
        links.push(nameByUri.get(r.o) ?? r.o.split("/").pop() ?? r.o);
      }
    }

    const fm = [
      "---",
      `dkg_source_project: ${note.cgId}`,
      `dkg_curator: ${note.curator}`,
      `dkg_assertion: ${note.assertionName}`,
      `dkg_forked_at: ${new Date().toISOString()}`,
      "---",
      "",
    ].join("\n");

    const body = [
      `# ${note.name}`,
      "",
      "> ⚠️ Forked from a DKG project — the full note content was not replicated to this node, so this is reconstructed from the shared graph (title + links).",
      "",
      links.length ? `**Mentions:** ${links.map((l) => `[[${l}]]`).join(", ")}` : "_No links recorded._",
      "",
    ].join("\n");

    return fm + body;
  }

  private allNotes(): DiscoveredNote[] {
    return Array.from(this.byProject.values()).flat();
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(this.app.vault.getAbstractFileByPath(cur) instanceof TFolder)) {
        await this.app.vault.createFolder(cur).catch(() => {});
      }
    }
  }
}

function shortAddr(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "unknown";
}
