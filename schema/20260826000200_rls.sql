-- ============================================================================
-- Row Level Security
--
-- Every table is deny-by-default: RLS is enabled with no permissive grant beyond
-- the policies below, so a missing policy fails closed rather than leaking data.
--
-- The predicate is always `user_id = (select auth.uid())`. Wrapping auth.uid() in a
-- scalar subquery lets Postgres evaluate it once per statement instead of once per
-- row, which matters on the transactions table.
--
-- WITH CHECK is specified on every write policy. Without it a user could UPDATE a row
-- they own and set user_id to someone else's id, silently handing over their data.
-- ============================================================================

alter table public.profiles                 enable row level security;
alter table public.categories               enable row level security;
alter table public.accounts                 enable row level security;
alter table public.transactions             enable row level security;
alter table public.income_records           enable row level security;
alter table public.budgets                  enable row level security;
alter table public.recurring_expenses       enable row level security;
alter table public.financial_goals          enable row level security;
alter table public.merchant_mappings        enable row level security;
alter table public.imports                  enable row level security;
alter table public.import_transactions      enable row level security;
alter table public.salary_cycles            enable row level security;
alter table public.insights                 enable row level security;
alter table public.notification_preferences enable row level security;

-- ---------------------------------------------------------------------------
-- Table privileges
--
-- RLS policies FILTER rows; they do not GRANT access. A table with perfect policies
-- and no grant returns "permission denied" to every request, and a table with grants
-- and no policies returns everything to everyone. Both halves are required, so both
-- are stated explicitly here rather than inherited from whatever default privileges
-- happen to be configured — this schema holds financial data and should not depend on
-- an environment default that could differ between local, staging and production.
-- ---------------------------------------------------------------------------

-- `anon` is the pre-login role. It must never reach a financial table; the only thing
-- an unauthenticated client does is sign in, which goes through GoTrue, not PostgREST.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

grant usage on schema public to authenticated;

do $$
declare
  t text;
  owned_tables text[] := array[
    'profiles', 'categories', 'accounts', 'transactions', 'income_records', 'budgets',
    'recurring_expenses', 'financial_goals', 'merchant_mappings', 'imports',
    'import_transactions', 'salary_cycles', 'insights', 'notification_preferences'
  ];
begin
  foreach t in array owned_tables loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end;
$$;

-- --- profiles ---------------------------------------------------------------
-- Keyed by id rather than user_id, since the id IS the auth user.

create policy profiles_select on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy profiles_insert on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy profiles_delete on public.profiles
  for delete to authenticated using (id = (select auth.uid()));

-- --- the owner-scoped tables ------------------------------------------------
-- Identical shape for each, generated rather than hand-repeated so no table can be
-- accidentally given a weaker predicate than its neighbours.

do $$
declare
  t text;
  owned_tables text[] := array[
    'categories', 'accounts', 'transactions', 'income_records', 'budgets',
    'recurring_expenses', 'financial_goals', 'merchant_mappings', 'imports',
    'import_transactions', 'salary_cycles', 'insights'
  ];
begin
  foreach t in array owned_tables loop
    execute format($f$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using (user_id = (select auth.uid()));

      create policy %1$I_insert on public.%1$I
        for insert to authenticated
        with check (user_id = (select auth.uid()));

      create policy %1$I_update on public.%1$I
        for update to authenticated
        using (user_id = (select auth.uid()))
        with check (user_id = (select auth.uid()));

      create policy %1$I_delete on public.%1$I
        for delete to authenticated
        using (user_id = (select auth.uid()));
    $f$, t);
  end loop;
end;
$$;

-- --- notification_preferences (keyed by user_id as the PK) ------------------

create policy notification_preferences_select on public.notification_preferences
  for select to authenticated using (user_id = (select auth.uid()));

create policy notification_preferences_insert on public.notification_preferences
  for insert to authenticated with check (user_id = (select auth.uid()));

create policy notification_preferences_update on public.notification_preferences
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy notification_preferences_delete on public.notification_preferences
  for delete to authenticated using (user_id = (select auth.uid()));

-- ============================================================================
-- Private storage for uploaded statements and screenshots
--
-- The bucket is private. Objects are addressed as `<user_id>/<import_id>/<file>`,
-- and the policies below require the first path segment to equal the caller's id, so
-- one user can never read another's uploaded bank statement even with a guessed path.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'statements',
  'statements',
  false,
  26214400, -- 25 MB
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'application/pdf',
    'text/csv', 'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy statements_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'statements'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy statements_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'statements'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy statements_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'statements'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'statements'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy statements_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'statements'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
