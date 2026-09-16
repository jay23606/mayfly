-- Consuming a relayed voice clip/file on one device consumes the logical item for
-- the recipient account. Old or inactive device envelopes must not hold a queue
-- slot after the recipient has successfully decrypted and saved the content.
create or replace function public.mf_complete_transfer(delivery_id uuid, device_id uuid)
returns boolean language plpgsql security definer set search_path = public, storage as $$
declare
  target public.mf_transfer_deliveries;
  remaining bigint;
begin
  select * into target from public.mf_transfer_deliveries d
  where d.id = mf_complete_transfer.delivery_id and d.recipient_id = auth.uid()
    and (d.recipient_device_id is null or d.recipient_device_id = mf_complete_transfer.device_id);
  if not found then return false; end if;

  perform pg_advisory_xact_lock(hashtextextended(target.logical_id::text || ':' || target.recipient_id::text, 0));

  -- Recheck after acquiring the logical-item lock; another device may have won.
  select * into target from public.mf_transfer_deliveries d
  where d.id = mf_complete_transfer.delivery_id and d.recipient_id = auth.uid()
    and (d.recipient_device_id is null or d.recipient_device_id = mf_complete_transfer.device_id)
  for update;
  if not found then return true; end if;
  if target.recipient_device_id is not null and not exists (
    select 1 from public.mf_devices d where d.id = mf_complete_transfer.device_id
      and d.user_id = auth.uid() and d.revoked_at is null
  ) then return false; end if;

  delete from public.mf_transfer_deliveries
  where logical_id = target.logical_id and recipient_id = target.recipient_id;

  select count(*) into remaining from public.mf_transfer_deliveries where relay_id = target.relay_id;
  if remaining = 0 then
    delete from storage.objects where bucket_id = 'mf-snaps' and name = target.relay_id::text;
    delete from public.mf_relay_payloads where id = target.relay_id;
  end if;
  return true;
end;
$$;
revoke all on function public.mf_complete_transfer(uuid, uuid) from public, anon;
grant execute on function public.mf_complete_transfer(uuid, uuid) to authenticated;
