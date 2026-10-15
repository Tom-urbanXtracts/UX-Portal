// Owner-approved live Store submission limit, 14 October 2026.
// Informational reads may retain the last successful snapshot; acceptance
// must recheck its age before creating any order or inventory commitment.
export const STORE_INVENTORY_MAX_AGE_MS = 5 * 60 * 1000;

export function storeInventorySnapshotError(
  state: Record<string, unknown> | null | undefined,
  now = Date.now(),
): string | null {
  if (
    !state?.last_successful_run_id || !state.last_successful_at ||
    !Number.isFinite(now)
  ) {
    return "Canix inventory verification is unavailable. Your draft is preserved; retry after inventory refreshes.";
  }
  const refreshedAt = Date.parse(String(state.last_successful_at));
  if (!Number.isFinite(refreshedAt) || refreshedAt > now) {
    return "Canix inventory refresh time could not be verified. Your draft is preserved.";
  }
  if (now - refreshedAt > STORE_INVENTORY_MAX_AGE_MS) {
    return "Canix inventory is more than five minutes old. Ordering is paused; your draft is preserved. Retry after inventory refreshes.";
  }
  return null;
}
