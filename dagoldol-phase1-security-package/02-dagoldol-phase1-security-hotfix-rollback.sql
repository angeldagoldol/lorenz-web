-- ============================================================================
-- DAGOLDOL — PHASE 1 SECURITY HOTFIX ROLLBACK
-- File: 02-dagoldol-phase1-security-hotfix-rollback.sql
--
-- WARNING:
--   This rollback intentionally REMOVES protections installed by
--   01-dagoldol-phase1-security-hotfix.sql and restores the supplied schema's
--   original public.is_admin() definition. Use only to recover from a verified
--   regression while you prepare a corrected migration.
-- ============================================================================

begin;

drop trigger if exists orders_guard_customer_write on public.orders;
drop function if exists public.guard_customer_order_write();

drop trigger if exists profiles_guard_role_client on public.profiles;
drop function if exists public.guard_profile_role_client();

-- Restore the exact behavior of the supplied schema helper.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists(
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

commit;

-- SECURITY NOTE:
-- After this rollback, the supplied "update own profile" RLS policy once again
-- allows an authenticated customer to change their own role to 'admin'.
