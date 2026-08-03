import type { MaterializedNoteState } from "./types";

const SCHEMA_NAME = "http://schema.org/name";
const DKG_SOURCE_FILE_HASH = "http://dkg.io/ontology/sourceFileHash";
const DKG_SOURCE_FILE_NAME = "http://dkg.io/ontology/sourceFileName";

/** One shared note as listed from the local node's replicated Shared Memory. */
export interface RemoteSharedNote {
  entityUri: string;
  cgId: string;
  /** Authoring agent's address (the `<agentAddress>` segment of the entity URI). */
  author: string;
  assertionName: string;
  /** Display title (schema:name). */
  name: string;
  /** Original vault filename on the author's side (`dkg:sourceFileName`), when recorded. */
  fileName?: string;
  /** Upstream content fingerprint (`dkg:sourceFileHash`), when recorded. */
  hash?: string;
}

/** What one refresh tick decided to do for a project. */
export interface MaterializePlan {
  /** Notes to fetch and write (file missing or upstream content changed). */
  fetch: Array<{ note: RemoteSharedNote; path: string; isNew: boolean }>;
  /** Materialized files whose upstream entity is gone (retracted/expired). */
  remove: Array<{ entityUri: string; state: MaterializedNoteState }>;
}

/**
 * The listing query for one project: every note ROOT entity with its title and
 * (when the author's node recorded them) the source-file hash + filename. Runs
 * against the LOCAL node only — subscribed projects' Shared Memory replicates
 * here in the background, so this is a millisecond-scale query with no P2P.
 * The end-anchor regex keeps the structural extractor's skolemized sub-entities
 * (`…/obsidian-note-<id>/.well-known/genid/…`) out, same as Discover.
 */
export function buildSharedNotesQuery(cgId: string): string {
  const prefix = `did:dkg:context-graph:${cgId}/assertion/`;
  return `SELECT DISTINCT ?s ?name ?hash ?file WHERE {
     GRAPH ?g { ?s <${SCHEMA_NAME}> ?name }
     OPTIONAL { GRAPH ?gh { ?s <${DKG_SOURCE_FILE_HASH}> ?hash } }
     OPTIONAL { GRAPH ?gf { ?s <${DKG_SOURCE_FILE_NAME}> ?file } }
     FILTER(STRSTARTS(STR(?s), "${prefix}"))
     FILTER(REGEX(STR(?s), "/obsidian-note-[^/]+$"))
   } ORDER BY ?name`;
}

/**
 * Flatten the listing rows into one note per entity. The same triple can live
 * in several graphs (working + shared memory), so an entity may come back as
 * multiple rows — keep the first, upgrading it if a later row carries the
 * hash/filename the first one lacked.
 */
export function parseSharedNoteRows(rows: Array<Record<string, string>>, cgId: string): RemoteSharedNote[] {
  const prefix = `did:dkg:context-graph:${cgId}/assertion/`;
  const byUri = new Map<string, RemoteSharedNote>();
  for (const row of rows) {
    const entityUri = row.s;
    if (!entityUri?.startsWith(prefix)) continue;
    const rest = entityUri.slice(prefix.length); // <agentAddress>/<assertionName>
    const slash = rest.indexOf("/");
    const hash = parseLiteral(row.hash ?? "");
    const fileName = parseLiteral(row.file ?? "");
    const existing = byUri.get(entityUri);
    if (existing) {
      if (!existing.hash && hash) existing.hash = hash;
      if (!existing.fileName && fileName) existing.fileName = fileName;
      continue;
    }
    byUri.set(entityUri, {
      entityUri,
      cgId,
      author: slash >= 0 ? rest.slice(0, slash) : "",
      assertionName: slash >= 0 ? rest.slice(slash + 1) : rest,
      name: parseLiteral(row.name) || rest,
      ...(fileName ? { fileName } : {}),
      ...(hash ? { hash } : {}),
    });
  }
  return Array.from(byUri.values());
}

/**
 * Decide, for one project, which notes to (re)write and which files to remove.
 * Pure: file-content conflict checks happen at execution time, not here.
 *
 *  - Only OTHER members' notes are materialized — the user's own originals
 *    already live in the vault.
 *  - A note already in `state` keeps its path forever (the user may know it);
 *    it is re-fetched when the upstream hash changed or its file went missing.
 *  - A note whose author recorded no hash is fetched once and then left alone
 *    (no fingerprint to compare); a manual refresh re-fetches it.
 *  - When the listing is EMPTY nothing is removed: an empty result usually
 *    means the project is still catching up, and treating that as "everything
 *    was retracted" would trash the user's whole folder.
 */
export function planProject(
  notes: RemoteSharedNote[],
  state: Record<string, MaterializedNoteState>,
  opts: {
    cgId: string;
    myAddress: string;
    /** Project folder, e.g. "Shared Projects/Team Research". */
    folder: string;
    /** Vault paths already occupied (existing files + other projects' state). */
    takenPaths: Set<string>;
    /** Entity URIs whose materialized file currently exists in the vault. */
    fileExists: (path: string) => boolean;
    /** True on a manual refresh: re-fetch hashless notes too. */
    manual?: boolean;
  }
): MaterializePlan {
  const plan: MaterializePlan = { fetch: [], remove: [] };
  const me = opts.myAddress.toLowerCase();
  const seen = new Set<string>();
  const taken = new Set(opts.takenPaths);
  for (const s of Object.values(state)) {
    if (s.cgId === opts.cgId) taken.add(s.path);
  }

  for (const note of notes) {
    if (me && note.author.toLowerCase() === me) continue;
    seen.add(note.entityUri);
    const known = state[note.entityUri];
    if (known) {
      const missing = !opts.fileExists(known.path);
      const changed = !!note.hash && note.hash !== known.hash;
      const hashless = !note.hash && !known.hash;
      if (missing || changed || (hashless && opts.manual)) {
        plan.fetch.push({ note, path: known.path, isNew: missing });
      }
      continue;
    }
    const path = pickAvailablePath(opts.folder, materializedFileName(note), taken);
    taken.add(path);
    plan.fetch.push({ note, path, isNew: true });
  }

  if (notes.length > 0) {
    for (const [entityUri, s] of Object.entries(state)) {
      if (s.cgId === opts.cgId && !seen.has(entityUri)) plan.remove.push({ entityUri, state: s });
    }
  }

  return plan;
}

/** The author's original filename when recorded, else the note title; always `.md`. */
export function materializedFileName(note: RemoteSharedNote): string {
  const base = note.fileName ? note.fileName.replace(/\.md$/i, "") : note.name;
  return `${sanitizeFileName(base)}.md`;
}

/** Avoid collisions (two authors sharing "Notes.md") with a short assertion-id suffix. */
function pickAvailablePath(folder: string, fileName: string, taken: Set<string>): string {
  const plain = `${folder}/${fileName}`;
  if (!taken.has(plain)) return plain;
  const stem = fileName.replace(/\.md$/i, "");
  for (let n = 2; ; n++) {
    const candidate = `${folder}/${stem} (${n}).md`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Make a note title / project name safe as a file or folder name. */
export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "untitled"
  );
}

/** Flatten a SPARQL JSON literal like `"\"Welcome\""` or `"\"x\"^^<type>"` to its value. */
export function parseLiteral(v: string): string {
  if (!v) return "";
  const m = v.match(/^"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"') : v;
}
