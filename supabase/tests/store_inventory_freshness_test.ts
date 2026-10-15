import {
  STORE_INVENTORY_MAX_AGE_MS,
  storeInventorySnapshotError,
} from "../functions/_shared/store-inventory-freshness.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const now = Date.parse("2026-10-14T20:30:00Z");
const snapshot = (age: number) => ({
  last_successful_run_id: "last-good-inventory-run",
  last_successful_at: new Date(now - age).toISOString(),
});

Deno.test("Store checkout accepts inventory up to exactly five minutes old", () => {
  assert(storeInventorySnapshotError(snapshot(0), now) === null, "current snapshot");
  assert(
    storeInventorySnapshotError(snapshot(STORE_INVENTORY_MAX_AGE_MS), now) === null,
    "exactly five minutes is within the approved limit",
  );
});

Deno.test("Store checkout blocks inventory immediately beyond five minutes", () => {
  const error = storeInventorySnapshotError(snapshot(STORE_INVENTORY_MAX_AGE_MS + 1), now);
  assert(error?.includes("five minutes"), "stale inventory must block submission");
  assert(error?.includes("draft is preserved"), "explain that the draft survives");
});

Deno.test("Store checkout rejects missing run IDs and unverifiable timestamps", () => {
  for (const state of [null, {}, { last_successful_run_id: "run" },
    { ...snapshot(0), last_successful_run_id: null },
    { ...snapshot(0), last_successful_at: "invalid" },
    snapshot(-1)]) {
    assert(storeInventorySnapshotError(state, now) !== null, "unknown/future source must fail closed");
  }
});

Deno.test("Store checkout uses last successful refresh during a running sync", () => {
  assert(
    storeInventorySnapshotError({ ...snapshot(60_000), status: "syncing" }, now) === null,
    "a new sync does not invalidate a last-good snapshot within the limit",
  );
  assert(
    storeInventorySnapshotError({ ...snapshot(360_000), status: "syncing", updated_at: new Date(now).toISOString() }, now) !== null,
    "recent job activity must not make old inventory fresh",
  );
});
