-- Public profiles intentionally expose only an accepted-friend total, never a friend list.
create or replace function public.mf_public_friend_count(profile_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from public.mf_friends
  where status = 'accepted'
    and (requester_id = profile_id or addressee_id = profile_id);
$$;

grant execute on function public.mf_public_friend_count(uuid) to anon, authenticated;
