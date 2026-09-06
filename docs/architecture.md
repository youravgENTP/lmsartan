# LMSartan Architecture

## Current target

A serverless personal watcher for Inje University's Canvas LMS.

Supabase Cron
      ↓
check-canvas Edge Function
      ↓
Canvas REST API
      ↓
Compare against stored item IDs
      ↓
New item detected
      ↓
ntfy
      ↓
iPhone

## Canvas source

Primary MVP endpoint:

GET /api/v1/courses/{course_id}/modules?include[]=items&per_page=100

Canonical identity for module content:

(course_id, item_id)

The initial run creates a baseline and must not generate notifications.

## Components

- Canvas adapter: fetch and normalize Canvas objects
- Change detector: identify previously unseen items
- Persistence: Supabase Postgres
- Notification adapter: ntfy
- Scheduler: Supabase Cron
