-- Production migration version: 20261008161122.
create table if not exists public.portal_notification_suppression (
  recipient_email text primary key
    check (recipient_email = lower(btrim(recipient_email)) and position('@' in recipient_email) > 1),
  reason text not null check (length(btrim(reason)) >= 8),
  suppression_type text not null default 'test_account'
    check (suppression_type in ('test_account','hard_bounce','manual_hold')),
  active boolean not null default true,
  created_by uuid references public.portal_profile(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.portal_notification_suppression enable row level security;
revoke all on table public.portal_notification_suppression from public, anon, authenticated;
grant all on table public.portal_notification_suppression to service_role;

insert into public.portal_notification_suppression (
  recipient_email, reason, suppression_type
) values
  ('marketing@urbanxtract.com', 'Demo Brand login; the urbanxtract.com address is not a production mailbox.', 'test_account'),
  ('brands@urbanxtracts.com', 'Brand Role Test login retained for role demonstrations; no production mailbox.', 'test_account'),
  ('internal@urbanxtracts.com', 'Internal Administrator Role Test login retained for role demonstrations; no production mailbox.', 'test_account')
on conflict (recipient_email) do update set
  reason = excluded.reason,
  suppression_type = excluded.suppression_type,
  active = true,
  updated_at = now();

comment on table public.portal_notification_suppression is
  'Server-only delivery holds for test identities, confirmed hard bounces, and manually held addresses. Messages remain in the durable outbox as held_policy evidence.';
