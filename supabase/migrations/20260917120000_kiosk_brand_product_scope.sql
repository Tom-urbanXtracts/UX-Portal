-- Brand-selected kiosk links retain the chosen brand as well as the selected
-- Canix Item IDs. Existing links remain unrestricted by brand.

alter table public.portal_kiosk_link
  add column if not exists allowed_brand_name text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portal_kiosk_link'::regclass
      and conname = 'portal_kiosk_link_brand_length_check'
  ) then
    alter table public.portal_kiosk_link
      add constraint portal_kiosk_link_brand_length_check
      check (allowed_brand_name is null or length(allowed_brand_name) between 1 and 200);
  end if;
end
$$;

comment on column public.portal_kiosk_link.allowed_brand_name is
  'Canix market Brand selected for a public kiosk link; economic ownership is never inferred from it.';
