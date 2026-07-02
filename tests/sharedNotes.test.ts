import { describe, expect, it } from "vitest";
import {
  buildSharedNotesQuery,
  materializedFileName,
  parseLiteral,
  parseSharedNoteRows,
  planProject,
  sanitizeFileName,
  type RemoteSharedNote,
} from "../src/sharedNotes";
import type { MaterializedNoteState } from "../src/types";

const CG = "team-research";
const ME = "0xAAAA000000000000000000000000000000000001";
const PEER = "0xBBBB000000000000000000000000000000000002";

function entity(author: string, name: string): string {
  return `did:dkg:context-graph:${CG}/assertion/${author}/${name}`;
}

function row(author: string, assertion: string, name: string, extra?: { hash?: string; file?: string }) {
  return {
    s: entity(author, assertion),
    name: `"${name}"`,
    ...(extra?.hash ? { hash: `"${extra.hash}"` } : {}),
    ...(extra?.file ? { file: `"${extra.file}"` } : {}),
  };
}

function note(author: string, assertion: string, name: string, extra?: Partial<RemoteSharedNote>): RemoteSharedNote {
  return { entityUri: entity(author, assertion), cgId: CG, author, assertionName: assertion, name, ...extra };
}

function state(author: string, assertion: string, over?: Partial<MaterializedNoteState>) {
  return {
    [entity(author, assertion)]: {
      path: `Shared Projects/Team/${assertion}.md`,
      hash: "keccak256:old",
      digest: "d1",
      cgId: CG,
      ...over,
    },
  };
}

const planOpts = {
  cgId: CG,
  myAddress: ME,
  folder: "Shared Projects/Team",
  takenPaths: new Set<string>(),
  fileExists: () => true,
};

describe("shared notes listing", () => {
  it("query is scoped to the project's note root entities", () => {
    const q = buildSharedNotesQuery(CG);
    expect(q).toContain(`did:dkg:context-graph:${CG}/assertion/`);
    expect(q).toContain("/obsidian-note-[^/]+$");
    expect(q).toContain("sourceFileHash");
    expect(q).toContain("sourceFileName");
  });

  it("parses rows into notes with author, hash and original filename", () => {
    const notes = parseSharedNoteRows(
      [row(PEER, "obsidian-note-1", "Trip to Iceland", { hash: "keccak256:abc", file: "Trip to Iceland.md" })],
      CG
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].author).toBe(PEER);
    expect(notes[0].assertionName).toBe("obsidian-note-1");
    expect(notes[0].hash).toBe("keccak256:abc");
    expect(notes[0].fileName).toBe("Trip to Iceland.md");
  });

  it("collapses duplicate rows (same triple in several graphs), keeping the richer data", () => {
    const notes = parseSharedNoteRows(
      [row(PEER, "obsidian-note-1", "Note"), row(PEER, "obsidian-note-1", "Note", { hash: "keccak256:abc" })],
      CG
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].hash).toBe("keccak256:abc");
  });
});

describe("planProject", () => {
  it("materializes only OTHER members' notes", () => {
    const plan = planProject(
      [note(ME, "obsidian-note-1", "Mine"), note(PEER, "obsidian-note-2", "Theirs")],
      {},
      planOpts
    );
    expect(plan.fetch).toHaveLength(1);
    expect(plan.fetch[0].note.name).toBe("Theirs");
    expect(plan.fetch[0].isNew).toBe(true);
  });

  it("re-fetches when the upstream hash changed, at the existing path", () => {
    const st = state(PEER, "obsidian-note-1");
    const plan = planProject([note(PEER, "obsidian-note-1", "N", { hash: "keccak256:new" })], st, planOpts);
    expect(plan.fetch).toHaveLength(1);
    expect(plan.fetch[0].path).toBe("Shared Projects/Team/obsidian-note-1.md");
    expect(plan.fetch[0].isNew).toBe(false);
  });

  it("leaves an unchanged note alone", () => {
    const st = state(PEER, "obsidian-note-1", { hash: "keccak256:same" });
    const plan = planProject([note(PEER, "obsidian-note-1", "N", { hash: "keccak256:same" })], st, planOpts);
    expect(plan.fetch).toHaveLength(0);
    expect(plan.remove).toHaveLength(0);
  });

  it("recreates a note whose materialized file went missing", () => {
    const st = state(PEER, "obsidian-note-1", { hash: "keccak256:same" });
    const plan = planProject([note(PEER, "obsidian-note-1", "N", { hash: "keccak256:same" })], st, {
      ...planOpts,
      fileExists: () => false,
    });
    expect(plan.fetch).toHaveLength(1);
    expect(plan.fetch[0].isNew).toBe(true);
  });

  it("re-fetches hashless notes only on a manual refresh", () => {
    const st = state(PEER, "obsidian-note-1", { hash: "" });
    const auto = planProject([note(PEER, "obsidian-note-1", "N")], st, planOpts);
    expect(auto.fetch).toHaveLength(0);
    const manual = planProject([note(PEER, "obsidian-note-1", "N")], st, { ...planOpts, manual: true });
    expect(manual.fetch).toHaveLength(1);
  });

  it("removes state entries whose entity is gone — unless the listing is empty", () => {
    const st = state(PEER, "obsidian-note-1");
    const withOthers = planProject([note(PEER, "obsidian-note-2", "Other")], st, planOpts);
    expect(withOthers.remove).toHaveLength(1);
    expect(withOthers.remove[0].entityUri).toBe(entity(PEER, "obsidian-note-1"));

    // An empty listing usually means catch-up lag, not mass retraction.
    const emptied = planProject([], st, planOpts);
    expect(emptied.remove).toHaveLength(0);
  });

  it("never removes another project's state", () => {
    const st = state(PEER, "obsidian-note-1", { cgId: "other-project" });
    const plan = planProject([note(PEER, "obsidian-note-2", "N")], st, planOpts);
    expect(plan.remove).toHaveLength(0);
  });

  it("suffixes colliding filenames from different authors", () => {
    const a = note(PEER, "obsidian-note-1", "Notes", { fileName: "Notes.md" });
    const b = note("0xCCCC000000000000000000000000000000000003", "obsidian-note-2", "Notes", { fileName: "Notes.md" });
    const plan = planProject([a, b], {}, planOpts);
    expect(plan.fetch.map((f) => f.path)).toEqual([
      "Shared Projects/Team/Notes.md",
      "Shared Projects/Team/Notes (2).md",
    ]);
  });

  it("avoids paths already occupied by existing vault files", () => {
    const plan = planProject(
      [note(PEER, "obsidian-note-1", "Notes", { fileName: "Notes.md" })],
      {},
      {
        ...planOpts,
        takenPaths: new Set(["Shared Projects/Team/Notes.md"]),
      }
    );
    expect(plan.fetch[0].path).toBe("Shared Projects/Team/Notes (2).md");
  });
});

describe("filename helpers", () => {
  it("prefers the author's original filename over the title", () => {
    expect(materializedFileName(note(PEER, "n", "A Title", { fileName: "Real Name.md" }))).toBe("Real Name.md");
    expect(materializedFileName(note(PEER, "n", "A Title"))).toBe("A Title.md");
  });

  it("sanitizes characters that are invalid in file names", () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
    expect(sanitizeFileName("   ")).toBe("untitled");
  });

  it("parses SPARQL literals in quoted and typed forms", () => {
    expect(parseLiteral('"Hello"')).toBe("Hello");
    expect(parseLiteral('"x"^^<http://www.w3.org/2001/XMLSchema#string>')).toBe("x");
    expect(parseLiteral("plain")).toBe("plain");
  });
});
