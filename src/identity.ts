export function slugifyContextGraphId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "obsidian-vault";
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export async function makeAssertionName(vaultId: string, filePath: string): Promise<string> {
  const normalized = normalizeVaultPath(filePath);
  const hash = await sha256Hex(`${vaultId}:${normalized}`);
  return `obsidian-note-${hash.slice(0, 16)}`;
}

/**
 * The canonical DKG entity URI for a note's assertion, matching how the daemon
 * names imported assertions: `did:dkg:context-graph:{cg}/assertion/{agentAddress}/{assertionName}`.
 * Deterministic from data the plugin already holds, so it can author edges
 * to/from any note without querying the node.
 */
export function makeAssertionUri(contextGraphId: string, agentAddress: string, assertionName: string): string {
  return `did:dkg:context-graph:${contextGraphId}/assertion/${agentAddress}/${assertionName}`;
}

/**
 * Stable per-vault id. Derived deterministically from the vault's location
 * (seed = filesystem base path, or vault name as a fallback) so a plugin-data
 * reset re-derives the SAME id and re-imports land on the existing assertion
 * names — a random id here once orphaned a whole vault graph after a data
 * reset, and context graphs can't be deleted (#66). Existing persisted ids
 * are never re-derived; this only runs when data.json has no vaultId.
 */
export async function makeVaultId(seed: string): Promise<string> {
  const trimmed = seed.trim();
  if (trimmed) {
    const hash = await sha256Hex(`obsidian-vault:${trimmed}`);
    return `vault-${hash.slice(0, 16)}`;
  }
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `vault-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
