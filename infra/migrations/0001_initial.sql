create type case_mode as enum ('urgent', 'planning', 'existing');
create type case_state as enum (
  'intake',
  'safety_screened',
  'searching',
  'validating',
  'awaiting_decision',
  'committing',
  'releasing',
  'resolved',
  'safety_handoff',
  'no_options',
  'expired',
  'manual_review',
  'failed'
);
create type hold_status as enum ('active', 'commit_pending', 'committed', 'release_pending', 'released', 'release_failed', 'expired');
create type provider_outcome as enum ('hold_secured', 'availability_only', 'unavailable', 'ineligible', 'no_answer', 'failed', 'unknown');

create table cases (
  id text primary key,
  version integer not null default 0,
  mode case_mode not null,
  state case_state not null,
  caller_blind_index text not null,
  need_summary text not null,
  language text not null check (language in ('en', 'hi', 'hinglish')),
  callback_deadline_at timestamptz not null,
  trace_id text not null,
  request_id text not null,
  workflow_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table providers (
  id text primary key,
  name text not null,
  service_tags text[] not null default '{}',
  accessibility_tags text[] not null default '{}',
  active boolean not null default true,
  reliability_score numeric(5, 4) not null default 0.5000
);

create table provider_attempts (
  id text primary key,
  case_id text not null references cases(id),
  provider_id text not null references providers(id),
  external_call_id text not null unique,
  outcome provider_outcome not null,
  eligibility_status text not null check (eligibility_status in ('eligible', 'ineligible', 'unknown')),
  evidence_summary text not null,
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  duration_seconds integer not null check (duration_seconds >= 0),
  created_at timestamptz not null default now()
);

create table holds (
  id text primary key,
  case_id text not null references cases(id),
  provider_id text not null references providers(id),
  reference text not null,
  expires_at timestamptz not null,
  status hold_status not null,
  constraints text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, reference)
);

create table decisions (
  id text primary key,
  case_id text not null references cases(id),
  case_version integer not null,
  selected_hold_id text not null references holds(id),
  actor text not null check (actor in ('caller', 'operator')),
  verification text not null check (verification in ('phone_match_and_reference', 'operator_override')),
  created_at timestamptz not null default now()
);

create table timeline_events (
  id text primary key,
  case_id text not null references cases(id),
  at timestamptz not null,
  title text not null,
  detail text not null,
  kind text not null check (kind in ('intake', 'safety', 'provider', 'decision', 'commit', 'release', 'diagnostic', 'audit'))
);

create table webhook_inbox (
  id text primary key,
  source text not null check (source in ('exotel', 'call-e')),
  external_event_id text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (source, external_event_id)
);

create table outbox_items (
  id text primary key,
  case_id text not null references cases(id),
  command jsonb not null,
  status text not null check (status in ('pending', 'leased', 'sent', 'failed', 'dead_lettered')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_artifacts (
  id text primary key,
  case_id text not null references cases(id),
  artifact_type text not null,
  object_uri text not null,
  retention_until timestamptz not null,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now()
);

create index cases_state_idx on cases(state);
create index holds_case_status_idx on holds(case_id, status);
create index timeline_case_at_idx on timeline_events(case_id, at);
create index webhook_inbox_unprocessed_idx on webhook_inbox(received_at) where processed_at is null;
create index outbox_pending_idx on outbox_items(created_at) where status = 'pending';
