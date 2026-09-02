# Intuit production assessment handoff

Prepared 2 September 2026 for `urbanXtracts UX OS Portal`.

This document separates implementation evidence from company attestations. It is not authorization to submit the assessment. An urbanXtracts representative who is authorized to answer for the company must review the marked items and submit them in Intuit.

## Application facts

| Assessment topic | Supported answer | Evidence / qualification |
| --- | --- | --- |
| Build method | Built from scratch | The portal and connector are maintained in the UX-Portal repository; no integration platform holds the Intuit credentials. |
| Platforms | Web/SaaS and Web/Browser | Users access `portal.urbanxtracts.com`; all Intuit calls occur in server-side Supabase functions. |
| QuickBooks interaction | Reads | The connector issues query `GET` requests for Customer, Invoice, and Payment only. It has no create, update, delete, invoice-generation, payment, or bank-data route. |
| Distribution | Private app | The connection is for URBANXTRACTS INC and the portal is access-gated. It is not an App Store marketplace product. |
| QuickBooks authorization | One company administrator authorizes the server connection | Portal users never receive Intuit tokens and do not sign in to QuickBooks through the portal. |
| Other integrations | Yes | Canix, Monday.com, Supabase, Google Workspace SSO, Turnstile, and the portal host are separate connected systems. |
| Generative AI | No in the production portal | UX OS does not send QuickBooks data to a generative-AI API and does not expose an AI feature to portal users. The company representative must confirm this remains true for the submitted app. |

## OAuth and authentication

| Assessment topic | Supported answer | Evidence / qualification |
| --- | --- | --- |
| Connect/disconnect/reconnect tested in sandbox | Not yet | Leave unanswered or answer No until the recorded sandbox verification below is complete. |
| Refresh-token frequency | Before each scheduled or administrator-started sync | The target sync interval is five minutes. Intuit's rotated refresh token is encrypted and saved before Accounting API reads begin. |
| Failed authentication retries | No automatic replay of token POSTs | Authorization codes and refresh tokens are one-time or rotating material. A failed exchange is recorded and the administrator is directed to reconnect. Read-only Accounting GET requests retry transient failures at most three times. |
| Customer reconnect prompt on auth error | Yes | Expired/invalid connection state is shown as disconnected/error and Release readiness offers Connect/Reconnect QuickBooks. |
| Intuit discovery document | Yes | Both authorization and bearer-token endpoints are resolved from Intuit's production discovery document. HTTPS, issuer, and exact endpoint hosts are validated before use. |
| Expired access token | Yes | A new access token is obtained before every sync; access tokens are never browser-visible or persisted in the portal database. |
| Expired refresh token / invalid grant | Yes | The connector records an error, preserves the last complete financial snapshot, and requires administrator reconnection. |
| CSRF | Yes | OAuth state uses 32 random bytes, is stored only as a SHA-256 hash, expires after ten minutes, and is consumed atomically once. |
| OAuth Playground / offline token tool | No | Production authorization starts only from the permission-gated portal flow. |

## API usage and error handling

| Assessment topic | Supported answer | Evidence / qualification |
| --- | --- | --- |
| Accounting API categories | Customers, invoices, and payments | Each sync queries Customer, Invoice, and Payment, with pages of at most 1,000 records. |
| Frequency | Every five minutes for one connected company after production authorization | The Vault-gated scheduler remains off, without issuing failed calls, until its matching Edge Function and database credentials are ready. |
| Syntax and validation errors tested | Not yet | Complete the sandbox checklist before changing this answer to Yes. |
| `intuit_tid` captured | Yes | OAuth and Accounting failures sanitize and retain the response header in server-only sync state and internal Release readiness. A later success clears it. |
| Error detail retained for support | Yes, with data minimization | The connector retains a bounded error message and `intuit_tid`. It deliberately excludes raw response bodies, access tokens, refresh tokens, bank data, and full accounting payloads. |
| Customer support path | Needs company contact | The UI gives blocked users a recovery path, but urbanXtracts should designate the monitored support email/route before the assessment is submitted. Do not invent an address. |

## Security facts

