import { describe, expect, it } from "vitest";
import { isReceivedSharedNote, resolveRouting, type SyncOptions } from "../src/noteSync";

const base: SyncOptions = {
  primaryContextGraphId: "my-vault",
  vaultId: "vault-1",
  subscribedContextGraphs: [
    { id: "research-team", name: "Research Team", role: "member" },
    { id: "ml-notes", name: "ML Notes", role: "owner" },
  ],
  folderDestinations: [],
};

describe("resolveRouting (private by default, share to a destination)", () => {
  it("keeps a note private when nothing routes it", () => {
    const r = resolveRouting("Notes/Idea.md", undefined, base);
    expect(r).toEqual({ contextGraphId: "my-vault", promote: false });
  });

  it("shares to a project named by shared_to (by id)", () => {
    const r = resolveRouting("Notes/Idea.md", { shared_to: "research-team" }, base);
    expect(r).toEqual({ contextGraphId: "research-team", promote: true });
  });

  it("resolves shared_to given a project display name", () => {
    const r = resolveRouting("Notes/Idea.md", { shared_to: "ML Notes" }, base);
    expect(r).toEqual({ contextGraphId: "ml-notes", promote: true });
  });

  it("keeps a note private and warns when shared_to names an unknown project", () => {
    const r = resolveRouting("Notes/Idea.md", { shared_to: "nope" }, base);
    expect(r.contextGraphId).toBe("my-vault");
    expect(r.promote).toBe(false);
    expect(r.warning).toContain("Unknown project");
  });

  it("shares via a folder rule when no per-note destination is set", () => {
    const opts: SyncOptions = {
      ...base,
      folderDestinations: [{ folder: "Team/", contextGraphId: "research-team" }],
    };
    expect(resolveRouting("Team/Plan.md", undefined, opts)).toEqual({
      contextGraphId: "research-team",
      promote: true,
    });
    // A note outside the folder stays private.
    expect(resolveRouting("Personal/Plan.md", undefined, opts)).toEqual({
      contextGraphId: "my-vault",
      promote: false,
    });
  });

  it("matches folder rules with or without a trailing slash, longest prefix wins", () => {
    const opts: SyncOptions = {
      ...base,
      folderDestinations: [
        { folder: "Team", contextGraphId: "research-team" },
        { folder: "Team/ML", contextGraphId: "ml-notes" },
      ],
    };
    expect(resolveRouting("Team/General.md", undefined, opts).contextGraphId).toBe("research-team");
    expect(resolveRouting("Team/ML/Model.md", undefined, opts).contextGraphId).toBe("ml-notes");
  });

  it("lets an explicit shared_to override a folder rule", () => {
    const opts: SyncOptions = {
      ...base,
      folderDestinations: [{ folder: "Team/", contextGraphId: "research-team" }],
    };
    const r = resolveRouting("Team/Model.md", { shared_to: "ml-notes" }, opts);
    expect(r.contextGraphId).toBe("ml-notes");
  });

  it("keeps a note private when a folder rule points at a project the vault left", () => {
    const opts: SyncOptions = {
      ...base,
      folderDestinations: [{ folder: "Team/", contextGraphId: "departed-project" }],
    };
    expect(resolveRouting("Team/Plan.md", undefined, opts)).toEqual({
      contextGraphId: "my-vault",
      promote: false,
    });
  });

  it("falls through a stale folder rule to a broader subscribed one", () => {
    const opts: SyncOptions = {
      ...base,
      folderDestinations: [
        { folder: "Team/", contextGraphId: "research-team" },
        { folder: "Team/ML", contextGraphId: "departed-project" },
      ],
    };
    expect(resolveRouting("Team/ML/Model.md", undefined, opts).contextGraphId).toBe("research-team");
  });
});

describe("implicit shared-folder rule (a project is a folder)", () => {
  const opts: SyncOptions = { ...base, sharedFolderRoot: "Shared Projects" };

  it("shares a note placed inside a project's folder to that project", () => {
    expect(resolveRouting("Shared Projects/Research Team/Idea.md", undefined, opts)).toEqual({
      contextGraphId: "research-team",
      promote: true,
    });
    // Subfolders inside the project folder share too.
    expect(resolveRouting("Shared Projects/Research Team/Drafts/Idea.md", undefined, opts).contextGraphId).toBe(
      "research-team"
    );
  });

  it("keeps notes private outside a known project folder", () => {
    // Unknown project folder (e.g. after leaving the project).
    expect(resolveRouting("Shared Projects/Old Project/Idea.md", undefined, opts).promote).toBe(false);
    // Directly in the root, not in any project folder.
    expect(resolveRouting("Shared Projects/Idea.md", undefined, opts).promote).toBe(false);
    // No root configured (e.g. options built without settings).
    expect(resolveRouting("Shared Projects/Research Team/Idea.md", undefined, base).promote).toBe(false);
  });

  it("lets shared_to and explicit folder rules take precedence", () => {
    const withRule: SyncOptions = {
      ...opts,
      folderDestinations: [{ folder: "Shared Projects/Research Team/", contextGraphId: "ml-notes" }],
    };
    expect(
      resolveRouting("Shared Projects/Research Team/Idea.md", { shared_to: "ml-notes" }, opts).contextGraphId
    ).toBe("ml-notes");
    expect(resolveRouting("Shared Projects/Research Team/Idea.md", undefined, withRule).contextGraphId).toBe(
      "ml-notes"
    );
  });

  it("matches the sanitized folder name the materializer creates", () => {
    const weird: SyncOptions = {
      ...opts,
      subscribedContextGraphs: [{ id: "ab", name: "A/B: Testing?", role: "member" }],
    };
    expect(resolveRouting("Shared Projects/A_B_ Testing_/Note.md", undefined, weird).contextGraphId).toBe("ab");
  });
});

describe("isReceivedSharedNote (echo prevention)", () => {
  it("flags notes tracked by the materializer state", () => {
    expect(
      isReceivedSharedNote(undefined, "Shared Projects/Team/Note.md", new Set(["Shared Projects/Team/Note.md"]))
    ).toBe(true);
  });

  it("flags notes carrying dkg_author provenance even outside the folder", () => {
    expect(isReceivedSharedNote({ dkg_author: "0xabc" }, "Anywhere/Adopted.md")).toBe(true);
  });

  it("does not flag the user's own notes inside a project folder", () => {
    expect(isReceivedSharedNote({ title: "Mine" }, "Shared Projects/Team/Mine.md", new Set())).toBe(false);
    expect(isReceivedSharedNote(undefined, "Shared Projects/Team/Mine.md")).toBe(false);
  });
});
