import {
  approvedHttpsUrl,
  canonicalCanixProductId,
  labFailed,
  labPassed,
  mondayOrderState,
  orderTransitionAllowed,
  verifyHs256Jwt,
} from "../functions/_shared/security-contract.ts";
import { verifiedTokenIsAuthenticated } from "../functions/_shared/auth.ts";
import {
  accessRequestDecisionAllowed,
  accessRequestRiskTier,
  purchaseApprovalRoute,
} from "../functions/_shared/internal-work-contract.ts";
import {
  supplyOrderApprovalRoute,
  supplyOrderValidation,
} from "../functions/_shared/supply-order-contract.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Canix lab release accepts only exact TestPassed status", () => {
  assert(
    labPassed({ lab_test_status: "TestPassed" }),
    "TestPassed should release",
  );
  assert(
    labPassed({
      lab_test_status: "NotSubmitted",
      test_result_status: "TestPassed",
    }),
    "test result should take precedence",
  );
  assert(
    !labPassed({ lab_test_status: "NotPassed" }),
    "substring matches must not release",
  );
  assert(
    !labPassed({ lab_test_status: "SubmittedForTesting" }),
    "pending tests must not release",
  );
  assert(
    labFailed({ lab_test_status: "TestFailed" }),
    "TestFailed should be excluded",
  );
});

function unsignedTestJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

Deno.test("portal API assurance gate accepts authenticated user claims", () => {
  assert(
    verifiedTokenIsAuthenticated(
      `Bearer ${
        unsignedTestJwt({ role: "authenticated", sub: "user-1", aal: "aal1" })
      }`,
    ),
    "an aal1 authenticated user should pass after upstream JWT validation",
  );
  assert(
    verifiedTokenIsAuthenticated(
      `Bearer ${
        unsignedTestJwt({ role: "authenticated", sub: "user-1", aal: "aal2" })
      }`,
    ),
    "an existing aal2 authenticated user should also pass",
  );
  assert(
    !verifiedTokenIsAuthenticated(
      `Bearer ${unsignedTestJwt({ role: "anon", sub: "user-1" })}`,
    ),
    "anonymous claims must fail",
  );
  assert(
    !verifiedTokenIsAuthenticated(
      `Bearer ${unsignedTestJwt({ role: "authenticated" })}`,
    ),
    "authenticated claims without a subject must fail",
  );
  assert(
    !verifiedTokenIsAuthenticated("Bearer malformed"),
    "malformed JWT must fail",
  );
});

Deno.test("access requests cannot bypass reviewable states", () => {
  assert(
    accessRequestDecisionAllowed("submitted", "approved"),
    "submitted requests may be approved",
  );
  assert(
    accessRequestDecisionAllowed("under_review", "returned"),
    "review may request changes",
  );
  assert(
    !accessRequestDecisionAllowed("approved", "approved"),
    "approved requests are terminal",
  );
  assert(
    !accessRequestDecisionAllowed("denied", "under_review"),
    "denied requests cannot be reopened implicitly",
  );
  assert(
    !accessRequestDecisionAllowed("submitted", "cancelled"),
    "unsupported decisions must fail",
  );
});

Deno.test("access risk is raised for Administrator and sensitive departments", () => {
  assert(
    accessRequestRiskTier("administrator", "marketing", false) === "privileged",
    "Administrator is privileged",
  );
  assert(
    accessRequestRiskTier("viewer", "it_admin", true) === "privileged",
    "IT access is privileged",
  );
  assert(
    accessRequestRiskTier("viewer", "finance", true) === "sensitive",
    "Finance is sensitive",
  );
  assert(
    accessRequestRiskTier("viewer", "marketing", false) === "ordinary",
    "ordinary access stays ordinary",
  );
});

Deno.test("purchase approvals follow the approved spending thresholds", () => {
  assert(
    purchaseApprovalRoute(500).tier === "eric_500",
    "$500 routes to Eric",
  );
  assert(
    purchaseApprovalRoute(500.01).tier === "leadership_2999",
    "$500.01 routes to leadership",
  );
  assert(
    purchaseApprovalRoute(3000).authority === "Omeed, Drew or Jonathan",
    "$3,000 routes to leadership",
  );
  assert(
    purchaseApprovalRoute(3000.01).tier === "eran_3000",
    "over $3,000 routes to Eran",
  );
  let rejected = false;
  try {
    purchaseApprovalRoute(0);
  } catch {
    rejected = true;
  }
  assert(rejected, "non-positive amounts must be rejected");
});

Deno.test("supply order validation blocks placeholder request data", () => {
  const result = supplyOrderValidation({
    requesterIds: [50753431],
    department: "Marketing",
    vendor: "MerchPrinters",
    needBeforeDate: "2026-10-30",
    priority: "High - ASAP",
    lines: [{
      name: "Printed hoodie",
      linkUrl: "https://na.com",
      unitCost: 16,
      quantity: 200,
      sku: "na",
      department: "Marketing",
      expenseCategory: "Creative Production",
      expenseSubcategory: null,
      chartOfAccounts: null,
    }],
  });
  assert(!result.complete, "placeholder data should require correction");
  assert(result.total === 3200, "valid cost and quantity still total");
  assert(
    result.missing.includes("Item 1: purchase link"),
    "placeholder purchase link is missing",
  );
  assert(result.missing.includes("Item 1: SKU"), "placeholder SKU is missing");
  assert(
    result.missing.includes("Item 1: expense sub-category"),
    "sub-category is required",
  );
  assert(
    result.missing.includes("Item 1: chart of accounts"),
    "COA is required",
  );
});

