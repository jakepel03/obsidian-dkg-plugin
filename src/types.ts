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
  hasSeenPowerUpPrompt: boolean;
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
  hasSeenPowerUpPrompt: false,
  subscribedContextGraphs: [],
  folderDestinations: [],
};

export type RequestTransport = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

export interface ContextGraphSummary {
  id: string;
  name: string;
  subscribed?: boolean;
  synced?: boolean;
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
