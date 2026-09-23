-- Phase 2 -- production templates, day confirmation, offline sync.
-- Applies on top of db/schema.sql.

begin;

-- ------------------------------------------------------------- templates ----

-- A named set of "make this many of each item". The operator's own baseline.
create table if not exists production_templates (
    template_id bigint generated always as identity primary key,
    name        text not null,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now()
);

create table if not exists production_template_items (
    template_id bigint not null references production_templates(template_id) on delete cascade,
    item_id     bigint not null references items(item_id),
    qty         numeric(10,2) not null check (qty >= 0),
    sort_order  integer not null default 0,
    primary key (template_id, item_id)
);

-- Which template each weekday uses, effective-dated. Changing a Monday template
-- inserts a row; past Mondays keep the template they actually ran under, which
-- is what makes the Phase 6 scorecard able to say "you changed your baseline
-- here" rather than silently rewriting history.
--
-- weekday follows ISO: 1 = Monday .. 7 = Sunday.
create table if not exists template_assignments (
    weekday        smallint not null check (weekday between 1 and 7),
    effective_from date     not null,
    template_id    bigint   not null references production_templates(template_id),
    recorded_at    timestamptz not null default now(),
    primary key (weekday, effective_from)
);

-- The template in force for a given date: newest assignment on or before it.
create or replace function template_for(on_date date)
returns table (item_id bigint, qty numeric) as $$
    select ti.item_id, ti.qty
    from   template_assignments ta
    join   production_template_items ti on ti.template_id = ta.template_id
    where  ta.weekday = extract(isodow from on_date)
      and  ta.effective_from <= on_date
      and  ta.effective_from = (
             select max(effective_from) from template_assignments
             where weekday = extract(isodow from on_date)
               and effective_from <= on_date)
$$ language sql stable;

-- --------------------------------------------------- day confirmation -------

-- A zero is only meaningful if someone looked. These columns are what separate
-- "counted, nothing left" from "never opened the screen", and roughly half of
-- all item-days are zero-waste, so the distinction drives the whole model.
alter table production_days add column if not exists production_confirmed_at timestamptz;
alter table production_days add column if not exists waste_confirmed_at      timestamptz;
alter table production_days add column if not exists confirmed_by            text;

-- Days needing attention: production recorded but waste never confirmed.
-- The app's task list reads this, so a missed day surfaces on its own instead
-- of needing a separate backfill mode.
create or replace view open_days as
select d.business_date,
       d.day_of_week,
       d.production_confirmed_at is not null as production_done,
       d.waste_confirmed_at      is not null as waste_done,
       exists (select 1 from daily_entries e
               where e.business_date = d.business_date
                 and e.entry_type in ('made','refill'))       as has_production,
       exists (select 1 from daily_entries e
               where e.business_date = d.business_date
                 and e.entry_type = 'waste')                  as has_waste
from   production_days d
where  d.is_outage = false
  and (d.waste_confirmed_at is null or d.production_confirmed_at is null)
order  by d.business_date desc;

-- ---------------------------------------------------------------- sync ------

-- Written by the client while offline and replayed on reconnect. The append-only
-- log already dedupes on (source_ref, value_hash) where source_ref is this
-- mutation_id, so a replayed batch is a no-op rather than a duplicate.
create table if not exists sync_mutations (
    mutation_id uuid primary key,
    client_id   text        not null,
    kind        text        not null,
    payload     jsonb       not null,
    created_at  timestamptz not null,
    applied_at  timestamptz not null default now()
);

-- --------------------------------------------- parallel-run reconciliation --

-- During cutover both systems run. This holds the spreadsheet's numbers for the
-- overlap so the two can be compared day by day; the spreadsheet is frozen only
-- once they agree. Deliberately separate from daily_entries: the app owns its
-- own record, and the comparison never contaminates it.
create table if not exists parallel_run_checks (
    business_date  date not null,
    item_id        bigint not null references items(item_id),
    sheet_made     numeric(10,2),
    sheet_wasted   numeric(10,2),
    recorded_at    timestamptz not null default now(),
    primary key (business_date, item_id)
);

create or replace view parallel_run_diff as
select c.business_date, c.item_id, i.item_key,
       c.sheet_made, s.quantity_made  as app_made,
       c.sheet_wasted, s.quantity_wasted as app_wasted,
       coalesce(s.quantity_made, 0)   - coalesce(c.sheet_made, 0)    as made_diff,
       coalesce(s.quantity_wasted, 0) - coalesce(c.sheet_wasted, 0)  as waste_diff
from   parallel_run_checks c
join   items i on i.item_id = c.item_id
left join daily_sales s
       on s.business_date = c.business_date and s.item_id = c.item_id;

commit;
