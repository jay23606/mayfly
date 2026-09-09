create or replace function public.mf_claim_push_subscription(push_endpoint text, push_p256dh text, push_auth text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if length(push_endpoint) < 24 or length(push_p256dh) < 16 or length(push_auth) < 8 then raise exception 'invalid push subscription'; end if;
  insert into public.mf_push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
  values (auth.uid(), push_endpoint, push_p256dh, push_auth, now())
  on conflict (endpoint) do update set user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,created_at=now();
end;
$$;
revoke all on function public.mf_claim_push_subscription(text,text,text) from public, anon;
grant execute on function public.mf_claim_push_subscription(text,text,text) to authenticated;

create or replace function public.mf_release_push_subscription(push_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.mf_push_subscriptions where user_id=auth.uid() and endpoint=push_endpoint;
$$;
revoke all on function public.mf_release_push_subscription(text) from public, anon;
grant execute on function public.mf_release_push_subscription(text) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='mf_user_activity') then
    alter publication supabase_realtime add table public.mf_user_activity;
  end if;
end $$;

-- Preserve the existing secret-bearing webhook definition while increasing its
-- cold-start allowance. Reading/replacing server-side avoids putting the shared
-- webhook secret in source control.
do $$ declare fn text;
begin
  if to_regprocedure('private.mf_notify_webhook()') is not null then
    select pg_get_functiondef('private.mf_notify_webhook()'::regprocedure) into fn;
    fn := replace(fn, 'timeout_milliseconds := 1000', 'timeout_milliseconds := 8000');
    execute fn;
  end if;
end $$;
