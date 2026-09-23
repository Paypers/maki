-- Phase 6 -- scheduled jobs, stored recommendations, rolling scorecard.
-- Applies on top of db/schema.sql and db/schema_phase2.sql.

begin;

-- Every attempt, successful or not. `last_ok` and `last_error` are kept
-- separately on purpose: health needs to know both what broke now and when the
-- job last actually worked, and a single status column loses one of them.
create table if not exists job_runs (
    run_id      bigint generated always as identity primary key,
    job         text        not null,
    started_at  timestamptz not null default now(),
    finished_at timestamptz,
    status      text        not null check (status in ('ok','error','running')),
    message     text,
    metrics     jsonb       not null default '{}'::jsonb
);

create index if not exists job_runs_job_time_idx on job_runs (job, started_at desc);

create or replace view job_health as
select job,
       max(started_at)                                     as last_attempt,
       max(started_at) filter (where status = 'ok')        as last_ok,
       (array_agg(message order by started_at desc)
          filter (where status = 'error'))[1]              as last_error
from   job_runs
group  by job;

-- Alert cooldowns. Without this an unresolved condition fires every run until
-- the operator learns to ignore alerts entirely.
create table if not exists alert_state (
    code      text primary key,
    last_sent timestamptz not null,
    payload   jsonb
);

-- The rolling scorecard reads `recommendations` (defined in schema.sql) joined
-- to outcomes. It never regenerates a quantity: recommended_qty and
-- baseline_qty are what was issued that morning, and scoring them is the only
-- way the comparison stays honest as the model changes underneath it.
create or replace view recommendation_outcomes as
select r.business_date,
       r.item_id,
       i.item_key,
       r.model_name,
       r.model_version,
       r.recommended_qty,
       r.baseline_qty,
       r.is_fallback,
       r.generated_at,
       s.quantity_made + s.quantity_refill as supplied,
       s.quantity_sold,
       s.demand_censored
from   recommendations r
join   items i       on i.item_id = r.item_id
left join daily_sales s
       on s.business_date = r.business_date and s.item_id = r.item_id;

comment on view recommendation_outcomes is
  'Issued recommendations joined to what actually happened. Costing happens in
   analysis/scorecard.py so that a dollar here means exactly what a dollar in
   the backtest means -- including the treatment of censored demand.';

commit;
