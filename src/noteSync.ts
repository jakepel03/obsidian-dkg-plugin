import type { App, TFile } from "obsidian";
import type { FolderDestination, SubscribedContextGraph, SyncResult } from "./types";
import type { DkgClient } from "./dkgClient";
import { makeAssertionName, makeAssertionUri } from "./identity";
import { sanitizeFileName } from "./sharedNotes";
import { sleep } from "./utils";

const SCHEMA_NAME = "http://schema.org/name";
const SCHEMA_MENTIONS = "http://schema.org/mentions";

export interface SyncOptions {
  /** The vault's own context graph — where private notes land. */
  primaryContextGraphId: string;
  vaultId: string;
  /** Projects this vault can share notes into. */
  subscribedContextGraphs?: SubscribedContextGraph[];
  /** Folder → project rules; a note shares to the first matching folder's project. */
  folderDestinations?: FolderDestination[];
  /** This node's agent address, needed to build entity URIs for link enrichment. */
  agentAddress?: string;
  /** Root folder for project folders: received notes live here, and the user's own notes here are shared. */
  sharedFolderRoot?: string;
  /** Vault paths of currently materialized (received) notes — never imported. */
  materializedPaths?: Set<string>;
}

export function isMarkdownFile(file: TFile): boolean {
  return file.extension.toLowerCase() === "md";
}

export function shouldSkipPath(path: string): boolean {
  return (
    path.startsWith(".obsidian/") ||
    path.startsWith(".trash/") ||
    path.includes("/.trash/") ||
    // Forked/discovered notes are a read-only local cache, not authored content.
    path.startsWith("DKG Discover/")
  );
}

/**
 * Whether a file is another member's note received via materialization —
 * those are never imported, or they'd echo into this vault's graph under OUR
 * identity. The check is AUTHORSHIP-based, not path-based, so the user's own
 * notes dropped into a project folder do sync (see resolveRouting rule 3):
 *  - the controller's state map is authoritative for files it manages, and
 *  - the `dkg_author` provenance frontmatter covers copies that lost their
 *    state entry (conflicted/orphaned/moved copies stay someone else's work
 *    until the user deletes that key to adopt them).
 */
export function isReceivedSharedNote(
  frontmatter: Record<string, unknown> | undefined,
  filePath: string,
  materializedPaths?: Set<string>
): boolean {
  if (materializedPaths?.has(filePath)) return true;
  const author = frontmatter?.dkg_author;
  return typeof author === "string" && author.trim().length > 0;
}

/**
 * Decide where a note belongs. The model is "private by default, shared on
 * purpose": a note lives privately in your own vault graph unless it has an
 * explicit destination.
 *
 *  1. `shared_to: <project>` — share into that named subscribed project.
 *  2. otherwise, the first matching folder rule (`folderDestinations`).
 *  3. otherwise, the implicit shared-folder rule: your own note inside a
 *     project's folder (`<sharedFolderRoot>/<project name>/…`) is shared to
 *     that project — "a project is a folder in your vault". Derived from the
 *     subscription list at routing time, never stored, so leaving a project
 *     can't leave a stale rule behind.
 *  4. otherwise — private (primary graph, not promoted).
 *
 * "Shared" means promoted into the destination project's Shared Memory, which
 * is what makes it visible to that project's other subscribers.
 *
 * Received (materialized) notes never reach routing — callers exclude them
 * first via `isReceivedSharedNote`.
 */
