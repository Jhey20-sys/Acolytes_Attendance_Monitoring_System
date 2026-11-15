-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Stores the whole attendance database as one JSON row that the Node server reads and writes.

create table if not exists public.app_state (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- The data includes password hashes and login sessions, so lock the table down:
-- Row Level Security ON with NO policies = the public "anon" key can't read or write it.
-- Only the server's service_role key (which bypasses RLS) can.
alter table public.app_state enable row level security;
revoke all on public.app_state from anon, authenticated;
