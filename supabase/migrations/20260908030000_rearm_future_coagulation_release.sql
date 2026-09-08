-- This Week 2 notification was sent while the LearningX item was visible in
-- Canvas but its own viewing window was still scheduled for the future.
with premature_release as (
  delete from public.notification_log
  where event_type = 'learningx_week_unlocked'
    and status = 'success'
    and message like '%(3학년)2026\_coagulation%' escape '\'
  returning course_id, source_id
)
update public.learningx_weeks as week
set unlock_notified_at = null
from premature_release
where week.course_id = premature_release.course_id
  and week.week_position::text = premature_release.source_id;
