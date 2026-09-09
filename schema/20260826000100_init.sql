-- ============================================================================
-- Spend Cents — schema
--
-- Conventions:
--   * Money is stored as BIGINT in currency minor units (paise for INR). Never
--     float, never numeric-as-text. The client's Money module is the only place
--     that converts to and from major units.
--   * `amount` columns hold a POSITIVE magnitude. Financial direction comes from
--     `kind`, so no calculation ever has to infer meaning from a sign.
--   * Dates that describe when money moved are DATE (a calendar day), not
--     timestamptz. A transaction happened on 14 August regardless of the reader's
--     timezone. Audit columns (created_at/updated_at) are timestamptz.
--   * Every user-owned row carries user_id and is protected by RLS.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type transaction_kind as enum (
  'expense',          -- money spent from bank/cash/debit
  'cc_charge',        -- purchase on a credit card; real spending
  'income',           -- salary, interest, gifts
  'refund',           -- money returned; reduces spending
  'transfer',         -- between the user's own accounts; neither
  'cc_payment',       -- bank -> credit card; settles a liability, NOT new spending
  'cash_withdrawal',  -- bank -> cash in hand
  'cash_deposit',     -- cash in hand -> bank
  'investment'        -- outflow into savings/investments, not consumption
);

create type transaction_status as enum ('posted', 'pending', 'failed', 'reversed');

create type payment_method as enum (
  'cash', 'upi', 'debit_card', 'credit_card', 'bank_transfer', 'netbanking', 'wallet', 'other'
);

create type transaction_source as enum (
  'manual', 'import_image', 'import_pdf', 'import_csv', 'import_xlsx', 'recurring'
);

create type category_kind as enum ('expense', 'income', 'transfer', 'savings');
create type category_classification as enum ('essential', 'discretionary', 'mixed');
create type account_type as enum ('bank', 'credit_card', 'cash', 'wallet', 'investment');
create type income_kind as enum ('salary', 'bonus', 'freelance', 'interest', 'refund', 'gift', 'other');
create type budget_period as enum ('cycle', 'monthly');
create type recurrence_interval as enum ('weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly');
create type goal_kind as enum ('emergency_fund', 'vacation', 'purchase', 'vehicle', 'investment', 'other');
create type cycle_frequency as enum ('monthly', 'semimonthly', 'biweekly', 'weekly');
create type import_kind as enum ('image', 'pdf', 'csv', 'xlsx');
create type import_status as enum ('uploading', 'extracting', 'review', 'committed', 'failed', 'rolled_back');
create type staged_status as enum ('pending', 'accepted', 'rejected', 'duplicate', 'merged');
create type mapping_origin as enum ('system', 'user', 'learned');
create type insight_severity as enum ('positive', 'neutral', 'warning', 'critical');

-- ---------------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user, holding cycle and target configuration
-- ---------------------------------------------------------------------------

create table public.profiles (
  id                              uuid primary key references auth.users(id) on delete cascade,
  display_name                    text,
  currency                        char(3)        not null default 'INR',
  time_zone                       text           not null default 'Asia/Kolkata',

  cycle_start_day                 smallint       not null default 1,
  cycle_frequency                 cycle_frequency not null default 'monthly',
  cycle_anchor_date               date,

  expected_monthly_income         bigint         not null default 0,
  savings_target                  bigint         not null default 0,
  emergency_fund_target           bigint         not null default 0,

  -- Whether an ATM withdrawal counts as spending. False suits users who record
  -- individual cash purchases against a cash account.
  cash_withdrawal_counts_as_spend boolean        not null default true,

  onboarded_at                    timestamptz,
  created_at                      timestamptz    not null default now(),
  updated_at                      timestamptz    not null default now(),

  constraint profiles_cycle_start_day_valid check (cycle_start_day between 1 and 31),
  constraint profiles_currency_upper        check (currency = upper(currency)),
  constraint profiles_income_non_negative   check (expected_monthly_income >= 0),
  constraint profiles_savings_non_negative  check (savings_target >= 0),
  constraint profiles_emergency_non_negative check (emergency_fund_target >= 0),
  -- Weekly and biweekly cycles are meaningless without a phase anchor.
  constraint profiles_anchor_required check (
    cycle_frequency in ('monthly', 'semimonthly') or cycle_anchor_date is not null
  )
);

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- categories — seeded per user so they can be renamed and reclassified freely
-- ---------------------------------------------------------------------------

