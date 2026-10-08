export const ACCESS_REQUEST_REVIEWABLE_STATES = new Set([
  "submitted",
  "under_review",
  "returned",
]);

export const ACCESS_REQUEST_DECISIONS = new Set([
  "under_review",
  "returned",
  "approved",
  "denied",
]);

export function accessRequestDecisionAllowed(
  current: string,
  decision: string,
): boolean {
  return ACCESS_REQUEST_REVIEWABLE_STATES.has(current) &&
    ACCESS_REQUEST_DECISIONS.has(decision);
}

export function accessRequestRiskTier(
  staffRole: string,
  departmentKey: string | null,
  departmentSensitive: boolean,
): "ordinary" | "sensitive" | "privileged" {
  if (staffRole === "administrator" || departmentKey === "it_admin") {
    return "privileged";
  }
  if (departmentSensitive) return "sensitive";
  return "ordinary";
}

export type PurchaseApprovalRoute = {
  tier: "eric_500" | "leadership_2999" | "eran_3000";
  authority: string;
};

export function purchaseApprovalRoute(amount: number): PurchaseApprovalRoute {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Purchase amount must be greater than zero.");
  }
  if (amount <= 500) return { tier: "eric_500", authority: "Eric Stewart" };
  if (amount < 3000) {
    return { tier: "leadership_2999", authority: "Omeed / Jonathan / Drew" };
  }
  return { tier: "eran_3000", authority: "Eran" };
}
