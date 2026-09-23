-- Phase 1 Step 4 -- production planning schema (Postgres / Supabase).
--
-- Design decisions that were mandated up front, and where each one lives:
--
--   1. Everything keys on surrogate item ids, never names.   -> items.item_id
--   2. Item attributes are effective-dated, not mutable.     -> item_attributes
--   3. The daily log is append-only, with a business date
--      separate from when it was recorded.                   -> daily_entries
--   4. Every recommendation the system issues is stored with
--      its model version and the inputs it used.             -> recommendations
--   5. The training window is config, not a constant.        -> app_config
--
-- Two design notes worth reading before you review the rest.
--
--   Sales are DERIVED, not observed. sold = made + refill - wasted. There is no
--   POS feed. Storing sales as its own table would create a second thing
--   claiming to own a number that is already fully determined by three others,
--   so daily_sales is a VIEW. If a POS feed ever lands, sales becomes observed:
--   it gets a real table, and this view becomes the reconciliation between them.
--
--   Waste is counted the MORNING AFTER the business date it belongs to. That is
--   the whole reason business_date and recorded_at are separate columns rather
--   than one timestamp, and the entry form must default the waste date to
--   yesterday. Getting this wrong shifts a day's waste onto the wrong day and
--   silently corrupts every model downstream.

begin;

-- ---------------------------------------------------------------- config ----

create table if not exists app_config (
    key         text primary key,
    value       jsonb       not null,
    description text,
    updated_at  timestamptz not null default now()
);