create table public.categories (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  parent_id      uuid references public.categories(id) on delete cascade,
  name           text not null,
  slug           text not null,
  kind           category_kind not null default 'expense',
  classification category_classification not null default 'discretionary',
  icon           text not null default 'circle',
  color          text not null default '#8A94A6',
  is_active      boolean not null default true,
  is_system      boolean not null default false,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint categories_name_not_blank check (length(btrim(name)) > 0),
  constraint categories_not_own_parent check (parent_id is null or parent_id <> id),
  unique (user_id, slug)
);

create index categories_user_idx        on public.categories (user_id) where is_active;
create index categories_user_parent_idx on public.categories (user_id, parent_id);

create trigger categories_touch before update on public.categories
  for each row execute function public.touch_updated_at();

-- A category's parent must belong to the same user. Enforced with a trigger
-- because a composite FK would require a redundant unique key.
create or replace function public.assert_category_parent_same_user()
returns trigger
language plpgsql
as $$
declare parent_user uuid;
begin
  if new.parent_id is null then
    return new;
  end if;
  select user_id into parent_user from public.categories where id = new.parent_id;
  if parent_user is null or parent_user <> new.user_id then
    raise exception 'Category parent must belong to the same user';
  end if;
  return new;
end;
$$;

create trigger categories_parent_same_user
  before insert or update of parent_id on public.categories
  for each row execute function public.assert_category_parent_same_user();

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------

create table public.accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  name            text not null,
  type            account_type not null,
  last4           char(4),
  institution     text,
  currency        char(3) not null default 'INR',
  statement_day   smallint,
  due_day         smallint,
  credit_limit    bigint,
  opening_balance bigint not null default 0,
  is_active       boolean not null default true,
  color           text not null default '#4C6FFF',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint accounts_name_not_blank   check (length(btrim(name)) > 0),
  constraint accounts_last4_digits     check (last4 is null or last4 ~ '^[0-9]{4}$'),
  constraint accounts_statement_day    check (statement_day is null or statement_day between 1 and 31),
  constraint accounts_due_day          check (due_day is null or due_day between 1 and 31),
  constraint accounts_credit_limit     check (credit_limit is null or credit_limit >= 0),
  -- Statement and due days only mean anything for a credit card.
  constraint accounts_card_fields_only_on_cards check (
    type = 'credit_card' or (statement_day is null and due_day is null and credit_limit is null)
  )
);

create index accounts_user_idx on public.accounts (user_id) where is_active;
create unique index accounts_user_last4_type_idx
  on public.accounts (user_id, type, last4) where last4 is not null;

create trigger accounts_touch before update on public.accounts
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- transactions — the central ledger
-- ---------------------------------------------------------------------------

create table public.transactions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.profiles(id) on delete cascade,

  date                     date not null,
  value_date               date,
  amount                   bigint not null,
  currency                 char(3) not null default 'INR',
  kind                     transaction_kind not null default 'expense',
  status                   transaction_status not null default 'posted',

  description              text not null default '',
  merchant_raw             text,
  merchant_key             text,
  merchant_name            text,

  category_id              uuid references public.categories(id) on delete set null,
  payment_method           payment_method not null default 'other',
  account_id               uuid references public.accounts(id) on delete set null,
  counterparty_account_id  uuid references public.accounts(id) on delete set null,

  is_essential             boolean,          -- null = inherit from the category
  is_recurring             boolean not null default false,
  recurring_expense_id     uuid,             -- FK added after recurring_expenses exists

  notes                    text,
  source                   transaction_source not null default 'manual',
  reference_no             text,
  import_id                uuid,             -- FK added after imports exists
  linked_transaction_id    uuid references public.transactions(id) on delete set null,
  exclude_from_analytics   boolean not null default false,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- Amount is a magnitude; direction lives in `kind`.
  constraint transactions_amount_positive check (amount >= 0),
  constraint transactions_value_date_sane check (
    value_date is null or value_date between date - interval '90 days' and date + interval '90 days'
  ),
  -- A transfer must say where the money went, or it cannot be reconciled.
  constraint transactions_transfer_has_counterparty check (
    kind not in ('transfer', 'cc_payment') or counterparty_account_id is not null or account_id is null
  ),
  constraint transactions_no_self_transfer check (
    counterparty_account_id is null or account_id is null or counterparty_account_id <> account_id
  ),
  constraint transactions_not_self_linked check (
    linked_transaction_id is null or linked_transaction_id <> id
  )
);