export function resolveRouting(
  filePath: string,
  frontmatter: Record<string, unknown> | undefined,
  opts: SyncOptions
): { contextGraphId: string; promote: boolean; warning?: string } {
  const fm = frontmatter ?? {};
  const subs = opts.subscribedContextGraphs ?? [];
  const sharedTo = typeof fm.shared_to === "string" ? fm.shared_to.trim() : "";

  // 1. Explicit per-note destination.
  if (sharedTo) {
    const match = subs.find((c) => c.id === sharedTo || c.name === sharedTo);
    if (match) return { contextGraphId: match.id, promote: true };
    return {
      contextGraphId: opts.primaryContextGraphId,
      promote: false,
      warning: `Unknown project "${sharedTo}" in shared_to — kept private in your vault instead.`,
    };
  }

  // 2. Folder default destination.
  const folderDest = matchFolderDestination(filePath, opts.folderDestinations ?? [], subs);
  if (folderDest) return { contextGraphId: folderDest, promote: true };

  // 3. Implicit shared-folder rule.
  const implicit = matchSharedProjectFolder(filePath, opts.sharedFolderRoot, subs);
  if (implicit) return { contextGraphId: implicit, promote: true };

  // 4. Private.
  return { contextGraphId: opts.primaryContextGraphId, promote: false };
}

/**
 * Map `<sharedFolderRoot>/<project folder>/…` to the matching subscribed
 * project. The folder segment is matched against the same sanitized name the
 * materializer uses to create project folders, so both directions agree.
 */
function matchSharedProjectFolder(
  filePath: string,
  sharedFolderRoot: string | undefined,
  subs: SubscribedContextGraph[]
): string | undefined {
  if (!sharedFolderRoot) return undefined;
  const root = `${sharedFolderRoot.replace(/\/+$/, "")}/`;
  if (!filePath.startsWith(root)) return undefined;
  const segment = filePath.slice(root.length).split("/")[0];
  if (!segment) return undefined;
  return subs.find((c) => sanitizeFileName(c.name || c.id) === segment)?.id;
}

/**
 * Longest matching folder prefix wins; resolves the rule's project to a real id.
 * A rule pointing at a project this vault isn't subscribed to is skipped (the
 * note stays private), mirroring how `shared_to` refuses unknown projects —
 * a stale rule must not keep promoting notes into a graph the user left.
 */
function matchFolderDestination(
  filePath: string,
  rules: FolderDestination[],
  subs: SubscribedContextGraph[]
): string | undefined {
  let best: { len: number; cg: string } | undefined;
  for (const rule of rules) {
    if (!rule.folder || !rule.contextGraphId) continue;
    const prefix = rule.folder.endsWith("/") ? rule.folder : `${rule.folder}/`;
    if (!filePath.startsWith(prefix)) continue;
    const match = subs.find((c) => c.id === rule.contextGraphId || c.name === rule.contextGraphId);
    if (!match) continue;
    if (!best || prefix.length > best.len) best = { len: prefix.length, cg: match.id };
  }
  return best?.cg;
}

export async function syncMarkdownFile(
  app: App,
  client: DkgClient,
  file: TFile,
  opts: SyncOptions
): Promise<SyncResult> {
  const content = await app.vault.read(file);
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
  const { contextGraphId, promote, warning: routingWarning } = resolveRouting(file.path, frontmatter, opts);

  const assertionName = await makeAssertionName(opts.vaultId, file.path);
  const imported = await client.importMarkdown(contextGraphId, assertionName, file.name, content);

  let tripleCount = imported.extraction?.tripleCount;
  let extractionWarning: string | undefined;
  if (imported.extraction?.status === "in_progress") {
    const ext = await waitForExtraction(client, contextGraphId, assertionName);
    tripleCount = ext.tripleCount ?? tripleCount;
    if (ext.timedOut) {
      extractionWarning = "Extraction is still running on the node; the triple count may be incomplete.";
    }
  }

  // Add the links + title the daemon's per-file extraction can't infer, into
  // the note's own WM assertion (so they promote/demote with the note).
  // Best-effort: a failure here must not fail the sync.
  try {
    await enrichAssertionWithLinks(app, client, file, opts, contextGraphId, assertionName);
  } catch (error) {
    console.warn(`[DKG] link/name enrichment failed for ${file.path}:`, error);
  }

  const warning = [routingWarning, extractionWarning].filter(Boolean).join(" ") || undefined;

  if (promote) {
    await client.promoteAssertion(contextGraphId, assertionName);
    return { filePath: file.path, assertionName, status: "promoted", tripleCount, contextGraphId, warning };
  }

  return { filePath: file.path, assertionName, status: "imported", tripleCount, contextGraphId, warning };
}

