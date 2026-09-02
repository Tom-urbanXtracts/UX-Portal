import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createIntuitEgressHandler } from "./server.mjs";

const SECRET = "a".repeat(64);

async function withProxy(fetchImpl, run) {
  const server = createServer(createIntuitEgressHandler({
    secret: SECRET,
    fetchImpl,
    requireForwardedHttps: false,
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

test("rejects unauthenticated and arbitrary destinations", async () => {
  await withProxy(async () => {
    throw new Error("must not fetch");
  }, async (base) => {
    assert.equal((await fetch(`${base}/v1/discovery`)).status, 403);
    assert.equal(
      (await fetch(`${base}/https://example.com`, {
        headers: { "x-ux-egress-secret": SECRET },
      })).status,
      400,
    );
  });
});

test("forwards only the fixed discovery document and support ID", async () => {
  let requested = "";
  await withProxy(async (url) => {
    requested = url;
    return new Response('{"issuer":"intuit"}', {
      status: 503,
      headers: {
        "content-type": "application/json",
        "intuit_tid": "trace-123",
        "set-cookie": "must-not-forward=1",
      },
    });
  }, async (base) => {
    const response = await fetch(`${base}/v1/discovery`, {
      headers: { "x-ux-egress-secret": SECRET },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("intuit_tid"), "trace-123");
    assert.equal(response.headers.get("set-cookie"), null);
  });
  assert.equal(
    requested,
    "https://developer.api.intuit.com/.well-known/openid_configuration",
  );
});

test("validates and forwards one Accounting query", async () => {
  let request = null;
  await withProxy(async (url, init) => {
    request = { url, authorization: init.headers.get("authorization") };
    return Response.json({ QueryResponse: { Customer: [] } });
  }, async (base) => {
    const query = encodeURIComponent(
      "select * from Customer startposition 1 maxresults 1000",
    );
    const response = await fetch(
      `${base}/v1/accounting/123456/query?minorversion=75&query=${query}`,
      {
        headers: {
          "x-ux-egress-secret": SECRET,
          authorization: "Bearer access-token",
        },
      },
    );
    assert.equal(response.status, 200);
  });
  assert.equal(request.authorization, "Bearer access-token");
  assert.match(
    request.url,
    /^https:\/\/quickbooks\.api\.intuit\.com\/v3\/company\/123456\/query\?/,
  );
  assert.match(request.url, /minorversion=75/);
});

test("rejects token requests without the expected content type", async () => {
  await withProxy(async () => {
    throw new Error("must not fetch");
  }, async (base) => {
    const response = await fetch(`${base}/v1/token`, {
      method: "POST",
      headers: {
        "x-ux-egress-secret": SECRET,
        authorization: "Basic credentials",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 400);
  });
});
