-- mf_claim_call threw 42702 ("column reference call_id is ambiguous") on every
-- single answer: `on conflict (call_id)` resolves its arbiter against the target
-- table, so the parameter of the same name collided with the column. The client
-- saw an RPC error and reported "This call was answered on another device" —
-- no claim row was ever written. Qualify the parameters and name the arbiter
-- constraint instead of the column.
create or replace function public.mf_claim_call(call_id text, device_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (
    select 1 from public.mf_devices d
    where d.id = mf_claim_call.device_id and d.user_id = v_uid and d.revoked_at is null
  ) then return false; end if;
  -- Claims are only meaningful for the lifetime of a ring, so drop stale ones
  -- rather than growing the table forever. Runs before the insert that sets FOUND.
  delete from public.mf_call_claims where claimed_at < now() - interval '6 hours';
  insert into public.mf_call_claims (call_id, callee_id, device_id)
  values (mf_claim_call.call_id, v_uid, mf_claim_call.device_id)
  on conflict on constraint mf_call_claims_pkey do nothing;
  return found;
end;
$$;
revoke all on function public.mf_claim_call(text, uuid) from public, anon;
grant execute on function public.mf_claim_call(text, uuid) to authenticated;
