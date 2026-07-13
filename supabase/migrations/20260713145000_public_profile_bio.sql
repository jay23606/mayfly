alter table public.mf_profiles add column if not exists bio text not null default '';
alter table public.mf_profiles drop constraint if exists mf_profiles_bio_length;
alter table public.mf_profiles add constraint mf_profiles_bio_length check (char_length(bio) <= 200);
