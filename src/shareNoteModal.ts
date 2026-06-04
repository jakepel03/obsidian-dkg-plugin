import { FuzzySuggestModal, Notice, type TFile } from "obsidian";
import type OriginTrailSharedMemoryPlugin from "./main";
import type { SubscribedContextGraph } from "./types";

/**
 * Lets the user pick which shared project the current note should be published
 * into. On selection it writes a `shared_to` frontmatter key and triggers a
 * sync, which routes the note's assertion into that project's context graph.
 */
export class ShareNoteModal extends FuzzySuggestModal<SubscribedContextGraph> {
  constructor(
    private readonly plugin: OriginTrailSharedMemoryPlugin,
    private readonly file: TFile
  ) {
    super(plugin.app);
    this.setPlaceholder("Choose a shared project to publish this note into…");
  }

  getItems(): SubscribedContextGraph[] {
    return this.plugin.settings.subscribedContextGraphs;
  }

  getItemText(cg: SubscribedContextGraph): string {
    return `${cg.name || cg.id} — ${cg.role === "owner" ? "owner" : "member"}`;
  }

  async onChooseItem(cg: SubscribedContextGraph): Promise<void> {
    await this.app.fileManager.processFrontMatter(this.file, (fm) => {
      fm.shared_to = cg.id;
      delete fm.shared;
    });
    new Notice(`Publishing "${this.file.basename}" to ${cg.name || cg.id}…`);
    await this.plugin.syncFile(this.file);
  }
}
