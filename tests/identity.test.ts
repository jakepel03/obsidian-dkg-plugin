import { describe, expect, it } from "vitest";
import { makeAssertionName, normalizeVaultPath, slugifyContextGraphId } from "../src/identity";

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
});
