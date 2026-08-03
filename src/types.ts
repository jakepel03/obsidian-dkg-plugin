import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

export interface SubscribedContextGraph {
  id: string;
  name: string;
  role: "owner" | "member";
  curated?: boolean;
  /**
   * Whether other members' shared notes in this project are materialized as
   * files under the shared-notes folder. undefined = yes (the default);
   * false = this project stays dashboard/Discover-only.
   */
  materialize?: boolean;
  /**
   * The curator's libp2p peer id, captured from the invite code at join time.
   * Used to pin on-demand artifact byte-reads (Fork) straight at the curator
   * instead of letting the node probe every connected peer sequentially.
   */
  curatorPeerId?: string;
}

/** A folder whose notes are shared to a project by default (e.g. `Team/` → research-team). */
export interface FolderDestination {
  /** Vault folder prefix, with or without a trailing slash. */
  folder: string;
  /** Subscribed project (context graph) id this folder's notes are shared to. */
  contextGraphId: string;
}

export interface OriginTrailSettings {
  dkgNodeUrl: string;
  authToken: string;
  defaultContextGraphId: string;
  autoSync: boolean;
  syncDebounceMs: number;
  vaultId: string;
  hasCompletedSetup: boolean;
  subscribedContextGraphs: SubscribedContextGraph[];
  /** Folder → project rules; notes under a folder are shared there automatically. */
  folderDestinations: FolderDestination[];
  /** Master switch for keeping other members' shared notes as files in the vault. */
  materializeSharedNotes: boolean;
  /** Vault folder that holds one subfolder per project with members' shared notes. */
  sharedFolderRoot: string;
  /** Show a (batched) notice when shared notes arrive or change. */
  sharedNotesNotices: boolean;
  /** Sync state per materialized note, keyed by the note's DKG entity URI. */
  materializedNotes: Record<string, MaterializedNoteState>;
}

/** What the plugin last wrote for one materialized shared note. */
export interface MaterializedNoteState {
  /** Vault path of the materialized file. */
  path: string;
  /** Upstream content fingerprint (`dkg:sourceFileHash`, e.g. "keccak256:…"); "" if the author's node didn't record one. */
  hash: string;
  /** SHA-256 of the file as the plugin last wrote it — a mismatch means the user edited the copy. */
  digest: string;
  /** Project the note belongs to. */
  cgId: string;
}

export const DEFAULT_SETTINGS: OriginTrailSettings = {
  dkgNodeUrl: "http://127.0.0.1:9200",
  authToken: "",
  defaultContextGraphId: "",
  autoSync: true,
  syncDebounceMs: 1500,
  vaultId: "",
  hasCompletedSetup: false,
  subscribedContextGraphs: [],
  folderDestinations: [],
  materializeSharedNotes: true,
  sharedFolderRoot: "Shared Projects",
  sharedNotesNotices: true,
  materializedNotes: {},
};

export type RequestTransport = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

/** Response from creating (and optionally on-chain registering) a context graph. */
export interface CreateContextGraphResult {
  created?: string;
  uri?: string;
  /** True when on-chain registration succeeded (only requested for public/open projects). */
  registered?: boolean;
  /** The on-chain id assigned at registration. */
  onChainId?: string;
  /** Present when on-chain registration was attempted but failed (e.g. an unfunded node wallet). */
  registerError?: string;
}

export interface ContextGraphSummary {
  id: string;
  name: string;
  /** Whether this node has a live subscription to the graph. */
  subscribed?: boolean;
  /** Whether the catch-up (replication) job has fully completed. */
  synced?: boolean;
  /** On-chain/local access policy as reported by the node ("public" | "private"). */
  accessPolicy?: string;
}

/**
 * Whether a subscribed project is fully usable on this node. For curated
 * (private) projects the gating truth is a non-empty allowlist (without it
 * the node can't decrypt or accept shared notes); for public projects it's
 * simply that the catch-up finished (`synced`). `catchup-status` is NOT used
 * here because it lags — it can stay "running" well after data has arrived.
 */
export interface ProjectReadiness {
  ready: boolean;
  synced: boolean;
  allowlistSize: number;
  accessPolicy?: string;
}

/** Identity of the local DKG node's agent (from `/api/agent/identity`). */
export interface AgentIdentity {
  agentAddress: string;
  peerId: string;
  name: string;
  agentDid: string;
}

/** Response from importing a Markdown file into an assertion. */
export interface ImportResult {
  extraction?: { status?: string; tripleCount?: number };
  fileHash?: string;
}

/** Response from polling an assertion's extraction status. */
export interface ExtractionStatusResponse {
  status?: string;
  tripleCount?: number;
  extraction?: { status?: string; tripleCount?: number };
}

export interface SyncResult {
  filePath: string;
  assertionName: string;
  status: "imported" | "promoted";
  tripleCount?: number;
  /** The context graph the note was actually synced into (primary or a shared project). */
  contextGraphId?: string;
  /** Set when routing fell back, e.g. an unknown `shared_to` project. */
  warning?: string;
}
