import type {
  AgentIdentity,
  ContextGraphSummary,
  CreateContextGraphResult,
  ExtractionStatusResponse,
  ImportResult,
  ProjectReadiness,
  RequestTransport,
} from "./types";

/**
 * Reject after `ms` if `p` hasn't settled. Obsidian's requestUrl has no AbortSignal,
 * so the underlying request keeps running, but the caller is unblocked — used to stop a
 * slow P2P byte-read from hanging the UI when it can't be cancelled.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export class DkgClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authToken: string,
    private readonly request: RequestTransport
  ) {}

  async status(): Promise<unknown> {
    return this.json("GET", "/api/status");
  }

  async getIdentity(): Promise<AgentIdentity> {
    return this.json("GET", "/api/agent/identity") as Promise<AgentIdentity>;
  }

  async listContextGraphs(): Promise<ContextGraphSummary[]> {
    const data = await this.json("GET", "/api/context-graph/list");
    const container = data as { contextGraphs?: unknown[]; graphs?: unknown[] };
    const raw: unknown[] = Array.isArray(data) ? data : (container.contextGraphs ?? container.graphs ?? []);
    return raw
      .map((entry) => {
        const g = entry as Record<string, unknown>;
        // The creator DID carries the OWNER node's libp2p peer id
        // (`did:dkg:agent:12D3Koo…`) — the pin target for artifact byte-reads.
        const creator = typeof g.creator === "string" ? g.creator : "";
        const creatorPeer = creator.match(/^did:dkg:agent:(12D3Koo[\w]+)$/)?.[1];
        return {
          id: String(g.id ?? g.contextGraphId ?? g.context_graph_id ?? ""),
          name: String(g.name ?? g.displayName ?? g.id ?? g.contextGraphId ?? ""),
          subscribed: typeof g.subscribed === "boolean" ? g.subscribed : undefined,
          synced: typeof g.synced === "boolean" ? g.synced : undefined,
          accessPolicy: typeof g.accessPolicy === "string" ? g.accessPolicy : undefined,
          creatorPeerId: creatorPeer,
        };
      })
      .filter((g) => g.id.length > 0);
  }

  /**
   * Resolve whether a subscribed project is fully usable on this node.
   * Combines the `synced` flag (from the graph list) with the allowlist size
   * (from `/participants`) — see {@link ProjectReadiness} for why catch-up
   * status is deliberately not consulted.
   */
  async projectReadiness(contextGraphId: string): Promise<ProjectReadiness> {
    const [graphs, participants] = await Promise.all([
      this.listContextGraphs().catch((): ContextGraphSummary[] => []),
      this.listParticipants(contextGraphId).catch(() => ({ allowedAgents: [] as string[] })),
    ]);
    const entry = graphs.find((g) => g.id === contextGraphId);
    const synced = entry?.synced === true;
    const allowlistSize = participants.allowedAgents?.length ?? 0;
    const accessPolicy = entry?.accessPolicy;
    // Curated/private: an empty allowlist means this node isn't gated yet, so
    // it can't receive shares regardless of the synced flag. Public: synced is
    // the only thing that matters (the allowlist stays empty by design).
    const ready = accessPolicy === "private" ? allowlistSize > 0 : synced;
    return { ready, synced, allowlistSize, accessPolicy };
  }

  /**
   * Create a context graph. Policy semantics (verified against DKG rc.18):
   *  - `accessPolicy`: 0 = public (anyone can subscribe), 1 = private (allowlist).
   *  - `publishPolicy`: 0 = curated (only allowlisted agents write), 1 = open (any subscriber writes).
   * Defaults to a private vault graph (`accessPolicy: 1`).
   *
   * `register: true` also commits the CG on-chain in the same call. This is required for
   * PUBLIC/open projects so members can read shared note *content*: the node's
   * import-artifact read-guard only drops the owner check for a CG that is registered
   * public+open on-chain (verified live on rc.18). Registration is one-time and gas-only
   * — it does NOT publish notes to Verifiable Memory.
   */
  async createContextGraph(
    id: string,
    name: string,
    opts: { accessPolicy?: number; publishPolicy?: number; description?: string; register?: boolean } = {}
  ): Promise<CreateContextGraphResult> {
    return this.json("POST", "/api/context-graph/create", {
      id,
      name,
      description: opts.description ?? `Obsidian project for ${name}`,
      accessPolicy: opts.accessPolicy ?? 1,
      ...(opts.publishPolicy !== undefined ? { publishPolicy: opts.publishPolicy } : {}),
      ...(opts.register ? { register: true } : {}),
    }) as Promise<CreateContextGraphResult>;
  }

  /**
   * Register an already-created context graph on-chain (one-time, gas-only — no VM publish).
   * Used to retry registration for a PUBLIC/open project whose create-time registration
   * didn't land (e.g. the CG already existed locally). Returns the on-chain id on success.
   */
  async registerContextGraph(
    id: string,
    accessPolicy: number,
    publishPolicy: number
  ): Promise<{ registered?: string; onChainId?: string }> {
    return this.json("POST", "/api/context-graph/register", {
      id,
      accessPolicy,
      publishPolicy,
    }) as Promise<{ registered?: string; onChainId?: string }>;
  }

  async signJoinRequest(contextGraphId: string): Promise<any> {
    return this.json("POST", `/api/context-graph/${encodeURIComponent(contextGraphId)}/sign-join`);
  }

  async requestJoin(
    contextGraphId: string,
    delegation: unknown,
    agentName: string,
    curatorPeerId: string
  ): Promise<any> {
    return this.json("POST", `/api/context-graph/${encodeURIComponent(contextGraphId)}/request-join`, {
      delegation,
      agentName,
      curatorPeerId,
    });
  }

  async subscribeToContextGraph(contextGraphId: string): Promise<unknown> {
    return this.json("POST", "/api/context-graph/subscribe", {
      contextGraphId,
      includeSharedMemory: true,
    });
  }

  /** Drop the node's live subscription to a context graph (stops replication; the graph itself is untouched). */
  async unsubscribeFromContextGraph(contextGraphId: string): Promise<unknown> {
    return this.json("POST", "/api/context-graph/unsubscribe", { contextGraphId });
  }

  async listParticipants(contextGraphId: string): Promise<{ allowedAgents: string[] }> {
    return this.json("GET", `/api/context-graph/${encodeURIComponent(contextGraphId)}/participants`) as any;
  }

  async addParticipant(contextGraphId: string, agentAddress: string): Promise<unknown> {
    return this.json("POST", `/api/context-graph/${encodeURIComponent(contextGraphId)}/add-participant`, {
      agentAddress,
    });
  }

  async removeParticipant(contextGraphId: string, agentAddress: string): Promise<unknown> {
    return this.json("POST", `/api/context-graph/${encodeURIComponent(contextGraphId)}/remove-participant`, {
      agentAddress,
    });
  }

  async listJoinRequests(contextGraphId: string): Promise<any[]> {
    const data: any = await this.json("GET", `/api/context-graph/${encodeURIComponent(contextGraphId)}/join-requests`);
    return Array.isArray(data) ? data : (data?.requests ?? []);
  }

  async approveJoinRequest(contextGraphId: string, agentAddress: string): Promise<unknown> {
    return this.json("POST", `/api/context-graph/${encodeURIComponent(contextGraphId)}/approve-join`, { agentAddress });
  }

  async rejectJoinRequest(contextGraphId: string, agentAddress: string): Promise<unknown> {
    return this.json("POST", `/api/context-graph/${encodeURIComponent(contextGraphId)}/reject-join`, { agentAddress });
  }

  async ensureContextGraph(id: string, name: string): Promise<ContextGraphSummary> {
    const before = await this.listContextGraphs().catch((): ContextGraphSummary[] => []);
    const existing = before.find((g) => g.id === id || g.name === name);
    if (existing) return existing;

    try {
      await this.createContextGraph(id, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/409|conflict|already/i.test(message)) throw error;
    }

    const after = await this.listContextGraphs().catch((): ContextGraphSummary[] => []);
    return after.find((g) => g.id === id || g.name === name) ?? { id, name };
  }

  async importMarkdown(
    contextGraphId: string,
    assertionName: string,
    fileName: string,
    markdown: string
  ): Promise<ImportResult> {
    const boundary = `----obsidian-origintrail-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = this.multipartBody(
      boundary,
      {
        contextGraphId,
        contentType: "text/markdown",
      },
      {
        fieldName: "file",
        fileName,
        contentType: "text/markdown; charset=utf-8",
        content: markdown,
      }
    );

    return this.rawJson("POST", `/api/knowledge-assets/${encodeURIComponent(assertionName)}/wm/import-file`, body, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    }) as Promise<ImportResult>;
  }

  async extractionStatus(contextGraphId: string, assertionName: string): Promise<ExtractionStatusResponse> {
    const query = `contextGraphId=${encodeURIComponent(contextGraphId)}`;
    return this.json(
      "GET",
      `/api/knowledge-assets/${encodeURIComponent(assertionName)}/wm/extraction-status?${query}`
    ) as Promise<ExtractionStatusResponse>;
  }

  /**
   * Share an assertion's triples into Shared Memory (the route formerly named "promote").
   *
   * Sharing is seal-before-share, and the node seals for us: `share` always finalizes the
   * draft first, so the document flow (import-file → share) needs no explicit finalize
   * step. Sealing is local — the response reports `publishReady`, but nothing reaches the
   * chain until a VM publish, which the plugin never issues.
   */
  async promoteAssertion(contextGraphId: string, assertionName: string): Promise<unknown> {
    return this.json("POST", `/api/knowledge-assets/${encodeURIComponent(assertionName)}/swm/share`, {
      contextGraphId,
      entities: "all",
    });
  }

  /**
   * Discard an assertion from a context graph (Working Memory). Used to clean up
   * orphans when a note is renamed or deleted. The daemon returns 400 with a
   * "not found" message if the assertion never existed — callers treat that as
   * a no-op rather than an error.
   *
   * Sharing a note moves its content to Shared Memory and leaves no draft behind, so a
   * shared note's discard fails until one is seeded back from Shared Memory. Retry once
   * through `pull-from`; if that isn't the problem, reopening fails too and the original
   * error stands. Either way this clears only the local draft — there is no retract verb,
   * so the shared copy stays in the project and peers that synced it keep theirs.
   */
  async discardAssertion(contextGraphId: string, assertionName: string): Promise<unknown> {
    const path = `/api/knowledge-assets/${encodeURIComponent(assertionName)}/wm/discard`;
    try {
      return await this.json("POST", path, { contextGraphId });
    } catch (failure) {
      await this.json("POST", `/api/knowledge-assets/${encodeURIComponent(assertionName)}/wm/pull-from`, {
        contextGraphId,
        layer: "swm",
      }).catch(() => {
        throw failure;
      });
      return this.json("POST", path, { contextGraphId });
    }
  }

  /**
   * Append plugin-derived triples (resolved wikilinks, filename title) into an
   * already-imported assertion's WM graph, with provenance. Targets the source
   * import assertion identified by `assertionUri`; triples promote/demote with
   * the note.
   */
  async enrichAssertion(
    contextGraphId: string,
    assertionName: string,
    assertionUri: string,
    semanticQuads: Array<{ subject: string; predicate: string; object: string }>
  ): Promise<unknown> {
    return this.json("POST", "/api/knowledge-assets/semantic-enrichment/write", {
      contextGraphId,
      assertionName,
      assertionUri,
      semanticQuads,
      generationMethod: "obsidian-link-resolver",
    });
  }

  /** Run a read-only SPARQL SELECT and return rows as flat string maps (values unwrapped). */
  async querySparql(sparql: string): Promise<Array<Record<string, string>>> {
    const data: any = await this.json("POST", "/api/query", { sparql });
    const bindings: any[] = data?.result?.bindings ?? data?.bindings ?? [];
    return bindings.map((row: any) => {
      const out: Record<string, string> = {};
      for (const key of Object.keys(row)) {
        const v = row[key];
        out[key] = typeof v === "string" ? v : (v?.value ?? "");
      }
      return out;
    });
  }

  /**
   * Read the original Markdown bytes of an imported assertion. Returns the
   * markdown string, or null if the bytes are not available on this node
   * (e.g. a peer's note whose source bytes were not replicated — only the
   * triples were). Callers fall back to reconstructing from the graph.
   */
  async readImportedMarkdown(
    contextGraphId: string,
    assertionUri: string,
    assertionName: string
  ): Promise<string | null> {
    try {
      const data: any = await this.json("POST", "/api/knowledge-assets/import-artifact/read-markdown", {
        contextGraphId,
        assertionUri,
        assertionName,
      });
      return typeof data?.markdown === "string" ? data.markdown : null;
    } catch {
      // 404 = source bytes not replicated locally (cross-node); reconstruct instead.
      return null;
    }
  }

  /**
   * Fetch a shared note's full Markdown via the generic artifact reader. Unlike
   * `readImportedMarkdown` (local-only), this pulls the source bytes from a peer over
   * P2P and caches them — so it returns a project member's real prose, not a stub.
   *
   * Works cross-node for any project the requesting node is a member of: PUBLIC+open
   * projects via open serve, and curated/private projects via the node's authorized-read
   * path (it verifies the requester is on the CG allowlist; requires a node new enough to
   * support curated byte-reads — landed post-rc.18). When the source bytes can't be
   * reached (curator unreachable, or an older node), the node returns `denied`/
   * `unavailable` and this resolves to `null` so the caller falls back to a stub.
   *
   * `sourcePeerId` pins the fetch at a specific peer (the curator). The node tries it
   * FIRST and returns as soon as it yields the bytes, instead of probing every connected
   * peer sequentially (each bounded by a ~90s node-side timeout — the cause of multi-minute
   * "Forking…" hangs on a busy network). For curated projects the curator is the author, so
   * pinning is always correct; if the pinned peer can't serve it, the node still falls back
   * to peer discovery.
   *
   * The P2P fetch can still be slow or stall, so each page is bounded by `pageTimeoutMs`;
   * on timeout we resolve to `null` and the caller reconstructs a stub rather than spinning
   * forever.
   */
  async readArtifactMarkdown(
    contextGraphId: string,
    assertionUri: string,
    sourcePeerId?: string,
    pageTimeoutMs = 15000
  ): Promise<string | null> {
    const decode = (b64: string): string => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    };
    let offset = 0;
    let out = "";
    // Notes are normally one page (~1MB cap); loop only if a large note is chunked.
    for (let page = 0; page < 64; page++) {
      let data: any;
      try {
        data = await withTimeout(
          this.json("POST", "/api/knowledge-assets/import-artifact/read", {
            contextGraphId,
            assertionUri,
            kind: "markdown",
            offset,
            ...(sourcePeerId ? { sourcePeerId } : {}),
          }),
          pageTimeoutMs,
          "artifact byte-read"
        );
      } catch {
        return null;
      }
      const status = data?.status;
      if (status !== "local" && status !== "fetched" && status !== "unverified") return null;
      if (typeof data?.bytesB64 !== "string") return null;
      out += decode(data.bytesB64);
      if (!data.truncated || typeof data.nextOffset !== "number" || data.nextOffset <= offset) break;
      offset = data.nextOffset;
    }
    return out;
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.rawJson(method, path, body === undefined ? undefined : JSON.stringify(body), {
      "Content-Type": "application/json",
    });
  }

  private async rawJson(
    method: string,
    path: string,
    body?: string,
    extraHeaders: Record<string, string> = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = { ...extraHeaders };
    const token = this.authToken.trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await this.request({
      url: this.url(path),
      method,
      headers,
      body,
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      const text = typeof response.text === "string" ? response.text : JSON.stringify(response.json ?? "");
      throw new Error(`DKG ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
    }

    if (response.json !== undefined && response.json !== null) return response.json;
    if (!response.text) return {};
    try {
      return JSON.parse(response.text);
    } catch {
      return response.text;
    }
  }

  private url(path: string): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private multipartBody(
    boundary: string,
    fields: Record<string, string>,
    file: { fieldName: string; fileName: string; contentType: string; content: string }
  ): string {
    const chunks: string[] = [];
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipart(name)}"\r\n\r\n${value}\r\n`
      );
    }
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipart(file.fieldName)}"; filename="${escapeMultipart(file.fileName)}"\r\nContent-Type: ${file.contentType}\r\n\r\n${file.content}\r\n`
    );
    chunks.push(`--${boundary}--\r\n`);
    return chunks.join("");
  }
}

function escapeMultipart(value: string): string {
  return value.replace(/["\r\n]/g, "_");
}
