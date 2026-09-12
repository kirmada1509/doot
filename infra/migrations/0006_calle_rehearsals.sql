create table call_e_rehearsals (
  case_id text primary key references cases(id) on delete cascade,
  idempotency_key text not null unique,
  actor_subject text not null,
  service text not null check (service in ('shelter', 'respite')),
  call_id text unique,
  status text not null check (status in ('pending', 'queued', 'in_progress', 'completed', 'failed', 'canceled')),
  availability text check (availability in ('yes', 'no', 'unknown')),
  case_code_confirmed text check (case_code_confirmed in ('yes', 'no', 'unknown')),
  answered boolean not null default false,
  task_completed boolean,
  transcript_artifact_id text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
