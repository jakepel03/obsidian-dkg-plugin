import type { App, TFile } from "obsidian";
import type { SubscribedContextGraph, SyncResult } from "./types";
import type { DkgClient } from "./dkgClient";
import { makeAssertionName, makeAssertionUri } from "./identity";

const SCHEMA_NAME = "http://schema.org/name";
const SCHEMA_MENTIONS = "http://schema.org/mentions";

export interface SyncOptions {
  /** The vault's own context graph — where notes land unless routed elsewhere. */
  primaryContextGraphId: string;
  vaultId: string;
  /** Global default for whether a synced note is promoted to Shared Memory. */
  autoPromote: boolean;
  /** Projects this vault can route notes into via `shared_to:` frontmatter. */
  subscribedContextGraphs?: SubscribedContextGraph[];
  /** This node's agent address, needed to build entity URIs for link enrichment. */
  agentAddress?: string;
}

export function isMarkdownFile(file: TFile): boolean {
  return file.extension.toLowerCase() === "md";
}

export function shouldSkipPath(path: string): boolean {
  return path.startsWith(".obsidian/") || path.startsWith(".trash/") || path.includes("/.trash/");
}

/**
 * Decide which context graph a note belongs to and whether to promote it,
 * based on the note's `shared_to:` / `shared:` frontmatter and the global
 * auto-promote default.
 *
 * - `shared_to: <project>` routes the note into that subscribed project (and
 *   promotes it, since an un-promoted note is invisible to other subscribers).
 * - `shared: true|false` overrides the global auto-promote default per note.
 * - Neither present → primary CG, promotion follows the global default.
 */
export function resolveRouting(
  frontmatter: Record<string, unknown> | undefined,
  opts: SyncOptions
): { contextGraphId: string; promote: boolean; warning?: string } {
  const fm = frontmatter ?? {};
  const sharedTo = typeof fm.shared_to === "string" ? fm.shared_to.trim() : "";
  const sharedFlag = typeof fm.shared === "boolean" ? fm.shared : undefined;

  let contextGraphId = opts.primaryContextGraphId;
  let promote = sharedFlag ?? opts.autoPromote;
  let warning: string | undefined;

  if (sharedTo) {
    const match = (opts.subscribedContextGraphs ?? []).find(
      (c) => c.id === sharedTo || c.name === sharedTo
    );
    if (match) {
      contextGraphId = match.id;
      // Sharing into a project implies promotion unless explicitly opted out.
      promote = sharedFlag ?? true;
    } else {
      warning = `Unknown project "${sharedTo}" in shared_to — synced to the primary project instead.`;
    }
  }

  return { contextGraphId, promote, warning };
}

export async function syncMarkdownFile(
  app: App,
  client: DkgClient,
  file: TFile,
  opts: SyncOptions
): Promise<SyncResult> {
  const content = await app.vault.read(file);
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as
    | Record<string, unknown>
    | undefined;
  const { contextGraphId, promote, warning } = resolveRouting(frontmatter, opts);

  const assertionName = await makeAssertionName(opts.vaultId, file.path);
  const imported: any = await client.importMarkdown(contextGraphId, assertionName, file.name, content);

  let tripleCount = imported?.extraction?.tripleCount;
  if (imported?.extraction?.status === "in_progress") {
    const status = await waitForExtraction(client, contextGraphId, assertionName);
    tripleCount = status?.tripleCount ?? status?.extraction?.tripleCount ?? tripleCount;
  }

  // Add the links + title the daemon's per-file extraction can't infer, into
  // the note's own WM assertion (so they promote/demote with the note).
  // Best-effort: a failure here must not fail the sync.
  try {
    await enrichAssertionWithLinks(app, client, file, opts, contextGraphId, assertionName);
  } catch (error) {
    console.warn(`[DKG] link/name enrichment failed for ${file.path}:`, error);
  }

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
    if (!targetPath.toLowerCase().endsWith(".md") || shouldSkipPath(targetPath) || targetPath === file.path) {
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
  const files = app.vault.getMarkdownFiles().filter((file) => !shouldSkipPath(file.path));
  const results: SyncResult[] = [];

  for (const file of files) {
    onProgress?.(results.length, files.length, file);
    results.push(await syncMarkdownFile(app, client, file, opts));
  }

  return results;
}

async function waitForExtraction(client: DkgClient, contextGraphId: string, assertionName: string): Promise<any> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(750);
    const status = await client.extractionStatus(contextGraphId, assertionName);
    const state = status?.status ?? status?.extraction?.status;
    if (state === "completed" || state === "failed" || state === "skipped") return status;
  }
  return {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