-- The dominant query: "all of this user's transactions in a cycle, newest first".
create index transactions_user_date_idx on public.transactions (user_id, date desc, created_at desc);
create index transactions_user_category_idx on public.transactions (user_id, category_id, date desc);
create index transactions_user_merchant_idx on public.transactions (user_id, merchant_key, date desc);
create index transactions_user_account_idx on public.transactions (user_id, account_id, date desc);
create index transactions_user_kind_idx on public.transactions (user_id, kind, date desc);
create index transactions_user_recurring_idx on public.transactions (user_id, is_recurring) where is_recurring;
create index transactions_import_idx on public.transactions (import_id) where import_id is not null;
-- Duplicate detection probes (user, amount, date) constantly.
create index transactions_dedupe_idx on public.transactions (user_id, amount, date);
create index transactions_reference_idx on public.transactions (user_id, reference_no) where reference_no is not null;
-- Free-text search over descriptions.
create index transactions_description_trgm_idx on public.transactions using gin (description gin_trgm_ops);

create trigger transactions_touch before update on public.transactions
  for each row execute function public.touch_updated_at();

-- Referenced rows must belong to the same user. Without this, a crafted request
-- could attach another user's category or account id to its own transaction.
create or replace function public.assert_transaction_refs_same_user()
returns trigger
language plpgsql
as $$
begin
  if new.category_id is not null
     and not exists (select 1 from public.categories c where c.id = new.category_id and c.user_id = new.user_id) then
    raise exception 'Category does not belong to this user';
  end if;
  if new.account_id is not null
     and not exists (select 1 from public.accounts a where a.id = new.account_id and a.user_id = new.user_id) then
    raise exception 'Account does not belong to this user';
  end if;
  if new.counterparty_account_id is not null
     and not exists (select 1 from public.accounts a where a.id = new.counterparty_account_id and a.user_id = new.user_id) then
    raise exception 'Counterparty account does not belong to this user';
  end if;
  if new.linked_transaction_id is not null
     and not exists (select 1 from public.transactions t where t.id = new.linked_transaction_id and t.user_id = new.user_id) then
    raise exception 'Linked transaction does not belong to this user';
  end if;
  return new;
end;
$$;

create trigger transactions_refs_same_user
  before insert or update on public.transactions
  for each row execute function public.assert_transaction_refs_same_user();

-- ---------------------------------------------------------------------------
-- income_records — salary and other income, kept separately from the ledger so
-- expected vs actual can be compared even before a bank statement is imported
-- ---------------------------------------------------------------------------

create table public.income_records (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  date           date not null,
  amount         bigint not null,
  kind           income_kind not null default 'salary',
  source         text not null default '',
  account_id     uuid references public.accounts(id) on delete set null,
  transaction_id uuid references public.transactions(id) on delete set null,
  notes          text,
  is_recurring   boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint income_amount_positive check (amount > 0)
);

create index income_user_date_idx on public.income_records (user_id, date desc);

create trigger income_touch before update on public.income_records
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- budgets — revisable, with an effective window so history stays honest
-- ---------------------------------------------------------------------------

create table public.budgets (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  category_id    uuid references public.categories(id) on delete cascade,  -- null = overall
  amount         bigint not null,
  period         budget_period not null default 'cycle',
  effective_from date not null default current_date,
  effective_to   date,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint budgets_amount_non_negative check (amount >= 0),
  constraint budgets_window_ordered check (effective_to is null or effective_to >= effective_from)
);

