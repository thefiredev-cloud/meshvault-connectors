import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BlobModule from "@vercel/blob";

const blob = vi.hoisted(() => ({ puts: 0, failFirst: 0, message: "" }));

vi.mock("@vercel/blob", async () => {
  const actual = await vi.importActual<typeof BlobModule>("@vercel/blob");
  return {
    ...actual,
    get: async () => ({ statusCode: 200, stream: new Response(JSON.stringify({ n: 3 })).body, blob: { etag: "e1" } }),
    put: async () => {
      blob.puts++;
      if (blob.puts <= blob.failFirst) throw new actual.BlobError(blob.message);
      return { etag: "e2" };
    },
  };
});

import { BlobStore, update } from "../src/store.js";

beforeEach(() => {
  blob.puts = 0;
});

describe("BlobStore concurrency", () => {
  it("retries when parallel writers hit the Blob 409 'conflicting operation' error", async () => {
    blob.failFirst = 2;
    blob.message = "The conditional request cannot succeed due to a conflicting operation against this resource.";
    const out = await update<{ n: number }>(new BlobStore("tok"), "usage/k-1/2026-10-06.json", (cur) => ({ n: (cur?.n ?? 0) + 1 }));
    expect(out).toEqual({ n: 4 });
    expect(blob.puts).toBe(3);
  });

  it("does not hide unrelated Blob errors", async () => {
    blob.failFirst = 1;
    blob.message = "Access denied, please provide a valid token for this resource.";
    await expect(update<{ n: number }>(new BlobStore("tok"), "x.json", () => ({ n: 1 }))).rejects.toThrow(/Access denied/);
    expect(blob.puts).toBe(1);
  });
});
