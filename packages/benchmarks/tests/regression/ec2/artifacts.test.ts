import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  CompressedArtifactError,
  decodeCompressedArtifact,
  SSM_STDOUT_CHARACTER_LIMIT,
} from "../../../src/regression/ec2/artifacts";

function encode(text: string): string {
  return gzipSync(Buffer.from(text, "utf-8")).toString("base64");
}

describe("decodeCompressedArtifact", () => {
  it("round-trips a gzip+base64 artifact", () => {
    const original = "# Performance regression report\n\nsome content";
    const encoded = encode(original);
    expect(decodeCompressedArtifact(encoded)).toBe(original);
  });

  it("rejects stdout at the SSM character cap", () => {
    const paddedPayload = "a".repeat(SSM_STDOUT_CHARACTER_LIMIT);
    expect(() => decodeCompressedArtifact(paddedPayload)).toThrowError(
      CompressedArtifactError,
    );
  });

  it("rejects a truncated gzip stream", () => {
    const encoded = encode("a".repeat(1000));
    const truncated = encoded.slice(0, Math.floor(encoded.length / 2));
    expect(() => decodeCompressedArtifact(truncated)).toThrowError(
      CompressedArtifactError,
    );
  });

  it("accepts a payload comfortably under the character cap", () => {
    const encoded = encode("small report");
    expect(encoded.length).toBeLessThan(SSM_STDOUT_CHARACTER_LIMIT);
    expect(decodeCompressedArtifact(encoded)).toBe("small report");
  });
});
