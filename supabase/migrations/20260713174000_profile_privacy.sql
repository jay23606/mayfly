alter table public.mf_profiles add column if not exists profile_private boolean not null default false;
alter table public.mf_profiles add column if not exists privacy_locked boolean not null default false;

-- Users may choose whether they appear in Add People, but only the administrator
-- can create or remove a lock on that choice.
create or replace function public.mf_enforce_profile_privacy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() = old.id then
    if new.privacy_locked is distinct from old.privacy_locked then
      raise exception 'only an administrator can change the privacy lock';
    end if;
    if old.privacy_locked and new.profile_private is distinct from old.profile_private then
      raise exception 'this profile privacy setting is locked by an administrator';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists mf_enforce_profile_privacy on public.mf_profiles;
create trigger mf_enforce_profile_privacy
before update on public.mf_profiles
for each row execute function public.mf_enforce_profile_privacy();

-- A forced-private person cannot create new friend requests, and no one can
-- request a private profile through a bypass of the client UI.
create or replace function public.mf_enforce_private_friend_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_forced_private boolean;
  recipient_private boolean;
begin
  select profile_private and privacy_locked into requester_forced_private
  from public.mf_profiles where id = new.requester_id;
  if coalesce(requester_forced_private, false) then
    raise exception 'private accounts locked by an administrator cannot add people';
  end if;

  select profile_private into recipient_private
  from public.mf_profiles where id = new.addressee_id;
  if coalesce(recipient_private, false) then
    raise exception 'this profile is private';
  end if;
  return new;
end;
$$;

drop trigger if exists mf_enforce_private_friend_request on public.mf_friends;
create trigger mf_enforce_private_friend_request
before insert on public.mf_friends
for each row execute function public.mf_enforce_private_friend_request();
