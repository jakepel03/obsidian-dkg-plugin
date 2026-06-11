import { describe, expect, it } from "vitest";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { DkgClient } from "../src/dkgClient";
import type { RequestTransport } from "../src/types";

/** A request transport that records calls and returns a canned response. */
function mockTransport(response: { status?: number; json?: unknown; text?: string }) {
  const calls: RequestUrlParam[] = [];
  const transport: RequestTransport = async (req) => {
    calls.push(req);
    return {
      status: response.status ?? 200,
      json: response.json,
      text: response.text ?? "",
    } as unknown as RequestUrlResponse;
  };
  return { transport, calls };
}

describe("DkgClient", () => {
  it("builds URLs from baseUrl (trimming a trailing slash) and adds the bearer token", async () => {
    const { transport, calls } = mockTransport({ json: { ok: true } });
    await new DkgClient("http://localhost:9200/", "tok", transport).status();
    expect(calls[0].url).toBe("http://localhost:9200/api/status");
    expect(calls[0].headers?.Authorization).toBe("Bearer tok");
  });

  it("omits the Authorization header when no token is configured", async () => {
    const { transport, calls } = mockTransport({ json: {} });
    await new DkgClient("http://localhost:9200", "", transport).status();
    expect(calls[0].headers?.Authorization).toBeUndefined();
  });

  it("throws with the status code and body on a non-2xx response", async () => {
    const { transport } = mockTransport({ status: 500, text: "boom" });
    await expect(new DkgClient("http://x", "", transport).status()).rejects.toThrow(/500.*boom/);
  });

  it("querySparql flattens bindings in both {value} and raw-string forms", async () => {
    const { transport } = mockTransport({
      json: { result: { bindings: [{ s: { value: "uri-1" }, name: '"Hello"' }] } },
    });
    const rows = await new DkgClient("http://x", "", transport).querySparql("SELECT *");
    expect(rows).toEqual([{ s: "uri-1", name: '"Hello"' }]);
  });

  it("catchupStatus returns null when the request fails (404, no job tracked)", async () => {
    const { transport } = mockTransport({ status: 404, text: "no job" });
    expect(await new DkgClient("http://x", "", transport).catchupStatus("cg")).toBeNull();
  });

  it("discardAssertion POSTs the correct path and body", async () => {
    const { transport, calls } = mockTransport({ json: { discarded: true } });
    await new DkgClient("http://x", "t", transport).discardAssertion("cg", "obsidian-note-abc");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/api/knowledge-assets/obsidian-note-abc/wm/discard");
    expect(JSON.parse(String(calls[0].body))).toEqual({ contextGraphId: "cg" });
  });

  it("promoteAssertion POSTs to the swm/share route with entities: all", async () => {
    const { transport, calls } = mockTransport({ json: { promotedCount: 3 } });
    await new DkgClient("http://x", "t", transport).promoteAssertion("cg", "obsidian-note-abc");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/api/knowledge-assets/obsidian-note-abc/swm/share");
    expect(JSON.parse(String(calls[0].body))).toEqual({ contextGraphId: "cg", entities: "all" });
  });
});
