-- Supabase schema for the app. Apply AFTER schema.sql, schema_phase2.sql and
-- schema_phase6.sql, in the SQL editor.
--
-- Design note on multi-tenancy: this is one operator with one kiosk, so every
-- row carries owner_id and RLS restricts it to the signed-in user. That costs
-- nothing today and is the difference between "my kiosk" and "a product" later.

begin;

create extension if not exists pgcrypto;

-- --------------------------------------------------------------- ownership --

alter table items                     add column if not exists owner_id uuid default auth.uid();
alter table production_days           add column if not exists owner_id uuid default auth.uid();
alter table daily_entries             add column if not exists owner_id uuid default auth.uid();
alter table production_templates      add column if not exists owner_id uuid default auth.uid();
alter table production_template_items add column if not exists owner_id uuid default auth.uid();
alter table template_assignments      add column if not exists owner_id uuid default auth.uid();
alter table ingredients               add column if not exists owner_id uuid default auth.uid();
alter table ingredient_prices         add column if not exists owner_id uuid default auth.uid();
alter table item_ingredients          add column if not exists owner_id uuid default auth.uid();
alter table recommendations           add column if not exists owner_id uuid default auth.uid();
alter table app_config                add column if not exists owner_id uuid default auth.uid();

-- ---------------------------------------------------------- app-side sync --

-- The app writes here. One row per client mutation, keyed on the UUID the
-- device generated -- so a replay after a dropped connection is a no-op rather
-- than a duplicate. This is why the offline queue needs no server bookkeeping.
create table if not exists app_mutations (
    mutation_id uuid primary key,
    owner_id    uuid not null default auth.uid(),
    kind        text not null check (kind in ('entries','confirm','template',
                                              'item','ingredient','recipe','settings')),
    payload     jsonb not null,
    client_time timestamptz not null,
    received_at timestamptz not null default now()
);

create index if not exists app_mutations_owner_time_idx
    on app_mutations (owner_id, received_at desc);

-- Devices pull everything newer than the last cursor they saw. `received_at` is
-- server time on purpose: a phone with a wrong clock must not be able to hide
-- its own writes from itself.
create or replace function pull_since(cursor_ts timestamptz)
returns setof app_mutations
language sql stable security invoker
as $$
    select * from app_mutations
    where owner_id = auth.uid() and received_at > cursor_ts
    order by received_at
    limit 5000;
$$;

-- ------------------------------------------------------------------- RLS ---

do $$
declare t text;
begin
  foreach t in array array[
    'items','production_days','daily_entries','production_templates',
    'production_template_items','template_assignments','ingredients',
    'ingredient_prices','item_ingredients','recommendations','app_config',
    'app_mutations'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists owner_all on %I', t);
    execute format(
      'create policy owner_all on %I for all
         using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;

-- daily_entries is append-only via a trigger from schema.sql. RLS above allows
-- update/delete syntactically; the trigger still refuses them. Belt and braces:
-- the policy is what a reviewer reads, the trigger is what actually stops it.

commit;
