-- Production migration version: 20261008161710.
create or replace function public.portal_apply_notification_suppression()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare hold_reason text;
begin
  if new.state = 'pending' then
    select s.reason into hold_reason
    from public.portal_notification_suppression s
    where s.recipient_email = lower(btrim(new.recipient_email))
      and s.active;
    if hold_reason is not null then
      new.state := 'held_policy';
      new.last_error := 'Delivery held by notification policy: ' || hold_reason;
      new.updated_at := now();
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.portal_apply_notification_suppression()
  from public, anon, authenticated;
grant execute on function public.portal_apply_notification_suppression()
  to service_role;

drop trigger if exists portal_notification_suppression_gate
  on public.portal_notification_outbox;
create trigger portal_notification_suppression_gate
before insert or update of recipient_email, state
on public.portal_notification_outbox
for each row execute function public.portal_apply_notification_suppression();

comment on function public.portal_apply_notification_suppression() is
  'Fails closed before delivery by converting pending mail for an active suppressed recipient into retained held_policy evidence.';
