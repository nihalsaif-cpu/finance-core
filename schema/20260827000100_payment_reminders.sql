-- ============================================================================
-- Payment reminders on recurring commitments.
--
-- `recurring_expenses` already carries everything the calendar needs to project a
-- series forward (amount, interval, anchor dates). What it lacks is the user's
-- intent about being TOLD. Reminding is a separate decision from tracking: the rent
-- is worth projecting whether or not the user wants a notification about it, and a
-- subscription they have already resigned themselves to needs no nudge at all.
-- ============================================================================

alter table public.recurring_expenses
  add column if not exists reminder_enabled boolean not null default false,
  add column if not exists remind_days_before smallint not null default 1;

alter table public.recurring_expenses
  drop constraint if exists recurring_remind_days;

-- Two weeks is the outer bound of useful warning. Beyond that the reminder arrives
-- while the money is still committed elsewhere and is simply ignored, which trains
-- the user to dismiss the whole class of notification.
alter table public.recurring_expenses
  add constraint recurring_remind_days check (remind_days_before between 0 and 14);

comment on column public.recurring_expenses.reminder_enabled is
  'Whether to schedule an on-device notification before this payment falls due.';
comment on column public.recurring_expenses.remind_days_before is
  'Days of warning. 0 means the morning it is due.';

-- Reminder scheduling walks every active series on app open; without this it is a
-- sequential scan of the user''s whole commitment history on each launch.
create index if not exists recurring_active_reminders_idx
  on public.recurring_expenses (user_id, next_due_date)
  where is_active and reminder_enabled;
