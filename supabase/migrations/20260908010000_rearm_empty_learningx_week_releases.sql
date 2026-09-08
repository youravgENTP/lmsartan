-- Re-arm only successful week-release notifications whose persisted message has
-- no student-facing content after the heading and optional release-time line.
-- Deleting the corresponding log row is required because notification_log is
-- also used as the ntfy idempotency key.
with false_releases as (
  delete from public.notification_log
  where event_type = 'learningx_week_unlocked'
    and status = 'success'
    and btrim(coalesce(message, '')) ~
      '^[0-9]+주차 강의가 공개되었습니다\.(\n공개시각: [^\n]+)?$'
  returning course_id, source_id
)
update public.learningx_weeks as week
set unlock_notified_at = null
from false_releases
where week.course_id = false_releases.course_id
  and week.week_position::text = false_releases.source_id;
