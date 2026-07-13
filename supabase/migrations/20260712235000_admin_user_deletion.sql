-- Mayfly admin account removal. The immutable caller ID belongs to ihvnolegs.
create or replace function public.mf_admin_delete_user(target_id uuid)
returns void language plpgsql security definer set search_path = public, auth, storage, pg_temp as $$
declare
  admin_id constant uuid := '2f43626a-3056-402d-9daf-b0de5193a2f8';
begin
  if auth.uid() <> admin_id then raise exception 'Not authorized'; end if;
  if target_id is null or target_id = admin_id then raise exception 'The administrator account cannot be removed here'; end if;
  if not exists (select 1 from public.mf_profiles where id = target_id) then raise exception 'Mayfly user not found'; end if;

  delete from storage.objects
  where bucket_id = 'mf-snaps'
    and name in (select id::text from public.mf_snaps where sender_id = target_id or recipient_id = target_id);

  delete from auth.users where id = target_id;
end;
$$;
revoke all on function public.mf_admin_delete_user(uuid) from public;
grant execute on function public.mf_admin_delete_user(uuid) to authenticated;
