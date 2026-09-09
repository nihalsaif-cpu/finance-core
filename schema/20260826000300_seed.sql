-- ============================================================================
-- New-user bootstrap and data lifecycle
--
-- The category list below is GENERATED from src/core/categories.ts by
-- scripts/generate-category-seed.ts, and a unit test asserts the two stay in sync.
-- Edit the TypeScript, regenerate, never hand-edit the rows.
-- ============================================================================

create or replace function public.seed_default_categories(target_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  seed record;
  parent_lookup jsonb := '{}'::jsonb;
  new_id uuid;
begin
  for seed in
    select * from (values
    ('housing', null, 'Housing', 'expense'::category_kind, 'essential'::category_classification, 'home', '#4C6FFF', 0),
    ('rent', 'housing', 'Rent', 'expense'::category_kind, 'essential'::category_classification, 'key', '#4C6FFF', 1),
    ('electricity', 'housing', 'Electricity', 'expense'::category_kind, 'essential'::category_classification, 'zap', '#5B7CFF', 2),
    ('water', 'housing', 'Water', 'expense'::category_kind, 'essential'::category_classification, 'droplet', '#6A88FF', 3),
    ('internet', 'housing', 'Internet', 'expense'::category_kind, 'essential'::category_classification, 'wifi', '#7994FF', 4),
    ('maintenance', 'housing', 'Maintenance', 'expense'::category_kind, 'essential'::category_classification, 'tool', '#88A0FF', 5),
    ('food', null, 'Food', 'expense'::category_kind, 'mixed'::category_classification, 'utensils', '#FF8A4C', 100),
    ('groceries', 'food', 'Groceries', 'expense'::category_kind, 'essential'::category_classification, 'shopping-basket', '#FF8A4C', 101),
    ('restaurants', 'food', 'Restaurants', 'expense'::category_kind, 'discretionary'::category_classification, 'utensils', '#FF9A64', 102),
    ('food_delivery', 'food', 'Food Delivery', 'expense'::category_kind, 'discretionary'::category_classification, 'bike', '#FFAA7C', 103),
    ('coffee_snacks', 'food', 'Coffee & Snacks', 'expense'::category_kind, 'discretionary'::category_classification, 'coffee', '#FFBA94', 104),
    ('transportation', null, 'Transportation', 'expense'::category_kind, 'mixed'::category_classification, 'car', '#26C6A6', 200),
    ('fuel', 'transportation', 'Fuel', 'expense'::category_kind, 'essential'::category_classification, 'fuel', '#26C6A6', 201),
    ('taxi', 'transportation', 'Taxi & Ride Hailing', 'expense'::category_kind, 'mixed'::category_classification, 'car-taxi-front', '#3ACFB2', 202),
    ('public_transport', 'transportation', 'Public Transport', 'expense'::category_kind, 'essential'::category_classification, 'train', '#4ED8BE', 203),
    ('parking', 'transportation', 'Parking & Tolls', 'expense'::category_kind, 'mixed'::category_classification, 'parking-circle', '#62E1CA', 204),
    ('vehicle_maintenance', 'transportation', 'Vehicle Maintenance', 'expense'::category_kind, 'essential'::category_classification, 'wrench', '#76EAD6', 205),
    ('shopping', null, 'Shopping', 'expense'::category_kind, 'discretionary'::category_classification, 'shopping-bag', '#B45CFF', 300),
    ('clothing', 'shopping', 'Clothing', 'expense'::category_kind, 'discretionary'::category_classification, 'shirt', '#B45CFF', 301),
    ('electronics', 'shopping', 'Electronics', 'expense'::category_kind, 'discretionary'::category_classification, 'smartphone', '#BE70FF', 302),
    ('personal_items', 'shopping', 'Personal Items', 'expense'::category_kind, 'mixed'::category_classification, 'sparkles', '#C884FF', 303),
    ('online_shopping', 'shopping', 'Online Shopping', 'expense'::category_kind, 'discretionary'::category_classification, 'package', '#D298FF', 304),
    ('lifestyle', null, 'Lifestyle', 'expense'::category_kind, 'discretionary'::category_classification, 'party-popper', '#FF5C8A', 400),
    ('entertainment', 'lifestyle', 'Entertainment', 'expense'::category_kind, 'discretionary'::category_classification, 'clapperboard', '#FF5C8A', 401),
    ('hobbies', 'lifestyle', 'Hobbies', 'expense'::category_kind, 'discretionary'::category_classification, 'palette', '#FF7099', 402),
    ('travel', 'lifestyle', 'Travel', 'expense'::category_kind, 'discretionary'::category_classification, 'plane', '#FF84A8', 403),
    ('gym', 'lifestyle', 'Gym & Fitness', 'expense'::category_kind, 'discretionary'::category_classification, 'dumbbell', '#FF98B7', 404),
    ('events', 'lifestyle', 'Events', 'expense'::category_kind, 'discretionary'::category_classification, 'ticket', '#FFACC6', 405),
    ('bills', null, 'Bills & Subscriptions', 'expense'::category_kind, 'essential'::category_classification, 'receipt', '#F2B705', 500),
    ('mobile', 'bills', 'Mobile', 'expense'::category_kind, 'essential'::category_classification, 'smartphone', '#F2B705', 501),
    ('streaming', 'bills', 'Streaming', 'expense'::category_kind, 'discretionary'::category_classification, 'tv', '#F5C227', 502),
    ('software', 'bills', 'Software', 'expense'::category_kind, 'mixed'::category_classification, 'app-window', '#F7CD49', 503),
    ('insurance', 'bills', 'Insurance', 'expense'::category_kind, 'essential'::category_classification, 'shield', '#F9D86B', 504),
    ('other_subscriptions', 'bills', 'Other Subscriptions', 'expense'::category_kind, 'discretionary'::category_classification, 'repeat', '#FBE38D', 505),
    ('financial', null, 'Financial', 'expense'::category_kind, 'essential'::category_classification, 'landmark', '#5B8DEF', 600),
    ('emi', 'financial', 'EMI', 'expense'::category_kind, 'essential'::category_classification, 'calendar-clock', '#5B8DEF', 601),
    ('credit_card_payment', 'financial', 'Credit Card Payment', 'transfer'::category_kind, 'essential'::category_classification, 'credit-card', '#6F9BF1', 602),
    ('loan', 'financial', 'Loan', 'expense'::category_kind, 'essential'::category_classification, 'banknote', '#83A9F3', 603),
    ('investment', 'financial', 'Investment', 'savings'::category_kind, 'essential'::category_classification, 'trending-up', '#97B7F5', 604),
    ('savings', 'financial', 'Savings', 'savings'::category_kind, 'essential'::category_classification, 'piggy-bank', '#ABC5F7', 605),
    ('bank_fees', 'financial', 'Bank Fees & Charges', 'expense'::category_kind, 'essential'::category_classification, 'percent', '#BFD3F9', 606),
    ('healthcare', null, 'Healthcare', 'expense'::category_kind, 'essential'::category_classification, 'heart-pulse', '#EF5B5B', 700),
    ('doctor', 'healthcare', 'Doctor', 'expense'::category_kind, 'essential'::category_classification, 'stethoscope', '#EF5B5B', 701),
    ('medicine', 'healthcare', 'Medicine', 'expense'::category_kind, 'essential'::category_classification, 'pill', '#F16F6F', 702),
    ('health_insurance', 'healthcare', 'Health Insurance', 'expense'::category_kind, 'essential'::category_classification, 'shield-plus', '#F38383', 703),
    ('education', null, 'Education', 'expense'::category_kind, 'essential'::category_classification, 'graduation-cap', '#00A6A6', 800),
    ('courses', 'education', 'Courses', 'expense'::category_kind, 'mixed'::category_classification, 'book-open', '#00A6A6', 801),
    ('books', 'education', 'Books', 'expense'::category_kind, 'mixed'::category_classification, 'book', '#22B5B5', 802),
    ('tuition', 'education', 'Tuition & Fees', 'expense'::category_kind, 'essential'::category_classification, 'school', '#44C4C4', 803),
    ('people', null, 'People & Gifts', 'expense'::category_kind, 'mixed'::category_classification, 'gift', '#C77DFF', 900),
    ('family_support', 'people', 'Family Support', 'expense'::category_kind, 'essential'::category_classification, 'users', '#C77DFF', 901),
    ('gifts', 'people', 'Gifts', 'expense'::category_kind, 'discretionary'::category_classification, 'gift', '#D191FF', 902),
    ('charity', 'people', 'Charity', 'expense'::category_kind, 'discretionary'::category_classification, 'hand-heart', '#DBA5FF', 903),
    ('household_help', 'people', 'Household Help', 'expense'::category_kind, 'essential'::category_classification, 'user-check', '#E5B9FF', 904),
    ('income', null, 'Income', 'income'::category_kind, 'essential'::category_classification, 'wallet', '#22C55E', 1000),
    ('salary', 'income', 'Salary', 'income'::category_kind, 'essential'::category_classification, 'briefcase', '#22C55E', 1001),
    ('bonus', 'income', 'Bonus', 'income'::category_kind, 'essential'::category_classification, 'award', '#3ACF70', 1002),
    ('freelance', 'income', 'Freelance', 'income'::category_kind, 'essential'::category_classification, 'laptop', '#52D982', 1003),
    ('interest_income', 'income', 'Interest & Dividends', 'income'::category_kind, 'essential'::category_classification, 'coins', '#6AE394', 1004),
    ('other_income', 'income', 'Other Income', 'income'::category_kind, 'essential'::category_classification, 'plus-circle', '#82EDA6', 1005),
    ('transfers', null, 'Transfers', 'transfer'::category_kind, 'essential'::category_classification, 'arrow-left-right', '#8A94A6', 1100),
    ('self_transfer', 'transfers', 'Between My Accounts', 'transfer'::category_kind, 'essential'::category_classification, 'repeat', '#8A94A6', 1101),
    ('cash_withdrawal', 'transfers', 'Cash Withdrawal', 'transfer'::category_kind, 'essential'::category_classification, 'banknote', '#98A2B3', 1102),
    ('other', null, 'Other', 'expense'::category_kind, 'discretionary'::category_classification, 'circle-help', '#8A94A6', 1200)
    ) as t(slug, parent_slug, name, kind, classification, icon, color, sort_order)
    order by sort_order
  loop
    insert into public.categories (user_id, parent_id, name, slug, kind, classification, icon, color, is_system, sort_order)
    values (
      target_user,
      case when seed.parent_slug is null then null
           else (parent_lookup ->> seed.parent_slug)::uuid end,
      seed.name, seed.slug, seed.kind, seed.classification, seed.icon, seed.color, true, seed.sort_order
    )
    on conflict (user_id, slug) do nothing
    returning id into new_id;

    if new_id is null then
      select id into new_id from public.categories where user_id = target_user and slug = seed.slug;
    end if;

    parent_lookup := parent_lookup || jsonb_build_object(seed.slug, new_id::text);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bootstrap: profile + categories + notification preferences on signup.
--
-- Runs as a trigger on auth.users rather than from the client, so a user's account
-- is never left half-created if the app is closed during onboarding.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;

  insert into public.notification_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  perform public.seed_default_categories(new.id);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Import rollback — undo a committed import in one transaction.
--
-- Only removes transactions this import created; anything the user has since
-- edited by hand keeps its import_id, so we check that nothing else references it.
-- ---------------------------------------------------------------------------

create or replace function public.rollback_import(target_import uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  removed integer;
begin
  -- RLS applies (security invoker), so a caller can only ever roll back their own.
  delete from public.transactions
   where import_id = target_import
     and user_id = (select auth.uid());
  get diagnostics removed = row_count;

  update public.import_transactions
     set status = 'pending', committed_transaction_id = null
   where import_id = target_import
     and user_id = (select auth.uid());

  update public.imports
     set status = 'rolled_back', accepted_count = 0, committed_at = null
   where id = target_import
     and user_id = (select auth.uid());

  return removed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Full account deletion (§26). Cascades handle every owned table; this also
-- removes uploaded statement files, which cascades cannot reach.
-- ---------------------------------------------------------------------------

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'Not authenticated';
  end if;

  delete from storage.objects
   where bucket_id = 'statements'
     and (storage.foldername(name))[1] = me::text;

  -- profiles cascades to every owned table, and auth.users cascades to profiles.
  delete from auth.users where id = me;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
grant execute on function public.rollback_import(uuid) to authenticated;
revoke all on function public.seed_default_categories(uuid) from public, anon;
