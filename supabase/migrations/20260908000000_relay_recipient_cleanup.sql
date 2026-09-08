-- The final recipient/device to claim a shared encrypted Snap can delete its
-- ciphertext immediately. Fan-out media stays available while any linked Snap
-- remains unopened; abandoned payloads retain the existing seven-day expiry.
create or replace function public.mf_can_cleanup_relay(target_relay uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.mf_snaps mine
    where mine.relay_id = target_relay and mine.recipient_id = auth.uid()
  ) and not exists (
    select 1 from public.mf_snaps pending
    where pending.relay_id = target_relay and pending.viewed_at is null
  );
$$;
revoke all on function public.mf_can_cleanup_relay(uuid) from public;
grant execute on function public.mf_can_cleanup_relay(uuid) to authenticated;

drop policy if exists "mf_relay_payloads_recipient_delete" on public.mf_relay_payloads;
create policy "mf_relay_payloads_recipient_delete" on public.mf_relay_payloads for delete using (
  public.mf_can_cleanup_relay(id)
);

drop policy if exists "mf_snaps_obj_delete" on storage.objects;
create policy "mf_snaps_obj_delete" on storage.objects for delete to authenticated using (
  bucket_id = 'mf-snaps' and (
    exists (
      select 1 from public.mf_relay_payloads p
      where p.id::text = name and (
        p.sender_id = auth.uid()
        or public.mf_can_cleanup_relay(p.id)
      )
    )
    or exists (
      select 1 from public.mf_snaps s
      where s.id::text = name and s.relay_id is null and s.delivery like 'relay%'
        and (s.sender_id = auth.uid() or s.recipient_id = auth.uid())
    )
  )
);
