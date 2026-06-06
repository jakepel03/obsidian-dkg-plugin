import { describe, expect, it } from "vitest";
import { parseInviteCode } from "../src/utils";

describe("parseInviteCode", () => {
  it("splits a two-line curated invite into cgId + curatorPeerId", () => {
    expect(parseInviteCode("my-project\n12D3KooWabc")).toEqual({
      cgId: "my-project",
      curatorPeerId: "12D3KooWabc",
    });
  });

  it("handles an open-mode invite with only a cgId", () => {
    expect(parseInviteCode("my-project")).toEqual({ cgId: "my-project", curatorPeerId: "" });
  });

  it("trims surrounding whitespace on both parts", () => {
    expect(parseInviteCode("  my-project \n  peer-id  ")).toEqual({
      cgId: "my-project",
      curatorPeerId: "peer-id",
    });
  });
});