-- At most one live budget per category (and one overall) at a time.
create unique index budgets_active_category_idx
  on public.budgets (user_id, category_id) where is_active and category_id is not null;
create unique index budgets_active_overall_idx
  on public.budgets (user_id) where is_active and category_id is null;

create trigger budgets_touch before update on public.budgets
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- recurring_expenses
-- ---------------------------------------------------------------------------

create table public.recurring_expenses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  name           text not null,
  merchant_key   text,
  category_id    uuid references public.categories(id) on delete set null,
  amount         bigint not null,
  interval       recurrence_interval not null default 'monthly',
  day_of_period  smallint,
  next_due_date  date,
  last_seen_date date,
  account_id     uuid references public.accounts(id) on delete set null,
  payment_method payment_method,
  is_essential   boolean not null default false,
  is_active      boolean not null default true,
  auto_detected  boolean not null default false,
  confidence     real not null default 1.0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint recurring_amount_positive check (amount > 0),
  constraint recurring_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint recurring_day_of_period check (day_of_period is null or day_of_period between 1 and 31)
);

create index recurring_user_idx on public.recurring_expenses (user_id) where is_active;
create unique index recurring_user_merchant_idx
  on public.recurring_expenses (user_id, merchant_key) where merchant_key is not null and is_active;

create trigger recurring_touch before update on public.recurring_expenses
  for each row execute function public.touch_updated_at();

alter table public.transactions
  add constraint transactions_recurring_fk
  foreign key (recurring_expense_id) references public.recurring_expenses(id) on delete set null;

-- ---------------------------------------------------------------------------
-- financial_goals
-- ---------------------------------------------------------------------------

create table public.financial_goals (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  name                 text not null,
  kind                 goal_kind not null default 'other',
  target_amount        bigint not null,
  current_amount       bigint not null default 0,
  target_date          date,
  monthly_contribution bigint not null default 0,
  is_active            boolean not null default true,
  color                text not null default '#22C55E',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint goals_target_positive        check (target_amount > 0),
  constraint goals_current_non_negative   check (current_amount >= 0),
  constraint goals_contribution_non_negative check (monthly_contribution >= 0),
  constraint goals_name_not_blank         check (length(btrim(name)) > 0)
);

create index goals_user_idx on public.financial_goals (user_id) where is_active;

create trigger goals_touch before update on public.financial_goals
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- merchant_mappings — the learned "Amazon means Electronics for me" rules
-- ---------------------------------------------------------------------------

create table public.merchant_mappings (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  merchant_key           text not null,
  display_name           text not null default '',
  category_id            uuid not null references public.categories(id) on delete cascade,
  origin                 mapping_origin not null default 'user',
  confirmations          integer not null default 1,
  is_essential           boolean,
  default_payment_method payment_method,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint mappings_key_not_blank check (length(btrim(merchant_key)) > 0),
  constraint mappings_confirmations_non_negative check (confirmations >= 0),
  unique (user_id, merchant_key)
);

create index mappings_user_idx on public.merchant_mappings (user_id);

create trigger mappings_touch before update on public.merchant_mappings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- imports and staged rows
-- ---------------------------------------------------------------------------

