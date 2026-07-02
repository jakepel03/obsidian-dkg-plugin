import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type OriginTrailDkgPlugin from "./main";
import { SetupWizardModal } from "./wizard";
import { CreateProjectModal } from "./createProjectModal";
import { JoinProjectModal } from "./joinProjectModal";
import { ManageMembersModal } from "./manageMembersModal";
import { runConnectionTest } from "./utils";

export class OriginTrailSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: OriginTrailDkgPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Headings use Setting.setHeading() and there is no top-level plugin-name
    // heading, per the Obsidian plugin guidelines (the tab is already titled).
    const isLinked = Boolean(this.plugin.settings.defaultContextGraphId);

    // ── Status / Getting started ─────────────────────────────────────────────
    if (!isLinked) {
      new Setting(containerEl).setName("Getting started").setHeading();

      new Setting(containerEl)
        .setName("This vault is not yet connected to a DKG node")
        .setDesc("Run the setup wizard to point the plugin at a DKG node and import your existing notes.")
        .addButton((btn) =>
          btn
            .setButtonText("Run setup wizard")
            .setCta()
            .onClick(() => new SetupWizardModal(this.plugin, () => this.display()).open())
        );
    } else {
      new Setting(containerEl).setName("Status").setHeading();

      const card = containerEl.createDiv({ cls: "dkg-status-card" });

      const info = card.createDiv({ cls: "dkg-status-card-info" });

      const makeRow = (label: string, value: string) => {
        const row = info.createDiv({ cls: "dkg-status-card-row" });
        row.createEl("span", { cls: "dkg-status-card-label", text: label });
        row.createEl("span", { text: value });
      };

      makeRow("DKG Project", this.plugin.settings.defaultContextGraphId);
      makeRow("Node", this.plugin.settings.dkgNodeUrl || "(not set)");

      const btnGroup = card.createDiv({ cls: "dkg-status-card-btns" });

      const manageBtn = new ButtonComponent(btnGroup);
      manageBtn.setButtonText("Manage access");
      manageBtn.buttonEl.addClass("dkg-card-btn-sm");
      manageBtn.onClick(() => {
        const cgId = this.plugin.settings.defaultContextGraphId;
        const name = this.plugin.app.vault.getName();
        // The vault graph is created private (allowlist-gated), so its invite
        // code must carry the curator peer id for the join-request flow.
        new ManageMembersModal(this.plugin, cgId, name, true).open();
      });

      const reconfigBtn = new ButtonComponent(btnGroup);
      reconfigBtn.setButtonText("Reconfigure →");
      reconfigBtn.buttonEl.addClass("dkg-card-btn-ghost");
      reconfigBtn.onClick(() => new SetupWizardModal(this.plugin, () => this.display()).open());
    }

    // ── Projects ─────────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Projects").setHeading();

    const subscribed = this.plugin.settings.subscribedContextGraphs;

    if (subscribed.length === 0) {
      containerEl.createEl("p", { cls: "dkg-para-muted", text: "No shared projects yet." });
    } else {
      for (const cg of subscribed) {
        const s = new Setting(containerEl)
          .setName(cg.name || cg.id)
          .setDesc(`${cg.role === "owner" ? "Owner" : "Member"} · ${cg.id}`);

        if (cg.role === "owner") {
          s.addButton((btn) =>
            btn
              .setButtonText("Manage members")
              .onClick(() => new ManageMembersModal(this.plugin, cg.id, cg.name || cg.id, cg.curated).open())
          );
        }

        s.addButton((btn) =>
          btn
            .setButtonText("Remove")
            .setWarning()
            .onClick(async () => {
              // Best-effort: stop the node from replicating the graph too. A
              // failure (node offline) must not block the local removal.
              try {
                await this.plugin.client().unsubscribeFromContextGraph(cg.id);
              } catch (err) {
                console.warn(`[DKG] could not unsubscribe from ${cg.id}:`, err);
              }
              this.plugin.settings.subscribedContextGraphs = this.plugin.settings.subscribedContextGraphs.filter(
                (c) => c.id !== cg.id
              );
              // Folder rules into the removed project are meaningless now —
              // drop them so they don't silently resume if the id is reused.
              this.plugin.settings.folderDestinations = this.plugin.settings.folderDestinations.filter(
                (r) => r.contextGraphId !== cg.id
              );
              await this.plugin.saveSettings();
              this.display();
            })
        );
      }
    }

    new Setting(containerEl)
      .addButton((btn) =>
        btn
          .setButtonText("Create shared project")
          .setCta()
          .onClick(() => new CreateProjectModal(this.plugin, () => this.display()).open())
      )
      .addButton((btn) =>
        btn
          .setButtonText("Join shared project")
          .onClick(() => new JoinProjectModal(this.plugin, () => this.display()).open())
      );

    // ── Sharing ────────────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Sharing").setHeading();

    containerEl.createEl("p", {
      cls: "dkg-para-muted",
      text: "Notes are private by default. Share a single note to a project from the dashboard, or add a folder rule below to share everything inside a folder automatically.",
    });

    if (subscribed.length === 0) {
      containerEl.createEl("p", {
        cls: "dkg-para-muted",
        text: "Create or join a project first to set up folder sharing.",
      });
    } else {
      const rules = this.plugin.settings.folderDestinations;
      for (const rule of rules) {
        const projName = subscribed.find((c) => c.id === rule.contextGraphId)?.name || rule.contextGraphId;
        new Setting(containerEl)
          .setName(rule.folder)
          .setDesc(`Shared to ${projName}`)
          .addButton((btn) =>
            btn
              .setButtonText("Remove")
              .setWarning()
              .onClick(async () => {
                this.plugin.settings.folderDestinations = rules.filter((r) => r !== rule);
                await this.plugin.saveSettings();
                this.display();
              })
          );
      }

      let newFolder = "";
      let newProject = subscribed[0].id;
      const addRule = new Setting(containerEl).setName("Add folder rule").setDesc("Folder → project");
      addRule.addText((t) => t.setPlaceholder("Team/").onChange((v) => (newFolder = v.trim())));
      addRule.addDropdown((dd) => {
        for (const c of subscribed) dd.addOption(c.id, c.name || c.id);
        dd.setValue(newProject);
        dd.onChange((v) => (newProject = v));
      });
      addRule.addButton((btn) =>
        btn
          .setButtonText("Add")
          .setCta()
          .onClick(async () => {
            if (!newFolder) {
              new Notice("Enter a folder path, e.g. Team/");
              return;
            }
            this.plugin.settings.folderDestinations.push({ folder: newFolder, contextGraphId: newProject });
            await this.plugin.saveSettings();
            this.display();
          })
      );
    }

    // ── Shared notes from projects ───────────────────────────────────────────
    new Setting(containerEl).setName("Shared notes from projects").setHeading();

    new Setting(containerEl)
      .setName("Keep shared notes in your vault")
      .setDesc(
        "Other members' shared notes appear as files under the folder below, one subfolder per project, " +
          "and stay up to date automatically. Turn off to browse them only via Discover."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.materializeSharedNotes).onChange(async (value) => {
          this.plugin.settings.materializeSharedNotes = value;
          await this.plugin.saveSettings();
          if (value) void this.plugin.sharedNotes.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName("Shared notes folder")
      .setDesc("Vault folder that holds the per-project subfolders. Notes already placed keep their location.")
      .addText((text) =>
        text
          .setPlaceholder("Shared Projects")
          .setValue(this.plugin.settings.sharedFolderRoot)
          .onChange(async (value) => {
            const trimmed = value.trim().replace(/\/+$/, "");
            if (!trimmed) return;
            this.plugin.settings.sharedFolderRoot = trimmed;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Notify about new shared notes")
      .setDesc('Show a short notice when notes arrive or change (e.g. "2 new, 1 updated").')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sharedNotesNotices).onChange(async (value) => {
          this.plugin.settings.sharedNotesNotices = value;
          await this.plugin.saveSettings();
        })
      );

    // ── Connection ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("DKG node URL")
      .setDesc("Local DKG node API base URL.")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:9200")
          .setValue(this.plugin.settings.dkgNodeUrl)
          .onChange(async (value) => {
            this.plugin.settings.dkgNodeUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("Bearer token for the local DKG node. Stored only in this vault's plugin data.json.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Paste DKG auth token")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    const CONN_IDLE_DESC = "Checks /api/status and /api/agent/identity with the current settings.";
    const testConnSetting = new Setting(containerEl).setName("Test connection").setDesc(CONN_IDLE_DESC);
    testConnSetting.addButton((btn) => {
      btn.setButtonText("Test").onClick(async () => {
        const skipIdentity = !this.plugin.settings.authToken.trim();
        await runConnectionTest(this.plugin.client(), testConnSetting, btn, skipIdentity);
      });
    });

    // ── Advanced ─────────────────────────────────────────────────────────────
    const details = containerEl.createEl("details", { cls: "dkg-advanced-details" });
    const summary = details.createEl("summary", { cls: "dkg-advanced-summary" });
    summary.setText("▸ Advanced");
    details.addEventListener("toggle", () => {
      summary.setText(details.open ? "▾ Advanced" : "▸ Advanced");
    });

    const advancedEl = details.createDiv({ cls: "dkg-advanced-body" });

    new Setting(advancedEl)
      .setName("Auto-sync saved notes")
      .setDesc("On by default — your vault is kept in sync with your DKG node. Turn off to pause all syncing.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
          this.plugin.updateStatusBar();
        })
      );

    new Setting(advancedEl)
      .setName("Debounce (ms)")
      .setDesc("Milliseconds to wait after a note is modified before syncing.")
      .addText((text) =>
        text
          .setPlaceholder("1500")
          .setValue(String(this.plugin.settings.syncDebounceMs))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed >= 250) {
              this.plugin.settings.syncDebounceMs = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(advancedEl)
      .setName("Linked DKG Project")
      .setDesc(
        this.plugin.settings.defaultContextGraphId
          ? "Context graph identifier for this vault. Normally set by the wizard — only edit if you know what you are doing."
          : "No DKG Project linked yet — run the setup wizard."
      )
      .addText((text) =>
        text
          .setPlaceholder("dkg project id")
          .setValue(this.plugin.settings.defaultContextGraphId)
          .onChange(async (value) => {
            this.plugin.settings.defaultContextGraphId = value.trim();
            await this.plugin.saveSettings();
            this.plugin.updateStatusBar();
          })
      );
  }
}
