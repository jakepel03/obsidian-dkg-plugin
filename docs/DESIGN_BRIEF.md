# Design brief — OriginTrail DKG for Obsidian

DKG v10 integrations bounty, Round 1 (`cfi-dkgv10-r1`). Working/Shared Memory only.

- **Integration:** OriginTrail DKG for Obsidian (`obsidian-dkg`)
- **Repo:** https://github.com/jakepel03/obsidian-dkg-plugin
- **Maintainer:** Jaka Pelko ([@jakepel03](https://github.com/jakepel03))
- **License:** MIT
- **Public interface used:** DKG v10 HTTP API only (`http://127.0.0.1:9200` by default)
- **Memory layers:** Working Memory (WM) and Shared Memory (SWM). No Verified Memory.

---

## 1. Problem

Obsidian is one of the most popular tools for building a personal knowledge base — a
local-first "second brain" of Markdown notes and `[[wikilinks]]`. But that knowledge is
trapped: it lives as flat files on one machine, it isn't queryable as a graph beyond
Obsidian's own UI, it carries no portable provenance, and there is no first-class way to
share a slice of it with a teammate or an AI agent without copying files around.

Meanwhile the DKG v10 memory model (Working → Shared → Verified) is a natural home for
exactly this kind of human-authored, incrementally-curated knowledge — but its on-ramps
so far are agent-, CLI-, and MCP-shaped. There is no on-ramp for the large existing
community of humans who already author structured notes every day.

## 2. Target user

Knowledge workers, researchers, and small teams who already keep an Obsidian vault and
want their notes to become **queryable, provenance-aware, selectively shareable** graph
memory — without leaving Obsidian or learning the DKG API. Secondarily, the AI agents
those people work with: once a vault's notes are in WM/SWM on a local node, any agent on
the same node (e.g. via the DKG MCP server) can discover and build on them.

## 3. What it does

A note's lifecycle through the plugin:

1. **Connect** (3-step setup wizard): enter the local node's URL + auth token; the plugin
   verifies the connection and links a **Context Graph** named after the vault.
2. **Import to Working Memory**: every Markdown note is imported as an **Assertion**
   (`POST /api/knowledge-assets/{name}/wm/import-file`). Stable, content-addressed assertion
   names keep a note's identity constant across edits.
3. **Enrich for connectivity**: after import, the plugin resolves Obsidian's `[[wikilinks]]`
   to the *real* target assertion URIs and writes `schema:mentions` edges plus a
   `schema:name` title triple back onto the note's own WM graph, with provenance
   (`POST /api/knowledge-assets/semantic-enrichment/write`). This turns a bag of documents into a
   connected graph that mirrors the vault's link structure.
4. **Stay fresh**: auto-sync mirrors creates / edits / renames / deletes to the node
   (debounced). Renames and deletes discard the orphaned assertion
   (`POST /api/knowledge-assets/{name}/wm/discard`).
5. **Share, explicitly**: a note moves to **Shared Memory** only on a deliberate user
   action — *Share current note to a project*, or a folder→project rule the user
   configured — which calls `POST /api/knowledge-assets/{name}/swm/share` to gossip the note's
   triples into a project's Shared Memory for subscribed members.
6. **Collaborate & discover**: create or join projects (curated/private or open), manage
   membership, and browse notes others have shared into a project you're subscribed to.

**Private by default** is the core invariant: nothing leaves your node until you share it,
and the plugin never publishes to Verified Memory.

## 4. Memory layers

- **Working Memory** — the default and the bulk of the integration. Each note is a private,
  per-node assertion in the vault's Context Graph, enriched with link/title triples.
- **Shared Memory** — opt-in, per note or per folder. Promotion gossips the note's triples
  to subscribed project members.
- **Verified Memory** — **intentionally out of scope** for this beta (and for Round 1).
  Assertions carry stable assertion URIs (UALs), so a future Curator `PUBLISH` step could
  anchor team-validated notes on-chain without reshaping the data.

## 5. v10 primitives used

| Primitive | How it's exercised |
| --- | --- |
| **Context Graph** | One per vault (private); plus shared projects users create/join. |
| **Assertion** | Each note → one assertion; import / enrich / promote / discard lifecycle. |
| **Entity** | Resolved wikilinks emit `schema:mentions` edges to target entity URIs. |
| **Curator** | `promote` (SHARE, WM→SWM) and membership ops (approve-join / add / remove participant) are Curator-authority and only run on explicit user action. |
| **UAL** | Notes keep stable assertion URIs (`did:dkg:context-graph:{cg}/assertion/{agent}/{name}`) used for enrichment edges and Discover. |

## 6. Fit with the LLM-Wiki / autoresearch direction

The registry's existing entries write the substrate from the *agent* side (MCP servers,
CLIs, framework plugins). This integration is the **human-authoring on-ramp**: it brings
the place where people already write into the same WM/SWM substrate those agents read and
extend. The per-note **private → shared** gradient the user controls maps directly onto the
**WM → SWM** trust gradient of the LLM-Wiki model — a human curates a note, promotes it
when it's worth sharing, and from there it is discoverable and (in a later round)
publishable. Human-curated notes and agent-authored findings accumulate in the same graph,
on the same node, under one provenance model.

## 7. Promotion path

Import → WM assertion (+ enrichment) → explicit user SHARE → SWM (gossiped to project
members) → *(future, out of scope here)* Curator PUBLISH → VM / oracle-consumable. Because
identities (assertion URIs / UALs) are stable across the WM→SWM transition, no data is
reshaped on promotion, and the same SPARQL queries return a note whether it's private or
shared.

## 8. Terminology

The plugin uses end-user language in its UI ("project", "share", "private") so non-technical
note-takers aren't forced to learn the model up front, but it maps 1:1 onto v10 vocabulary:
**project = Context Graph**, **note = Assertion**, **share = promote to Shared Memory
(Curator SHARE)**, **vault graph = the user's private Context Graph**. This brief and the
registry entry use the canonical v10 terms.

## 9. Security posture

- **Network egress: none** beyond the local DKG node. No third-party hosts.
- The DKG **auth token** is entered in plugin settings and stored only in the vault's local
  plugin data; it is sent only as a `Bearer` header to the local node.
- The only **Curator-authority SHARE** is `promote`, and it is never automatic — it fires
  only when the user shares a note or via a folder rule they configured. Membership ops run
  only when the user manages their own project.
- **No Verified Memory / PUBLISH** operations.
- Distributed as an Obsidian plugin (prebuilt `main.js` / `manifest.json` / `styles.css`
  committed to the repo); **no npm/postinstall machinery**.

## 10. Honest current limitations

These are surfaced so the model is faithful, not glossed:

- **No remote retraction.** Making a note private or deleting it cleans your own node, but a
  copy already gossiped to a peer ages out only via the Shared-Memory TTL (~30 days), and a
  peer's already-synced copy can persist. The plugin states this honestly on unshare/delete.

## 11. Demo

A recorded walkthrough (connect → import to WM → edit/auto-sync → create project → share a
note → Discover) is linked from the registry entry's `demo` field and this repo's README.
