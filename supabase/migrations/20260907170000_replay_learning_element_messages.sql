-- One-time replay requested to verify ntfy delivery for the two conversations
-- that were present when inbox monitoring was first enabled.
delete from public.canvas_conversations
where conversation_id in ('10619', '10328');
