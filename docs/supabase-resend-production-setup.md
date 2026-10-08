# Supabase and Resend production setup

This is the production setup checklist for the UX OS portal. Do not store live
secret values in the repository.

## Supabase Edge Function gateway policy

`supabase/config.toml` is the source of truth for function JWT behavior.

- Public, webhook, cron, or opaque-link functions set `verify_jwt = false` and
  authenticate inside the handler.
- Signed-in portal functions set `verify_jwt = true` and still re-check portal
  profile, organization, workspace, role, and permission scope inside the
  handler.
- Keep every deployed function listed explicitly so production behavior does not
  depend on defaults.

## Required Supabase secrets

Set these as Supabase Edge Function secrets in the production project:

```bash
supabase secrets set RESEND_API_KEY="<resend_api_key>"
supabase secrets set RESEND_WEBHOOK_SECRET="<resend_webhook_secret>"
supabase secrets set PORTAL_EMAIL_FROM="urbanXtracts Portal <portal@updates.urbanxtracts.com>"
```

The Resend API key should begin with `re_`. The webhook signing secret should
begin with `whsec_`. Release readiness treats the sender as incomplete until
both are present.

## Resend domain and webhook

In Resend:

1. Verify the sending subdomain, recommended `updates.urbanxtracts.com`.
2. Publish the SPF and DKIM DNS records Resend provides.
3. Create a webhook for:
   `https://cbhsavfbtcpdyxcvguay.supabase.co/functions/v1/portal-notifications?webhook=resend`
4. Subscribe to delivery, bounce, complaint, suppression, failed, and delayed
   email events.
5. Store the webhook signing secret in Supabase as `RESEND_WEBHOOK_SECRET`.

## Notification controls

UX OS uses the durable notification outbox before contacting Resend. The outbox
ID is the provider idempotency key. Resend delivery events update the same
outbox row as sent, delivered, bounced, or failed.

The no-cost sender policy is enforced in the database:

- 100 email messages per UTC day
- 3,000 email messages per UTC month
- messages above the cap are held instead of sent

## Verification

Before enabling outbound email for users:

1. Confirm Release Readiness shows the notification sender as configured.
2. Send one approved internal test template from Communications.
3. Confirm the outbox row moves to `sent`.
4. Confirm a signed Resend delivery webhook updates the row to `delivered`.
5. Confirm an invalid webhook signature is rejected.
6. Confirm messages are held if the API key or webhook secret is removed.
