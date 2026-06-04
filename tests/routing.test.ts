import { describe, expect, it } from "vitest";
import { resolveRouting, type SyncOptions } from "../src/noteSync";

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
});
