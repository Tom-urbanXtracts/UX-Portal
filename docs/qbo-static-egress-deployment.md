# QuickBooks US static-egress deployment

The production Intuit connection needs one truthful, stable US public IP. The recommended deployment is a dedicated Google Compute Engine `e2-micro` VM in `us-central1`, separate from the portal host and every unrelated workload. Google currently includes one eligible non-preemptible `e2-micro`, 30 GB of standard persistent disk, and 1 GB of North American outbound transfer in its Free Tier, subject to account eligibility and changing limits. Keep a billing alert and a hard operational budget even when usage is expected to remain inside that tier.

Nothing in this document authorizes resource creation, billing, DNS changes, or Intuit submission.

## Trust boundary

```text
Supabase QuickBooks functions
  -> HTTPS + shared secret
  -> qbo-egress.urbanxtracts.com
  -> loopback-only Node proxy on one US VM
  -> exact Intuit discovery, OAuth token, or company-query endpoint
```

The proxy cannot receive a destination URL. It recognizes only:

- `GET /v1/discovery`
- `POST /v1/token`
- `GET /v1/accounting/{realm}/query?minorversion=...&query=...`
- `GET /healthz`

Every Intuit route requires the Edge-only `x-ux-egress-secret`. The service validates request method, content type, realm format, query keys and size; applies a per-process rate limit; requires HTTPS from the reverse proxy; follows no redirects; and forwards only safe response headers. It never logs request headers, tokens, query text, or response bodies.

## Provisioning checklist

1. Confirm the Google Cloud project, billing account, and a monthly spend cap.
2. Reserve one regional external IPv4 address in `us-central1`.
3. Create a minimal current Ubuntu LTS `e2-micro` VM with a standard persistent disk, Shielded VM features, OS Login, automatic security updates, and no project-wide SSH keys.
4. Apply a VPC firewall that exposes TCP 80/443 publicly for certificate issuance and HTTPS. Restrict TCP 22 to the administrator's current trusted source or use Identity-Aware Proxy; never expose the Node port 8788.
5. Create the unprivileged system account `ux-qbo-egress` with no login shell or home directory.
6. Install a supported Node.js LTS and Caddy from their signed vendor repositories.
7. Copy `server.mjs` to `/opt/ux-qbo-egress/server.mjs`, owned by root and not writable by the service account.
8. Generate a distinct 256-bit proxy secret. Store it in `/etc/ux-qbo-egress.env` as `QBO_EGRESS_SHARED_SECRET`, owned by root with mode 0600. Store the same value as Supabase Edge secret `QBO_EGRESS_PROXY_SECRET`; never place it in Git, shell history, cloud-init metadata, or Intuit.
9. Install the example systemd unit, run the service on loopback, and confirm `/healthz` locally.
10. Point the Wix-managed `qbo-egress.urbanxtracts.com` A record to the reserved IP. Install the example Caddy configuration and wait for a valid public certificate.
11. Confirm unauthenticated proxy routes return 403, arbitrary paths return 400, the health route returns 200, and `intuit_tid` is preserved during a controlled error.
12. Set `QBO_EGRESS_PROXY_URL=https://qbo-egress.urbanxtracts.com` in Supabase. Deploy the QuickBooks functions and confirm direct calls cease.
13. Enter the VM's reserved US IP and hosting country in Intuit's production settings only after verifying the actual address from the running service.
14. Enable Google Cloud billing alerts, uptime monitoring, unattended security updates, and a monthly patch/restart window. Document the operational owner.

## Verification and rollback

- Run the proxy unit tests with `node --test services/qbo-egress-proxy/server.test.mjs`.
- Complete the Intuit sandbox connect, disconnect, reconnect, expired-token, validation-error, and read-only access tests.
- Confirm the five-minute scheduler produces complete atomic snapshots and Release readiness reports the new sync age.
- To roll back before production authorization, remove both Supabase egress variables together; the connector returns to its direct development route. Do not remove only one variable because partial configuration deliberately fails closed.
- After production approval, do not bypass the declared static IP without updating and revalidating Intuit's hosting information.