/**
 * Emit the triples the daemon's single-file extraction cannot produce:
 *  - `schema:name` from the filename when the note has no `# H1` (the daemon
 *    only derives a name from a real H1).
 *  - `schema:mentions` edges from each `[[wikilink]]` to the *real* target
 *    note entity (the daemon only emits dangling `urn:dkg:md:<slug>` placeholders).
 *
 * Targets are resolved via Obsidian's link graph and addressed with the same
 * deterministic entity URI scheme the daemon uses, so the edges connect to the
 * actual assertions (once those targets are synced). Written into the note's
 * own WM assertion graph via semantic-enrichment.
 */
async function enrichAssertionWithLinks(
  app: App,
  client: DkgClient,
  file: TFile,
  opts: SyncOptions,
  contextGraphId: string,
  assertionName: string
): Promise<void> {
  if (!opts.agentAddress) return;

  const selfUri = makeAssertionUri(contextGraphId, opts.agentAddress, assertionName);
  const quads: Array<{ subject: string; predicate: string; object: string }> = [];

  // Title from filename only when the note has no H1 (else the daemon set it).
  const cache = app.metadataCache.getFileCache(file);
  const hasH1 = cache?.headings?.some((h) => h.level === 1) ?? false;
  if (!hasH1) {
    quads.push({ subject: selfUri, predicate: SCHEMA_NAME, object: JSON.stringify(file.basename) });
  }

  // Resolved wikilinks → real target note entities (same CG as this note).
  const resolved = app.metadataCache.resolvedLinks[file.path] ?? {};
  for (const targetPath of Object.keys(resolved)) {
    if (
      !targetPath.toLowerCase().endsWith(".md") ||
      shouldSkipPath(targetPath) ||
      // A link to a RECEIVED note must not mint an edge to a self-owned entity
      // URI — that note's real entity belongs to its author, not this vault.
      opts.materializedPaths?.has(targetPath) ||
      targetPath === file.path
    ) {
      continue;
    }
    const targetName = await makeAssertionName(opts.vaultId, targetPath);
    quads.push({
      subject: selfUri,
      predicate: SCHEMA_MENTIONS,
      object: makeAssertionUri(contextGraphId, opts.agentAddress, targetName),
    });
  }

  if (quads.length === 0) return;
  await client.enrichAssertion(contextGraphId, assertionName, selfUri, quads);
}

export async function syncAllMarkdownFiles(
  app: App,
  client: DkgClient,
  opts: SyncOptions,
  onProgress?: (done: number, total: number, file: TFile) => void
): Promise<SyncResult[]> {
  const files = app.vault.getMarkdownFiles().filter((file) => {
    if (shouldSkipPath(file.path)) return false;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    return !isReceivedSharedNote(fm, file.path, opts.materializedPaths);
  });
  const results: SyncResult[] = [];

  for (const file of files) {
    onProgress?.(results.length, files.length, file);
    results.push(await syncMarkdownFile(app, client, file, opts));
  }

  return results;
}

interface ExtractionResult {
  status?: string;
  tripleCount?: number;
  /** True when the node never reported a terminal state within the poll window. */
  timedOut: boolean;
}

async function waitForExtraction(
  client: DkgClient,
  contextGraphId: string,
  assertionName: string
): Promise<ExtractionResult> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(750);
    const status = await client.extractionStatus(contextGraphId, assertionName);
    const state = status.status ?? status.extraction?.status;
    if (state === "completed" || state === "failed" || state === "skipped") {
      return { status: state, tripleCount: status.tripleCount ?? status.extraction?.tripleCount, timedOut: false };
    }
  }
  return { timedOut: true };
}
