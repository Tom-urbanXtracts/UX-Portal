import {
  approvedHttpsUrl,
  canonicalCanixProductId,
  labFailed,
  labPassed,
  mondayOrderState,
  orderTransitionAllowed,
} from "../functions/_shared/security-contract.ts";

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
