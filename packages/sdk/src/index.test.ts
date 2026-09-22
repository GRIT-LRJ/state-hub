import { describe, expect, it } from "vitest";
import { FrameDecoder, PluginRpcServer, encodeFrame } from "./index.js";

describe("plugin framing", () => {
  it("handles fragmented and coalesced Content-Length frames", () => {
    const decoder = new FrameDecoder();
    const first = encodeFrame({ n: 1 });
    const second = encodeFrame({ n: 2 });
    expect(decoder.push(first.subarray(0, 8))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(8), second]))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("rejects invalid frames and unbounded headers", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.from("Broken: 1\r\n\r\n{}"))).toThrow(/Content-Length/u);
    const unbounded = new FrameDecoder();
    expect(() => unbounded.push(Buffer.alloc(8193, 65))).toThrow(/header exceeds limit/u);
    const oversized = new FrameDecoder();
    expect(() => oversized.push(Buffer.from("Content-Length: 8388609\r\n\r\n")))
      .toThrow(/frame length/u);
  });

  it("negotiates protocol versions", async () => {
    const server = new PluginRpcServer({});
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "statehub.initialize",
      params: { protocolVersion: "1.0" },
    });
    expect(response.error).toBeUndefined();
  });
});
