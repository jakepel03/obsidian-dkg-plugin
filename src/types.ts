import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

export interface SubscribedContextGraph {
  id: string;
  name: string;
  role: "owner" | "member";
  curated?: boolean;
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
};

export type RequestTransport = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

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

/** Catch-up (replication) job status for a subscribed context graph. */
export interface CatchupStatus {
  status?: "pending" | "running" | "done" | "failed" | "denied" | "unreachable" | string;
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