insert into app_config (key, value, description) values
    ('training_window_days', '180'::jsonb,
     'Trailing days of history used to fit models. Not a constant -- widen as history grows.'),
    ('baseline_window_days', '28'::jsonb,
     'Trailing days for the naive same-weekday baseline (Phase 3).'),
    ('min_observations_per_item', '20'::jsonb,
     'Below this an item falls back to the pooled/baseline estimate.'),
    ('markdown_start_hour', '19'::jsonb,
     'Local hour at which unsold product is marked down.'),
    ('markdown_fraction', '0.30'::jsonb,
     'Discount applied at markdown. Sold units are a blend of full and marked-down price.'),
    ('salvage_value', '0.0'::jsonb,
     'Value recovered per DISCARDED unit. Zero: waste is counted the morning after,
      so anything that cleared at markdown is already inside sold.'),
    ('promo_b2g1_weekdays', '[3]'::jsonb,
     'ISO weekdays running buy-2-get-1 (3 = Wednesday).')
on conflict (key) do nothing;

-- ----------------------------------------------------------------- items ----

create table if not exists items (
    item_id      bigint generated always as identity primary key,
    item_key     text not null unique,   -- stable slug; a natural key, never the PK
    display_name text not null,
    created_at   timestamptz not null default now()
);

comment on column items.item_key is
    'Lowercased, whitespace-collapsed name. Unique, but NOT the primary key: names
     change and split, ids must not.';

-- Raw strings as written on a sheet or typed into the app, mapped to an item.
-- This is where "salmon deluxe " with a trailing space stops being a 43rd item.
create table if not exists item_aliases (
    raw_name text primary key,
    item_id  bigint not null references items(item_id),
    note     text
);

-- Effective-dated attributes. There is no effective_to and no overlap is
-- possible by construction: the value on date D is the row with the greatest
-- effective_from <= D. Changing a price inserts a row, never updates one.
create table if not exists item_attributes (
    item_id        bigint not null references items(item_id),
    effective_from date   not null,
    price          numeric(10,2),
    unit_cost      numeric(10,4),
    portion_size   text,
    plu_code       text,
    plu_name       text,
    is_active      boolean not null default true,
    source         text,
    recorded_at    timestamptz not null default now(),
    primary key (item_id, effective_from)
);

-- Renames, 1->2 splits, merges. Recorded, never applied destructively: the log
-- keeps observations attached to the item actually written down. Whether a
-- parent's history informs a child is a Phase 4 modelling choice, and the
-- backtest scores it.
create table if not exists item_lineage (
    parent_item_id bigint not null references items(item_id),
    child_item_id  bigint not null references items(item_id),
    effective_date date   not null,
    kind           text   not null check (kind in ('rename','split','merge')),
    note           text,
    primary key (parent_item_id, child_item_id, effective_date)
);

-- ---------------------------------------------------- ingredients / BOM ----

create table if not exists ingredients (
    ingredient_id   bigint generated always as identity primary key,
    name            text not null unique,
    unit_of_measure text not null,
    created_at      timestamptz not null default now()
);

-- Effective-dated the same way as item_attributes. When salmon moves you insert
-- one row and every downstream item cost and critical ratio reprices itself.
create table if not exists ingredient_prices (
    ingredient_id  bigint not null references ingredients(ingredient_id),
    effective_from date   not null,
    pack_cost      numeric(10,4) not null,
    pack_qty       numeric(12,4) not null check (pack_qty > 0),
    source         text,
    recorded_at    timestamptz not null default now(),
    primary key (ingredient_id, effective_from)
);

-- The bill of materials. sort_order exists so the drag-and-drop recipe builder
-- has somewhere to persist the order the operator arranged rows in.
create table if not exists item_ingredients (
    item_id        bigint  not null references items(item_id),
    ingredient_id  bigint  not null references ingredients(ingredient_id),
    effective_from date    not null,
    qty_per_unit   numeric(12,4) not null check (qty_per_unit >= 0),
    sort_order     integer not null default 0,
    recorded_at    timestamptz not null default now(),
    primary key (item_id, ingredient_id, effective_from)
);

-- ------------------------------------------------------------ the log ------

create table if not exists production_days (
    business_date date primary key,
    day_of_week   text    not null,
    is_outage     boolean not null default false,
    weather       text,
    holiday_event text,
    promo         text,
    notes         text,
    source        text,
    recorded_at   timestamptz not null default now()
);

create table if not exists import_batches (
    batch_id      bigint generated always as identity primary key,
    source_file   text not null,
    source_sha256 text not null,
    started_at    timestamptz not null default now(),
    finished_at   timestamptz,
    row_count     integer
);

-- The append-only fact table. One row per observation, never updated.
--
-- Idempotency: source_ref identifies exactly where an observation came from
-- ('August 31!C6'), and value_hash covers what it said. Re-importing unchanged
-- data conflicts and is skipped. Re-importing CHANGED data inserts a new row
-- that supersedes the old one by recorded_at -- a correction is additive, and
-- the original stays readable.
create table if not exists daily_entries (
    entry_id      bigint generated always as identity primary key,
    business_date date    not null references production_days(business_date),
    item_id       bigint  not null references items(item_id),
    entry_type    text    not null check (entry_type in ('made','refill','waste','afternoon_count')),
    quantity      numeric(10,2) not null check (quantity >= 0),
    recorded_at   timestamptz not null default now(),
    source        text    not null,          -- 'workbook-seed' | 'app' | 'backfill'
    source_ref    text,                      -- 'August 31!C6'
    value_hash    text,
    batch_id      bigint references import_batches(batch_id),
    note          text,
    unique (source_ref, value_hash)
);

create index if not exists daily_entries_date_item_idx
    on daily_entries (business_date, item_id, entry_type);

-- Append-only, enforced. If you need to change a number, insert a new row.
create or replace function daily_entries_append_only() returns trigger as $$
begin
    raise exception
        'daily_entries is append-only (attempted % on entry_id %). Insert a correcting row instead.',
        tg_op, coalesce(old.entry_id, -1);
end;
$$ language plpgsql;

drop trigger if exists daily_entries_no_mutate on daily_entries;
create trigger daily_entries_no_mutate
    before update or delete on daily_entries
    for each row execute function daily_entries_append_only();

-- ---------------------------------------------------- recommendations ------

-- Every recommendation the system ISSUES is stored here at issue time, with the
-- model version and the exact inputs. The Phase 6 scorecard reads this table.
-- It must never be recomputed after the fact -- refitting a model and scoring it
-- against history it has already seen is how a system flatters itself.
create table if not exists recommendations (
    rec_id          bigint generated always as identity primary key,
    business_date   date   not null,
    item_id         bigint not null references items(item_id),
    recommended_qty numeric(10,2) not null,
    baseline_qty    numeric(10,2),          -- always show what the baseline said
    model_name      text   not null,
    model_version   text   not null,
    critical_ratio  numeric(6,5),
    inputs          jsonb  not null default '{}'::jsonb,
    is_fallback     boolean not null default false,
    fallback_reason text,
    generated_at    timestamptz not null default now(),
    unique (business_date, item_id, model_name, model_version)
);

create table if not exists model_runs (
    run_id       bigint generated always as identity primary key,
    model_name   text not null,
    model_version text not null,
    trained_at   timestamptz not null default now(),
    train_start  date,
    train_end    date,
    config       jsonb not null default '{}'::jsonb,
    metrics      jsonb not null default '{}'::jsonb,
    status       text not null default 'ok'
);

-- ----------------------------------------------------------- views ---------

-- Latest value wins for a given (business_date, item_id, entry_type). This is
-- what makes corrections work without ever mutating a row.
create or replace view current_entries as
select distinct on (business_date, item_id, entry_type)
       business_date, item_id, entry_type, quantity, recorded_at, source, note
from   daily_entries
order  by business_date, item_id, entry_type, recorded_at desc, entry_id desc;

create or replace view daily_production as
select business_date, item_id,
       sum(quantity) filter (where entry_type = 'made')   as quantity_made,
       sum(quantity) filter (where entry_type = 'refill') as quantity_refill
from   current_entries
where  entry_type in ('made','refill')
group  by business_date, item_id;

create or replace view daily_waste as
select business_date, item_id, sum(quantity) as quantity_wasted
from   current_entries
where  entry_type = 'waste'
group  by business_date, item_id;

-- Derived, not observed. demand_censored marks the days where the item sold out
-- and true demand is only known to be >= quantity_sold. Nearly half of all
-- item-days land here, so no model may ignore it.
create or replace view daily_sales as
select coalesce(p.business_date, w.business_date) as business_date,
       coalesce(p.item_id, w.item_id)             as item_id,
       coalesce(p.quantity_made, 0)               as quantity_made,
       coalesce(p.quantity_refill, 0)             as quantity_refill,
       coalesce(w.quantity_wasted, 0)             as quantity_wasted,
       coalesce(p.quantity_made, 0) + coalesce(p.quantity_refill, 0)
         - coalesce(w.quantity_wasted, 0)         as quantity_sold,
       coalesce(w.quantity_wasted, 0) = 0         as demand_censored
from   daily_production p
full join daily_waste w
       on p.business_date = w.business_date and p.item_id = w.item_id;

-- Attribute and cost resolution as of a date, for the recommendation engine.
create or replace view item_cost_current as
select ii.item_id,
       sum(ii.qty_per_unit * ip.pack_cost / ip.pack_qty) as unit_cost
from   item_ingredients ii
join   lateral (
           select pack_cost, pack_qty
           from   ingredient_prices p
           where  p.ingredient_id = ii.ingredient_id
           order  by p.effective_from desc
           limit  1
       ) ip on true
group  by ii.item_id;

commit;
