import { Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type OriginTrailSharedMemoryPlugin from "./main";
import { errorMessage } from "./utils";

interface DiscoveredNote {
  entityUri: string;
  assertionName: string;
  name: string;
  curator: string;
  cgId: string;
  cgName: string;
}

const SCHEMA_NAME = "http://schema.org/name";
const SCHEMA_MENTIONS = "http://schema.org/mentions";

/**
 * Browse and search the promoted (Shared Memory) notes across every project this
 * vault subscribes to — one searchable feed instead of a per-graph picker.
 *
 * Forking writes the real Markdown when the source bytes are present on this node
 * (your own / owned notes); for a peer's note whose bytes were not replicated it
 * reconstructs a stub from the graph triples (title + links), which the modal is
 * upfront about.
 */
export class DiscoverModal extends Modal {
  private notes: DiscoveredNote[] = [];
  private myAddress = "";
  private query = "";
  private loaded = false;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(private readonly plugin: OriginTrailSharedMemoryPlugin) {
    super(plugin.app);
  }

  onOpen() {
    this.renderShell();
    void this.loadAll();
  }

  onClose() {
    this.contentEl.empty();
  }

  private renderShell() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Browse shared notes" });

    if (this.plugin.settings.subscribedContextGraphs.length === 0) {
      contentEl
        .createEl("p", {
          text: "You're not in any shared projects yet. Create or join one to browse shared notes.",
        })
        .style.setProperty("color", "var(--text-muted)");
      return;
    }

    const hint = contentEl.createEl("p", {
      text: "Notes others share sync as a knowledge graph (title + links). Forking a peer's note reconstructs a stub — full prose isn't replicated across nodes yet.",
    });
    hint.style.cssText = "color: var(--text-muted); font-size: 0.85em; margin: 0 0 10px;";

    const search = contentEl.createEl("input", { type: "text" });
    search.placeholder = "Search by title, project, or curator…";
    search.style.cssText = "width: 100%; margin-bottom: 10px;";
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.renderList();
    });

    this.statusEl = contentEl.createEl("p", { text: "Loading shared notes…" });
    this.statusEl.style.cssText = "color: var(--text-muted); font-size: 0.85em;";

    this.listEl = contentEl.createDiv({ cls: "dkg-discover-list" });
  }

  private async loadAll() {
    const subs = this.plugin.settings.subscribedContextGraphs;
    if (subs.length === 0) return;
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
        subs.map((cg) => this.fetchPromotedNotes(cg.id, cg.name || cg.id).catch(() => [] as DiscoveredNote[]))
      );
      this.notes = perCg.flat().sort((a, b) => a.name.localeCompare(b.name));
      this.loaded = true;
    } catch (err) {
      if (this.statusEl) {
        this.statusEl.setText(`Failed to load: ${errorMessage(err)}`);
        this.statusEl.style.color = "var(--color-red)";
      }
      return;
    }
    this.renderList();
  }

  private filtered(): DiscoveredNote[] {
    if (!this.query) return this.notes;
    return this.notes.filter(
      (n) =>
        n.name.toLowerCase().includes(this.query) ||
        n.cgName.toLowerCase().includes(this.query) ||
        n.curator.toLowerCase().includes(this.query)
    );
  }

  private renderList() {
    const container = this.listEl;
    if (!container) return;
    container.empty();

    if (this.statusEl) {
      if (!this.loaded) {
        this.statusEl.setText("Loading shared notes…");
      } else {
        const total = this.notes.length;
        this.statusEl.setText(
          total === 0 ? "No shared notes in your projects yet." : `${total} shared note${total === 1 ? "" : "s"}`
        );
      }
    }

    const notes = this.filtered();
    if (this.loaded && notes.length === 0 && this.query) {
      container.createEl("p", { text: "No matches." }).style.setProperty("color", "var(--text-muted)");
      return;
    }

    for (const note of notes) {
      const mine = !!this.myAddress && note.curator.toLowerCase() === this.myAddress.toLowerCase();
      const setting = new Setting(container)
        .setName(note.name)
        .setDesc(`${note.cgName} · curator ${shortAddr(note.curator)}${mine ? " (you)" : ""}`);

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

  private async fetchPromotedNotes(cgId: string, cgName: string): Promise<DiscoveredNote[]> {
    const prefix = `did:dkg:context-graph:${cgId}/assertion/`;
    const rows = await this.plugin.client().querySparql(
      `SELECT DISTINCT ?s ?name WHERE {
         GRAPH ?g { ?s <${SCHEMA_NAME}> ?name }
         FILTER(STRSTARTS(STR(?s), "${prefix}"))
         FILTER(CONTAINS(STR(?s), "/obsidian-note-"))
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

  private async fork(note: DiscoveredNote): Promise<TFile> {
    const client = this.plugin.client();
    const real = await client.readImportedMarkdown(note.cgId, note.entityUri, note.assertionName);
    const content = real ?? (await this.reconstruct(note));

    const folder = `DKG Discover/${sanitize(note.cgName)}`;
    await this.ensureFolder(folder);
    const path = `${folder}/${sanitize(note.name)}.md`;

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return existing;
    }
    return await this.app.vault.create(path, content);
  }

  /** Build a Markdown stub from the graph when source bytes aren't on this node. */
  private async reconstruct(note: DiscoveredNote): Promise<string> {
    const nameByUri = new Map(this.notes.map((n) => [n.entityUri, n.name]));
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

function parseLiteral(v: string): string {
  if (!v) return "";
  // SPARQL JSON literals come back like "\"Welcome\"" or "\"x\"^^<type>".
  const m = v.match(/^"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"') : v;
}

function shortAddr(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "unknown";
}

function sanitize(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "untitled"
  );
}
