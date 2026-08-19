-- ============================================================================
-- DAGOLDOL PHASE 4.2A — STORAGE POLICY STRUCTURAL REGRESSION
-- READ ONLY. Run after the 4.2A migration on staging.
-- Runtime cross-account object tests are in scripts/phase4-2-storage-runtime.mjs.
-- ============================================================================

do $$
declare
  v_count integer;
begin
  if not exists (
    select 1 from storage.buckets
    where id='payment-proofs' and public=false
  ) then
    raise exception 'FAIL: payment-proofs bucket is not private.';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname not like 'p42\_%' escape '\'
  ) then
    raise exception 'FAIL: non-Phase-4.2 storage.objects policies remain.';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and cmd='SELECT' and roles @> array['anon']::name[]
  ) then
    raise exception 'FAIL: anonymous storage.objects SELECT policy remains.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='p42_storage_payment_proof_owner_admin_read'
      and cmd='SELECT'
      and coalesce(qual,'') ilike '%payment-proofs%'
      and coalesce(qual,'') ilike '%split_part%auth.uid()%'
      and coalesce(qual,'') ilike '%is_admin()%'
  ) then
    raise exception 'FAIL: private payment-proof owner/admin read policy missing.';
  end if;

  select count(*) into v_count
  from pg_policies
  where schemaname='storage' and tablename='objects'
    and policyname in (
      'p42_storage_payment_proof_owner_admin_read',
      'p42_storage_payment_proof_owner_insert',
      'p42_storage_payment_proof_owner_update',
      'p42_storage_payment_proof_owner_delete'
    );
  if v_count <> 4 then
    raise exception 'FAIL: expected four payment-proof policies, found %.', v_count;
  end if;

  select count(*) into v_count
  from pg_policies
  where schemaname='storage' and tablename='objects'
    and policyname in (
      'p42_storage_avatar_owner_read',
      'p42_storage_avatar_owner_insert',
      'p42_storage_avatar_owner_update',
      'p42_storage_avatar_owner_delete'
    );
  if v_count <> 4 then
    raise exception 'FAIL: expected four avatar owner policies, found %.', v_count;
  end if;

  select count(*) into v_count
  from pg_policies
  where schemaname='storage' and tablename='objects'
    and policyname in (
      'p42_storage_admin_media_read',
      'p42_storage_admin_media_insert',
      'p42_storage_admin_media_update',
      'p42_storage_admin_media_delete'
    );
  if v_count <> 4 then
    raise exception 'FAIL: expected four admin-media policies, found %.', v_count;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname like 'p42_storage_payment_proof%'
      and coalesce(qual,'') not ilike '%payment-proofs%'
      and coalesce(with_check,'') not ilike '%payment-proofs%'
  ) then
    raise exception 'FAIL: payment-proof policy is not bucket-scoped.';
  end if;
end
$$;

select id,name,public,file_size_limit,allowed_mime_types
from storage.buckets
where id in ('avatars','brand-logos','payment-proofs','payment-settings','product-images')
order by id;

select policyname,roles,cmd,qual,with_check
from pg_policies
where schemaname='storage' and tablename='objects'
order by policyname;

-- PASS: DO block completes without exception.
