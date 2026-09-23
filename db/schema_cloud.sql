-- The ONLY schema the app needs. Paste this into the Supabase SQL editor and
-- run it once. Nothing else.
--
-- The other files here (schema.sql, schema_phase2.sql, schema_phase6.sql) are
-- the analysis pipeline's warehouse -- items, daily_entries, recommendations,
-- job runs. That pipeline runs on your machine against the extract, not in the
-- cloud, and the app never reads or writes those tables. Applying them to get
-- the app online would be four files of failure surface for nothing.
--
-- The app writes exactly one table. That is not a simplification of the
-- design, it IS the design: the log is append-only and every row carries the
-- UUID the device minted, so the server needs no merge logic, no conflict
-- resolution and no per-table schema to keep in step with the client. Adding a
-- field to the app changes the JSON in `payload` and requires no migration.

begin;

-- One row per client mutation, keyed on the id the device generated. A replay
-- after a dropped connection collides on the primary key and is ignored, which
-- is what makes the offline queue safe to retry forever.
create table if not exists app_mutations (
    mutation_id uuid primary key,
    owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
    kind        text not null check (kind in ('entries','confirm','template',
                                              'item','ingredient','recipe','settings')),
    payload     jsonb not null,
    client_time timestamptz not null,
    received_at timestamptz not null default now()
);

create index if not exists app_mutations_owner_time_idx
    on app_mutations (owner_id, received_at desc);

-- Row-level security. Without this, anyone holding the anon key -- which ships
-- in the app and is meant to be public -- could read every row. With it, the
-- key grants nothing until someone signs in, and then only their own rows.
alter table app_mutations enable row level security;

drop policy if exists owner_all on app_mutations;
create policy owner_all on app_mutations
    for all
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());

-- Devices pull everything newer than the last cursor they saw. `received_at`
-- is SERVER time on purpose: a phone with a wrong clock must not be able to
-- hide its own writes from itself.
--
-- `security invoker` so the caller's RLS still applies -- the owner_id filter
-- below is belt and braces, not the protection.
create or replace function pull_since(cursor_ts timestamptz)
returns setof app_mutations
language sql
stable
security invoker
set search_path = public
as $$
    select * from app_mutations
    where owner_id = auth.uid() and received_at > cursor_ts
    order by received_at
    limit 5000;
$$;

-- PostgREST reaches the database as these roles. Supabase grants them on new
-- public tables by default, but the default can be changed and a missing grant
-- fails as a confusing 404 rather than a permission error -- so be explicit.
grant usage on schema public to anon, authenticated;
grant select, insert on app_mutations to authenticated;
grant execute on function pull_since(timestamptz) to authenticated;

commit;

-- PostgREST caches the schema. Without this the new table 404s until the cache
-- happens to refresh on its own.
notify pgrst, 'reload schema';
