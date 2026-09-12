alter table outbox_items
  add column lease_until timestamptz,
  add column external_ref text,
  add column adapter_response jsonb;

create index outbox_delivery_idx on outbox_items(status, lease_until, created_at);
create index outbox_external_ref_idx on outbox_items(external_ref) where external_ref is not null;