Deno.test("supply order routing returns monday users by threshold", () => {
  assert(
    supplyOrderApprovalRoute(500).mondayUserIds.join(",") === "98722698",
    "Eric gets the under-$500 approval",
  );
  assert(
    supplyOrderApprovalRoute(500.01).mondayUserIds.join(",") ===
      "50261465,49938939,50344762",
    "leadership users get the middle tier",
  );
  assert(
    supplyOrderApprovalRoute(3000.01).mondayUserIds.join(",") === "50263474",
    "Eran gets the over-$3000 tier",
  );
});

Deno.test("order transitions are adjacent and terminal", () => {
  const allowed = [
    ["awaiting_owner_approval", "ordered"],
    ["awaiting_owner_approval", "declined"],
    ["ordered", "approved"],
    ["ordered", "canceled"],
    ["approved", "processed"],
    ["approved", "canceled"],
    ["processed", "delivered"],
  ];
  for (const [from, to] of allowed) {
    assert(
      orderTransitionAllowed(from, to),
      `${from} -> ${to} should be allowed`,
    );
  }
  for (
    const [from, to] of [["ordered", "delivered"], ["delivered", "canceled"], [
      "processed",
      "approved",
    ], ["canceled", "ordered"]]
  ) {
    assert(
      !orderTransitionAllowed(from, to),
      `${from} -> ${to} should be denied`,
    );
  }
});

Deno.test("Monday status mapping is exact and rejects negated or failed labels", () => {
  assert(mondayOrderState("Delivered") === "delivered", "Delivered maps");
  assert(mondayOrderState("READY_FOR_DELIVERY") === "processed", "Ready maps");
  assert(mondayOrderState("Approved") === "approved", "Approved maps");
  assert(
    mondayOrderState("Delivery failed") === null,
    "Failure must not deliver",
  );
  assert(
    mondayOrderState("Not approved") === null,
    "Negation must not approve",
  );
  assert(
    mondayOrderState("Processing error") === null,
    "Error must not process",
  );
});

Deno.test("Canix catalog IDs have one canonical representation", () => {
  assert(
    canonicalCanixProductId("canix:item:42") === "canix:item:42",
    "Canonical ID remains stable",
  );
  assert(
    canonicalCanixProductId("canix:item:00042") === "canix:item:42",
    "Zero-padded aliases normalize",
  );
  assert(canonicalCanixProductId("canix:item:0") === null, "Zero is invalid");
  assert(
    canonicalCanixProductId("canix:item:42:extra") === null,
    "Suffixes are invalid",
  );
});

Deno.test("external assets require an exact approved HTTPS host", () => {
  const hosts = new Set(["assets.example.com"]);
  assert(
    approvedHttpsUrl("https://assets.example.com/coa.pdf?sig=1", hosts)
      ?.startsWith("https://assets.example.com/coa.pdf"),
    "approved host should pass",
  );
  assert(
    approvedHttpsUrl("https://assets.example.com:443/coa.pdf", hosts) !== null,
    "default HTTPS port should pass",
  );
  assert(
    approvedHttpsUrl("https://evil-assets.example.com/coa.pdf", hosts) === null,
    "deceptive suffix should fail",
  );
  assert(
    approvedHttpsUrl("https://assets.example.com.evil.test/coa.pdf", hosts) ===
      null,
    "deceptive parent should fail",
  );
  assert(
    approvedHttpsUrl("https://user@assets.example.com/coa.pdf", hosts) === null,
    "userinfo should fail",
  );
  assert(
    approvedHttpsUrl("https://assets.example.com:8443/coa.pdf", hosts) === null,
    "unexpected port should fail",
  );
  assert(
    approvedHttpsUrl("http://assets.example.com/coa.pdf", hosts) === null,
    "HTTP should fail",
  );
});

function testBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

async function testJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = testBase64Url(encoder.encode(JSON.stringify({
    alg: "HS256",
    typ: "JWT",
  })));
  const body = testBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${header}.${body}`),
    ),
  );
  return `${header}.${body}.${testBase64Url(signature)}`;
}

Deno.test("Monday webhook JWTs require a valid HS256 signature and expiry", async () => {
  const now = 2_000_000_000;
  const secret = "test-signing-secret-value";
  const valid = await testJwt(
    { accountId: 915991, iat: now - 10, exp: now + 300 },
    secret,
  );
  const claims = await verifyHs256Jwt(valid, secret, now);
  assert(claims?.accountId === 915991, "valid signature should return claims");
  assert(
    await verifyHs256Jwt(valid, "different-signing-secret", now) === null,
    "wrong secret should fail",
  );
  const expired = await testJwt(
    { accountId: 915991, iat: now - 600, exp: now - 60 },
    secret,
  );
  assert(
    await verifyHs256Jwt(expired, secret, now) === null,
    "expired token should fail",
  );
  const unsupported = valid.replace(
    /^[-_A-Za-z0-9]+/,
    testBase64Url(
      new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "JWT" })),
    ),
  );
  assert(
    await verifyHs256Jwt(unsupported, secret, now) === null,
    "unsupported algorithm should fail",
  );
});
