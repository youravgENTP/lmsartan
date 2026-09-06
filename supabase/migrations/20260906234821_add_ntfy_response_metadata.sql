alter table public.notification_log
  add column if not exists ntfy_topic text,
  add column if not exists ntfy_message_id text,
  add column if not exists ntfy_message_time timestamptz,
  add column if not exists ntfy_response_json jsonb;