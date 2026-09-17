-- Large relay media is encrypted and uploaded one bounded chunk at a time so a
-- phone never has to hold both the entire plaintext and ciphertext in memory.
alter table public.mf_relay_payloads
  add column if not exists encryption_format text not null default 'aes-gcm-v1',
  add column if not exists chunk_size integer,
  add column if not exists plaintext_size bigint;

alter table public.mf_relay_payloads
  drop constraint if exists mf_relay_payloads_encryption_format_check,
  add constraint mf_relay_payloads_encryption_format_check
    check (encryption_format in ('aes-gcm-v1', 'aes-gcm-chunks-v1')),
  drop constraint if exists mf_relay_payloads_chunk_metadata_check,
  add constraint mf_relay_payloads_chunk_metadata_check check (
    (encryption_format = 'aes-gcm-v1' and chunk_size is null and plaintext_size is null)
    or
    (encryption_format = 'aes-gcm-chunks-v1' and chunk_size between 1 and 6291456 and plaintext_size >= 0)
  );
