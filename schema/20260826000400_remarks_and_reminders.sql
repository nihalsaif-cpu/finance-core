-- ============================================================================
-- Remarks on imports, and daily reminders.
--
-- A new migration rather than an edit to an applied one: the earlier files have
-- already run, and rewriting them would leave any deployed database silently out of
-- step with what the repository claims.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Remarks
--
-- A UPI screenshot often shows nothing but a virtual address ("q4839201@ybl") and an
-- amount. The user knows it was "auto to the office"; the app cannot possibly know.
-- Capturing that at upload time is the difference between a categorised transaction
-- and one that sits in Uncategorised forever.
-- ---------------------------------------------------------------------------

alter table public.imports
  add column if not exists note text;

alter table public.import_transactions
  add column if not exists notes text;

comment on column public.imports.note is
  'What the user said this upload was, captured at upload time.';
comment on column public.import_transactions.notes is
  'Carried into transactions.notes on commit.';

-- ---------------------------------------------------------------------------
-- Daily reminder
--
-- Stored as an hour and a minute in the user''s own timezone rather than a timestamp:
-- the reminder means "at the end of my day", which is a wall-clock idea. A stored
-- instant would drift the moment the user travels.
--
-- The notification itself is scheduled ON THE DEVICE (expo-notifications), so these
-- columns exist to remember the preference across reinstalls, not to drive a server.
-- ---------------------------------------------------------------------------

alter table public.notification_preferences
  add column if not exists daily_reminder boolean not null default false,
  add column if not exists daily_reminder_hour smallint not null default 21,
  add column if not exists daily_reminder_minute smallint not null default 0;

alter table public.notification_preferences
  drop constraint if exists notif_daily_hour,
  drop constraint if exists notif_daily_minute;

alter table public.notification_preferences
  add constraint notif_daily_hour check (daily_reminder_hour between 0 and 23),
  add constraint notif_daily_minute check (daily_reminder_minute between 0 and 59);

comment on column public.notification_preferences.daily_reminder is
  'Whether the on-device end-of-day reminder is scheduled.';
