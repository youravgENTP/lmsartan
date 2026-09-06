# LMSartan

> Because missing LMS notifications shouldn't raise your blood pressure.

LMSartan is a personal Canvas LMS watcher for Inje University's e-edu.
It periodically checks courses for newly published content and sends a push
notification when something new appears.

## Architecture

Canvas REST API
→ Supabase Edge Function
→ Supabase Postgres
→ ntfy
→ iPhone

## MVP

- Read active Canvas courses using a Personal Access Token
- Poll course modules and module items
- Store previously seen Canvas item IDs
- Detect newly appearing content
- Do not notify for the initial baseline
- Send ntfy notifications for new content
- Run automatically with Supabase Cron

## Future

- Announcements and assignments
- Notification history and preferences
- Native iOS client

## Security

Never commit Canvas access tokens, ntfy credentials, or other secrets.
Use `.env` locally and Supabase Secrets in production.

## Status

Early development / API validation.