| Assessment topic | Supported answer | Evidence / qualification |
| --- | --- | --- |
| Client ID and secret stored securely | Yes | Secrets are held in Supabase Edge Function secrets; the browser bundle contains no QuickBooks client secret or Intuit token. Refresh tokens are encrypted with an Edge-only key. |
| Least data retained | Yes | The cache stores normalized customer, invoice summary, and payment summary fields. It excludes invoice line items, bank/deposit accounts, card/check details, tax IDs, and raw Invoice/Payment payloads. |
| Access control | Yes | Financial rows are re-scoped on each request. Internal access requires `financials.read`; Owners see their organization; Buyers see directly assigned stores; Budtenders, Quality, and Viewer receive no financial access. |
| MFA | No in the current production portal | Google Workspace may enforce MFA for employee SSO accounts, but the portal does not yet enroll, challenge, verify, or require a second factor for all users. Retailer email/password accounts currently authenticate at assurance level 1. Change the assessment answer to Yes only after MFA is enforced and tested across every applicable sign-in path. |
| CAPTCHA for authentication | No | Cloudflare Turnstile protects public retailer onboarding, not the login flow. Authentication is handled by Supabase and Google Workspace SSO. |
| WebSocket use | No | The QuickBooks connector uses HTTPS request/response APIs only. |
| Intuit data visible beyond the connected customer | Company review required | Data belongs to URBANXTRACTS INC's connected company and is displayed to authorized urbanXtracts staff and scoped retailer Owner/Buyer accounts. The authorized representative should confirm Intuit's intended interpretation before answering. |

## Company-supplied questionnaire answers (2026-09-02)

These responses were supplied by urbanXtracts. Engineering evidence supports the technical answers noted below, but the company representative remains responsible for the organizational attestations and final submission.

| Question | Current answer | Qualification |
| --- | --- | --- |
| Prior breach requiring customer or government notification | No | Company-supplied organizational attestation; Engineering cannot independently verify company history. |
| Security team regularly assesses application vulnerabilities and risks | Yes | Company-supplied organizational attestation. Retain evidence of the recurring review cadence and remediation process. |
| Client ID and client secret stored securely | Yes | Supported by the server-only Supabase secret and encrypted-token design. |
| Application uses multi-factor authentication | No | The screenshot selected Yes, but that would overstate the current implementation. Change to Yes only after the portal enforces and verifies MFA for all applicable employee and retailer sign-in paths. |
| CAPTCHA used for authentication | No | Correct for the current design. Turnstile protects public onboarding, not authentication. |
| Application uses WebSocket | No | Supported by the implementation; the connector uses HTTPS request/response APIs. |
| Intuit data used by or shown to anyone other than the original customer | Provisional: No | The selected answer requires authorized-representative review because scoped QuickBooks-derived data is shown to retailer Owners and Buyers. Confirm Intuit treats this as use solely for URBANXTRACTS INC's benefit before submitting No. |

## Authorized-representative answers

Engineering cannot answer or submit these on behalf of urbanXtracts:

- Regulatory complaints, lawsuits, or government investigative requests.
- Whether legal counsel has reviewed applicable regulatory and user-data obligations.
- Confirmation that the company accepts and complies with Intuit's current security policies.
- Sanctions and embargo attestations.

The breach-history and security-team responses above remain company attestations even though the answers have now been recorded.

## Required sandbox evidence

Before submission, use an Intuit sandbox company and record the date and tester for each result:

1. Connect from Release readiness and confirm the callback stores the realm without exposing a token.
2. Run a complete Customer, Invoice, and Payment sync and verify a new complete snapshot.
3. Disconnect in Intuit, confirm UX OS shows the connection error and the prior snapshot remains readable, then reconnect.
4. Trigger or simulate an expired/invalid refresh token and confirm the reconnect path.
5. Trigger a safe validation error, record the `intuit_tid`, and confirm raw Intuit response data is not persisted.
6. Trigger a transient read failure and confirm no more than three GET attempts occur.
7. Verify that a Budtender and Viewer receive no financial data; verify Owner and Buyer store scoping.
8. Confirm there is no QuickBooks write, payment, delete, or invoice-creation control anywhere in the portal.

## Production hosting

The static-egress deployment is complete. Intuit traffic is routed through `qbo-egress.urbanxtracts.com` at the reserved United States IP `34.45.103.119`. The full infrastructure, security, verification, and billing-alert record is maintained in [QuickBooks US static-egress deployment](qbo-static-egress-deployment.md). The hosting details have not been submitted to Intuit.
