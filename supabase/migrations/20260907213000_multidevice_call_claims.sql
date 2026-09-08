-- One device may answer a broadcast call offer. The first successful insert wins.
create table if not exists public.mf_call_claims (
  call_id text primary key,
  callee_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.mf_devices(id) on delete cascade,
  claimed_at timestamptz not null default now()
);
alter table public.mf_call_claims enable row level security;

create or replace function public.mf_claim_call(call_id text, device_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.mf_devices where id = device_id and user_id = auth.uid() and revoked_at is null
  ) then return false; end if;
  insert into public.mf_call_claims (call_id, callee_id, device_id)
  values (call_id, auth.uid(), device_id)
  on conflict (call_id) do nothing;
  return found;
end;
$$;
revoke all on function public.mf_claim_call(text, uuid) from public;
grant execute on function public.mf_claim_call(text, uuid) to authenticated;
