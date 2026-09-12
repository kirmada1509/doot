alter table cases
  add column caller_label text not null default 'Caller',
  add column safety jsonb not null default '{"initialScreenClear":true,"midCallEscalation":false,"handoffScript":""}'::jsonb,
  add column sms_receipt_queued boolean not null default false,
  add column confirmation_call_scheduled boolean not null default false,
  add column aggregate jsonb;

alter table providers
  add column location_tags text[] not null default '{}',
  add column languages text[] not null default '{en}',
  add column accepts_holds boolean not null default false,
  add column reliability jsonb not null default '{"answeredCallRate":0,"holdHonourRate":0,"orphanHoldRate":0,"averageResponseSeconds":0}'::jsonb;

alter table outbox_items add column idempotency_key text;
update outbox_items set idempotency_key = command ->> 'idempotencyKey' where idempotency_key is null;
alter table outbox_items alter column idempotency_key set not null;
create unique index outbox_idempotency_key_idx on outbox_items(idempotency_key);

alter table audit_artifacts
  add column deletion_status text not null default 'retained'
    check (deletion_status in ('retained', 'delete_scheduled', 'deleted', 'legal_hold_blocked'));

create table audit_access_events (
  id text primary key,
  artifact_id text not null references audit_artifacts(id),
  actor_subject text not null,
  actor_role text not null,
  reason text not null,
  allowed boolean not null,
  occurred_at timestamptz not null default now()
);

create index audit_access_artifact_at_idx on audit_access_events(artifact_id, occurred_at desc);
