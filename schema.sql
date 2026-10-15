-- OOQ Life: one table holds every record (transactions, tasks, journal…).
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.

create table if not exists public.ooq_records (
  user_id           uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id                text        not null,
  collection        text        not null,
  data              jsonb       not null default '{}'::jsonb,
  updated_at        timestamptz not null,            -- set by the device that made the change
  deleted           boolean     not null default false,
  server_updated_at timestamptz not null default clock_timestamp(), -- set here, used to pull changes
  primary key (user_id, id)
);

create index if not exists ooq_records_pull_idx on public.ooq_records (user_id, server_updated_at);

-- Last write wins: an older change never overwrites a newer one.
create or replace function public.ooq_records_lww()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null; -- keep the newer row that is already stored
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists ooq_records_lww on public.ooq_records;
create trigger ooq_records_lww
  before insert or update on public.ooq_records
  for each row execute function public.ooq_records_lww();

-- Row level security: only the signed-in owner can read or write their rows.
alter table public.ooq_records enable row level security;

drop policy if exists "own rows: select" on public.ooq_records;
drop policy if exists "own rows: insert" on public.ooq_records;
drop policy if exists "own rows: update" on public.ooq_records;
drop policy if exists "own rows: delete" on public.ooq_records;

create policy "own rows: select" on public.ooq_records
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "own rows: insert" on public.ooq_records
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own rows: update" on public.ooq_records
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows: delete" on public.ooq_records
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.ooq_records from anon;
grant select, insert, update, delete on public.ooq_records to authenticated;
