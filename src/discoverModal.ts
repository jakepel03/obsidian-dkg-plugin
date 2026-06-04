import { Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type OriginTrailSharedMemoryPlugin from "./main";
import { errorMessage } from "./utils";

interface DiscoveredNote {
  entityUri: string;
  assertionName: string;
  name: string;
  curator: string;
}

interface CgOption {
  id: string;
  name: string;
}

const SCHEMA_NAME = "http://schema.org/name";
const SCHEMA_MENTIONS = "http://schema.org/mentions";

/**
 * Browse the promoted (Shared Memory) notes of any context graph this vault can
 * see — a shared project or a peer's primary graph — and fork one into the
 * vault. Works regardless of how the graph was shared (Create project or
 * Manage access), since both produce an ordinary subscribable Context Graph.
 *
 * Fork writes the real Markdown when the source bytes are present on this node
 * (your own / owned notes); for a peer's note whose bytes were not replicated
 * it reconstructs a stub from the graph triples (title + links + provenance).
 */
export class DiscoverModal extends Modal {
  private selectedCg = "";
  private notes: DiscoveredNote[] = [];
  private myAddress = "";

  constructor(private readonly plugin: OriginTrailSharedMemoryPlugin) {
    super(plugin.app);
  }

  onOpen() {
    this.selectedCg = this.cgOptions()[0]?.id ?? "";
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  /** Subscribed projects / graphs — Discover is for pulling other people's notes. */
  private cgOptions(): CgOption[] {
    return this.plugin.settings.subscribedContextGraphs.map((cg) => ({
      id: cg.id,
      name: cg.name || cg.id,
    }));
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Discover shared notes" });

    const options = this.cgOptions();
    if (options.length === 0) {
      contentEl
        .createEl("p", {
          text: "No graphs to browse yet. Connect your vault, or join a shared project first.",
        })
        .style.setProperty("color", "var(--text-muted)");
      return;
    }

    new Setting(contentEl)
      .setName("Project / graph")
      .setDesc("Pick a graph to browse its promoted notes.")
      .addDropdown((dd) => {
        for (const o of options) dd.addOption(o.id, o.name);
        dd.setValue(this.selectedCg || options[0].id);
        this.selectedCg = dd.getValue();
        dd.onChange((v) => {
          this.selectedCg = v;
        });
      })
      .addButton((btn) =>
        btn
          .setButtonText("Load")
          .setCta()
          .onClick(() => this.load(btn))
      );

    const listEl = contentEl.createDiv({ cls: "dkg-discover-list" });
    listEl.style.cssText = "margin-top: 12px;";
    this.renderList(listEl);
  }

  private async load(btn: { setButtonText(t: string): unknown; setDisabled(d: boolean): unknown }) {
    if (!this.selectedCg) return;
    btn.setButtonText("Loading…");
    btn.setDisabled(true);
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
      this.notes = await this.fetchPromotedNotes(this.selectedCg);
    } catch (err) {
      new Notice(`Discover failed: ${errorMessage(err)}`, 8000);
    } finally {
      btn.setButtonText("Load");
      btn.setDisabled(false);
    }
    this.render();
  }

  private renderList(container: HTMLElement) {
    container.empty();
    if (this.notes.length === 0) {
      container
        .createEl("p", { text: "No promoted notes here yet — pick a graph and press Load." })
        .style.setProperty("color", "var(--text-muted)");
      return;
    }
    for (const note of this.notes) {
      const mine = !!this.myAddress && note.curator.toLowerCase() === this.myAddress.toLowerCase();
      const setting = new Setting(container)
        .setName(note.name)
        .setDesc(`curator ${shortAddr(note.curator)}${mine ? " (you)" : ""} · ${note.assertionName}`);

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

  private async fetchPromotedNotes(cg: string): Promise<DiscoveredNote[]> {
    const prefix = `did:dkg:context-graph:${cg}/assertion/`;
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
        curator: slash >= 0 ? rest.slice(0, slash) : "",
        assertionName: slash >= 0 ? rest.slice(slash + 1) : rest,
        name: parseLiteral(r.name) || rest,
      };
    });
  }

  private async fork(note: DiscoveredNote): Promise<TFile> {
    const client = this.plugin.client();
    const real = await client.readImportedMarkdown(this.selectedCg, note.entityUri, note.assertionName);
    const content = real ?? (await this.reconstruct(note));

    const folder = `DKG Discover/${sanitize(this.selectedCg)}`;
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
      `dkg_source_project: ${this.selectedCg}`,
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
