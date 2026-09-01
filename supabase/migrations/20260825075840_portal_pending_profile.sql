create table if not exists public.portal_pending_profile (
  email text primary key check (
    email = lower(email)
    and position('@' in email) > 1
  ),
  full_name text not null,
  org text not null,
  role text not null check (role in ('owner', 'buyer', 'budtender', 'internal')),
  locations text,
  added_by text,
  created_at timestamptz not null default now()
);

alter table public.portal_pending_profile enable row level security;

grant select, insert, delete on table public.portal_pending_profile to authenticated;
grant all on table public.portal_pending_profile to service_role;

create policy pending_select
on public.portal_pending_profile
for select
to authenticated
using (
  public.portal_role() = 'internal'
  or (public.portal_role() = 'owner' and org = public.portal_org())
);

create policy pending_insert
on public.portal_pending_profile
for insert
to authenticated
with check (
  public.portal_role() = 'internal'
  or (
    public.portal_role() = 'owner'
    and org = public.portal_org()
    and role <> 'internal'
  )
);

create policy pending_delete
on public.portal_pending_profile
for delete
to authenticated
using (
  public.portal_role() = 'internal'
  or (public.portal_role() = 'owner' and org = public.portal_org())
);

