import { describe, expect, it } from "vitest";
import {
  makeAssertionName,
  makeAssertionUri,
  makeVaultId,
  normalizeVaultPath,
  slugifyContextGraphId,
} from "../src/identity";

describe("identity helpers", () => {
  it("slugifies vault names into stable context graph ids", () => {
    expect(slugifyContextGraphId("AI Research Notes")).toBe("ai-research-notes");
    expect(slugifyContextGraphId("  Obsidian: OriginTrail / Shared Memory!  ")).toBe(
      "obsidian-origintrail-shared-memory"
    );
  });

  it("normalizes vault-relative paths", () => {
    expect(normalizeVaultPath("\\Folder\\Note.md")).toBe("Folder/Note.md");
    expect(normalizeVaultPath("/Folder/Note.md")).toBe("Folder/Note.md");
  });

  it("creates stable assertion names from vault id and file path only", async () => {
    const name = await makeAssertionName("vault-1", "Folder/Note.md");
    expect(name).toMatch(/^obsidian-note-[a-f0-9]{16}$/);
  });

  it("assertion name is stable across content edits", async () => {
    const a = await makeAssertionName("vault-1", "Folder/Note.md");
    const b = await makeAssertionName("vault-1", "Folder/Note.md");
    expect(a).toBe(b);
  });

  it("assertion name differs for different file paths", async () => {
    const a = await makeAssertionName("vault-1", "Folder/Note.md");
    const b = await makeAssertionName("vault-1", "Folder/Other.md");
    expect(a).not.toBe(b);
  });

  it("assertion name differs for different vault ids", async () => {
    const a = await makeAssertionName("vault-1", "Folder/Note.md");
    const b = await makeAssertionName("vault-2", "Folder/Note.md");
    expect(a).not.toBe(b);
  });

  it("derives the same vault id from the same seed (reset-proof)", async () => {
    const a = await makeVaultId("/home/user/Vaults/Research");
    const b = await makeVaultId("/home/user/Vaults/Research");
    expect(a).toBe(b);
    expect(a).toMatch(/^vault-[a-f0-9]{16}$/);
  });

  it("derives different vault ids for different seeds", async () => {
    const a = await makeVaultId("/home/user/Vaults/Research");
    const b = await makeVaultId("/home/user/Vaults/Journal");
    expect(a).not.toBe(b);
  });

  it("falls back to a random vault id when no seed is available", async () => {
    const a = await makeVaultId("");
    const b = await makeVaultId("   ");
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("builds the canonical assertion entity URI", () => {
    expect(makeAssertionUri("my-cg", "0xabc", "obsidian-note-123")).toBe(
      "did:dkg:context-graph:my-cg/assertion/0xabc/obsidian-note-123"
    );
  });
});
