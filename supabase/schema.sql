-- VoiceVault: optional Supabase Postgres schema + Row Level Security policies.
--
-- STATUS: this file is delivered as SQL for you to run yourself in the Supabase SQL editor.
-- It has been reviewed for correctness but NOT executed against a live Supabase project --
-- this sandbox has no live Supabase credentials, so it is static verification only, not
-- end-to-end verification. Please run it against a staging project first.
--
-- WHAT THIS DOES: gives each signed-in user their own isolated set of recording metadata,
-- transcript segments, key moments and notes, enforced by Postgres Row Level Security so a
-- user can only ever see or change their own rows -- even if the anon key were exposed.
--
-- WHAT THIS DOES NOT DO: the app does not currently write to these tables. Today, recordings,
-- transcripts and notes live in the browser's own IndexedDB (per-device, not per-account), and
-- audio/video files live in Vercel Blob. Wiring the app's data layer to read/write these tables
-- instead is a separate, larger change -- see the note at the bottom of this file for why that
-- wasn't done blind in this same pass.

-- ============================================================================================
-- 1. profiles -- one row per auth user, created automatically on signup
-- ============================================================================================
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
-- no insert/delete policy: rows are created by the trigger below, not directly by clients.

-- Auto-create a profile row whenever a new Supabase Auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (new.id, new.raw_user_meta_data ->> 'name');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================================
-- 2. recordings -- one row per audio/video/text/web source (metadata only; the media itself
--    stays in Vercel Blob, addressed here by URL)
-- ============================================================================================
create table if not exists public.recordings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  title            text not null,
  type             text not null check (type in ('audio', 'video', 'text', 'web')),
  duration_sec     numeric,
  blob_url         text,
  language         text,
  context_prompt   text,
  transcript_status text not null default 'queued',
  favorite         boolean not null default false,
  last_position_sec numeric not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists recordings_user_id_idx on public.recordings(user_id);

alter table public.recordings enable row level security;

create policy "recordings: select own" on public.recordings
  for select using (auth.uid() = user_id);
create policy "recordings: insert own" on public.recordings
  for insert with check (auth.uid() = user_id);
create policy "recordings: update own" on public.recordings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "recordings: delete own" on public.recordings
  for delete using (auth.uid() = user_id);

-- ============================================================================================
-- 3. transcript_segments -- the shared { start, end, original, clean } structure used by both
--    audio and video, one row per segment
-- ============================================================================================
create table if not exists public.transcript_segments (
  id           uuid primary key default gen_random_uuid(),
  recording_id uuid not null references public.recordings(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  seg_index    integer not null,
  start_sec    numeric not null,
  end_sec      numeric not null,
  original     text not null,
  clean        text,
  created_at   timestamptz not null default now(),
  unique (recording_id, seg_index)
);

create index if not exists transcript_segments_recording_id_idx on public.transcript_segments(recording_id);
create index if not exists transcript_segments_user_id_idx on public.transcript_segments(user_id);

alter table public.transcript_segments enable row level security;

create policy "segments: select own" on public.transcript_segments
  for select using (auth.uid() = user_id);
create policy "segments: insert own" on public.transcript_segments
  for insert with check (auth.uid() = user_id);
create policy "segments: update own" on public.transcript_segments
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "segments: delete own" on public.transcript_segments
  for delete using (auth.uid() = user_id);

-- ============================================================================================
-- 4. key_moments -- starred transcript lines; shared structure for audio and video
-- ============================================================================================
create table if not exists public.key_moments (
  id           uuid primary key default gen_random_uuid(),
  recording_id uuid not null references public.recordings(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  start_sec    numeric not null,
  label        text not null,
  created_at   timestamptz not null default now()
);

create index if not exists key_moments_recording_id_idx on public.key_moments(recording_id);
create index if not exists key_moments_user_id_idx on public.key_moments(user_id);

alter table public.key_moments enable row level security;

create policy "key_moments: select own" on public.key_moments
  for select using (auth.uid() = user_id);
create policy "key_moments: insert own" on public.key_moments
  for insert with check (auth.uid() = user_id);
create policy "key_moments: delete own" on public.key_moments
  for delete using (auth.uid() = user_id);

-- ============================================================================================
-- 5. notes -- free-text notes attached to a recording
-- ============================================================================================
create table if not exists public.notes (
  id           uuid primary key default gen_random_uuid(),
  recording_id uuid references public.recordings(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text,
  body         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists notes_user_id_idx on public.notes(user_id);

alter table public.notes enable row level security;

create policy "notes: select own" on public.notes
  for select using (auth.uid() = user_id);
create policy "notes: insert own" on public.notes
  for insert with check (auth.uid() = user_id);
create policy "notes: update own" on public.notes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "notes: delete own" on public.notes
  for delete using (auth.uid() = user_id);

-- ============================================================================================
-- keep updated_at current on edit
-- ============================================================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists recordings_set_updated_at on public.recordings;
create trigger recordings_set_updated_at before update on public.recordings
  for each row execute function public.set_updated_at();

drop trigger if exists notes_set_updated_at on public.notes;
create trigger notes_set_updated_at before update on public.notes
  for each row execute function public.set_updated_at();

-- ============================================================================================
-- WHY THE APP DOESN'T CALL THIS YET
-- ============================================================================================
-- Every existing feature (recording, upload, transcription, search, Key Moments, Ask,
-- Original/Clean, exports) is built and heavily tested against the current local-storage
-- data layer (IndexedDB + localStorage). Rewiring that layer to read/write these tables
-- instead touches dozens of functions across the whole app, and with no live Supabase
-- project available in this environment, that rewiring could not be tested at all --
-- only guessed at. Shipping untested database-writing code is a worse outcome than not
-- shipping it. This schema is the real, reviewable first step: run it, confirm the tables
-- and policies look right in the Supabase dashboard, and the next pass can wire specific
-- features to it (starting with `recordings`, since it's the smallest, lowest-risk surface)
-- against your actual project, where it can be tested for real.