create table public.imports (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  kind               import_kind not null,
  file_name          text not null default '',
  -- Path inside the PRIVATE `statements` bucket. Never a public URL.
  storage_path       text,
  status             import_status not null default 'uploading',
  detected_count     integer not null default 0,
  accepted_count     integer not null default 0,
  rejected_count     integer not null default 0,
  needs_review_count integer not null default 0,
  duplicate_count    integer not null default 0,
  parser_id          text,
  error_message      text,
  account_id         uuid references public.accounts(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  committed_at       timestamptz,

  constraint imports_counts_non_negative check (
    detected_count >= 0 and accepted_count >= 0 and rejected_count >= 0
    and needs_review_count >= 0 and duplicate_count >= 0
  )
);

create index imports_user_idx on public.imports (user_id, created_at desc);

create trigger imports_touch before update on public.imports
  for each row execute function public.touch_updated_at();

alter table public.transactions
  add constraint transactions_import_fk
  foreign key (import_id) references public.imports(id) on delete set null;

-- Candidate rows awaiting review. Nothing here affects any calculation until it is
-- promoted into `transactions`.
create table public.import_transactions (
  id                       uuid primary key default gen_random_uuid(),
  import_id                uuid not null references public.imports(id) on delete cascade,
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  row_index                integer not null default 0,
  raw_text                 text,

  date                     date,
  amount                   bigint,
  description              text not null default '',
  merchant_raw             text,
  merchant_key             text,
  merchant_name            text,
  kind                     transaction_kind not null default 'expense',
  category_id              uuid references public.categories(id) on delete set null,
  payment_method           payment_method,
  account_id               uuid references public.accounts(id) on delete set null,
  reference_no             text,

  confidence               real not null default 0.5,
  warnings                 text[] not null default '{}',
  status                   staged_status not null default 'pending',
  duplicate_of_transaction_id uuid references public.transactions(id) on delete set null,
  duplicate_of_staged_id      uuid references public.import_transactions(id) on delete set null,
  committed_transaction_id    uuid references public.transactions(id) on delete set null,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint staged_amount_positive check (amount is null or amount >= 0),
  constraint staged_confidence_range check (confidence >= 0 and confidence <= 1)
);

create index staged_import_idx on public.import_transactions (import_id, row_index);
create index staged_user_status_idx on public.import_transactions (user_id, status);

create trigger staged_touch before update on public.import_transactions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- salary_cycles — closed cycles are materialised so a later change to the payday
-- cannot silently rewrite a report the user has already read. Live cycles are
-- derived on the client from the profile's cycle configuration.
-- ---------------------------------------------------------------------------

create table public.salary_cycles (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  start_date           date not null,
  end_date             date not null,
  total_days           smallint not null,

  income               bigint not null default 0,
  total_spend          bigint not null default 0,
  essential_spend      bigint not null default 0,
  discretionary_spend  bigint not null default 0,
  fixed_commitments    bigint not null default 0,
  invested             bigint not null default 0,
  savings              bigint not null default 0,
  savings_rate         real,
  health_score         smallint,
  closed_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint cycles_dates_ordered check (end_date >= start_date),
  constraint cycles_health_range check (health_score is null or health_score between 0 and 100),
  unique (user_id, start_date)
);

create index cycles_user_idx on public.salary_cycles (user_id, start_date desc);

create trigger cycles_touch before update on public.salary_cycles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- insights — generated observations, persisted so they can be dismissed
-- ---------------------------------------------------------------------------

create table public.insights (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  cycle_start  date not null,
  kind         text not null,
  severity     insight_severity not null default 'neutral',
  title        text not null,
  detail       text not null,
  action       text,
  priority     integer not null default 0,
  category_id  uuid references public.categories(id) on delete set null,
  merchant_key text,
  -- Stable hash of (kind, cycle, subject) so regenerating does not duplicate rows.
  fingerprint  text not null,
  dismissed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (user_id, fingerprint)
);

create index insights_user_cycle_idx on public.insights (user_id, cycle_start desc, priority desc)
  where dismissed_at is null;

create trigger insights_touch before update on public.insights
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------

create table public.notification_preferences (
  user_id                     uuid primary key references public.profiles(id) on delete cascade,
  enabled                     boolean not null default true,
  budget_warning              boolean not null default true,
  budget_exceeded             boolean not null default true,
  pace_warning                boolean not null default true,
  large_transaction           boolean not null default true,
  large_transaction_threshold bigint  not null default 500000, -- ₹5,000
  unusual_transaction         boolean not null default true,
  savings_risk                boolean not null default true,
  recurring_detected          boolean not null default true,
  salary_received             boolean not null default true,
  cycle_summary               boolean not null default true,
  quiet_hours_start           smallint,
  quiet_hours_end             smallint,
  expo_push_token             text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint notif_threshold_non_negative check (large_transaction_threshold >= 0),
  constraint notif_quiet_start check (quiet_hours_start is null or quiet_hours_start between 0 and 23),
  constraint notif_quiet_end   check (quiet_hours_end   is null or quiet_hours_end   between 0 and 23)
);

create trigger notif_touch before update on public.notification_preferences
  for each row execute function public.touch_updated_at();
