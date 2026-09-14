import assert from "node:assert/strict";
import test from "node:test";
import { scanBuffer } from "./server.mjs";

test("scanner wrapper treats exit zero as clean", async () => {
  const result = await scanBuffer(Buffer.from("safe"), {
    binary: "/usr/bin/true",
    timeoutMs: 1_000,
  });
  assert.equal(result.clean, true);
});

test("scanner wrapper fails closed when the engine cannot start", async () => {
  await assert.rejects(
    scanBuffer(Buffer.from("safe"), { binary: "/not/a/scanner", timeoutMs: 1_000 }),
  );
});
