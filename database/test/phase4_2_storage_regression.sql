-- ============================================================================
-- DAGOLDOL PHASE 4.2A2 — STORAGE POLICY STRUCTURAL REGRESSION
-- READ ONLY.
--
-- Run only AFTER applying docs/phase4/PHASE4.2-STORAGE-POLICY-UI-CHECKLIST.md
-- in Supabase Dashboard -> Storage -> Policies -> OBJECTS.
--
-- This test intentionally does not require every safe legacy policy to be
-- renamed. It verifies the actual zero-trust Storage security outcomes.
-- Runtime cross-account object tests are in scripts/phase4-2-storage-runtime.mjs.
-- ============================================================================

do $$
declare
  v_count integer;
  v_bucket text;
  v_cmd text;
begin
  -- Private payment evidence must remain a private bucket.
  if not exists (
    select 1 from storage.buckets
    where id='payment-proofs' and public=false
  ) then
    raise exception 'FAIL: payment-proofs bucket is not private.';
  end if;

  -- Public storefront media must remain publicly deliverable; this does not
  -- grant mutation/listing because those are still governed by Storage/RLS.
  if exists (
    select 1 from storage.buckets
    where id in ('avatars','brand-logos','payment-settings','product-images')
      and public is distinct from true
  ) then
    raise exception 'FAIL: one or more intended public media buckets are not public.';
  end if;

  -- The known broad/bypass policies from the live baseline must be gone.
  if exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname = any(array[
        'storage_public_read',
        'storage_avatar_upload_own',
        'storage_payment_proof_upload_own',
        'storage_admin_delete',
        'storage_admin_manage',
        'storage_admin_upload'
      ])
  ) then
    raise exception 'FAIL: one or more broad legacy Storage bypass policies remain.';
  end if;

  -- No anonymous/public SELECT policy may include private payment proofs.
  if exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and cmd='SELECT'
      and (
        roles @> array['public']::name[]
        or roles @> array['anon']::name[]
      )
      and coalesce(qual,'') ilike '%payment-proofs%'
  ) then
    raise exception 'FAIL: anonymous/public Storage SELECT still exposes payment-proofs.';
  end if;

  -- No anonymous/public upload policy may target user-owned private namespaces.
  if exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and cmd='INSERT'
      and (
        roles @> array['public']::name[]
        or roles @> array['anon']::name[]
      )
      and (
        coalesce(with_check,'') ilike '%avatars%'
        or coalesce(with_check,'') ilike '%payment-proofs%'
      )
  ) then
    raise exception 'FAIL: public/anonymous upload policy targets avatars or payment-proofs.';
  end if;

  -- Avatar owner upload must be path-bound to the authenticated user.
  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and cmd='INSERT'
      and roles @> array['authenticated']::name[]
      and coalesce(with_check,'') ilike '%avatars%'
      and coalesce(with_check,'') ilike '%auth.uid()%'
      and (
        coalesce(with_check,'') ilike '%split_part%'
        or coalesce(with_check,'') ilike '%foldername%'
      )
  ) then
    raise exception 'FAIL: authenticated avatar owner INSERT policy is missing or not namespace-bound.';
  end if;

  -- Avatar SELECT is needed for safe upsert/metadata return while remaining
  -- constrained to the caller's namespace.
  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='p42_storage_avatar_owner_read'
      and cmd='SELECT'
      and roles @> array['authenticated']::name[]
      and coalesce(qual,'') ilike '%avatars%'
      and coalesce(qual,'') ilike '%auth.uid()%'
  ) then
    raise exception 'FAIL: p42_storage_avatar_owner_read is missing or malformed.';
  end if;

  -- Payment-proof owner/admin read must be private and authenticated.
  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and cmd='SELECT'
      and roles @> array['authenticated']::name[]
      and coalesce(qual,'') ilike '%payment-proofs%'
      and coalesce(qual,'') ilike '%auth.uid()%'
      and coalesce(qual,'') ilike '%is_admin()%'
  ) then
    raise exception 'FAIL: private payment-proof owner/admin read policy is missing.';
  end if;

  -- Payment-proof INSERT must be owner namespace-bound.
  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and cmd='INSERT'
      and roles @> array['authenticated']::name[]
      and coalesce(with_check,'') ilike '%payment-proofs%'
      and coalesce(with_check,'') ilike '%auth.uid()%'
      and (
        coalesce(with_check,'') ilike '%split_part%'
        or coalesce(with_check,'') ilike '%foldername%'
      )
  ) then
    raise exception 'FAIL: payment-proof owner INSERT policy is missing or not namespace-bound.';
  end if;

  -- Safe owner overwrite path for payment proofs.
  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='p42_storage_payment_proof_owner_update'
      and cmd='UPDATE'
      and roles @> array['authenticated']::name[]
      and coalesce(qual,'') ilike '%payment-proofs%'
      and coalesce(qual,'') ilike '%auth.uid()%'
      and coalesce(with_check,'') ilike '%payment-proofs%'
      and coalesce(with_check,'') ilike '%auth.uid()%'
  ) then
    raise exception 'FAIL: p42_storage_payment_proof_owner_update is missing or malformed.';
  end if;

  -- Admin needs SELECT for Storage upsert/metadata return on public admin media.
  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='p42_storage_admin_media_read'
      and cmd='SELECT'
      and roles @> array['authenticated']::name[]
      and coalesce(qual,'') ilike '%brand-logos%'
      and coalesce(qual,'') ilike '%payment-settings%'
      and coalesce(qual,'') ilike '%product-images%'
      and coalesce(qual,'') ilike '%is_admin()%'
  ) then
    raise exception 'FAIL: p42_storage_admin_media_read is missing or malformed.';
  end if;

  -- Existing admin media INSERT/UPDATE/DELETE paths must all remain admin-gated.
  foreach v_bucket in array array['brand-logos','payment-settings','product-images']
  loop
    foreach v_cmd in array array['INSERT','UPDATE','DELETE']
    loop
      select count(*) into v_count
      from pg_policies
      where schemaname='storage' and tablename='objects'
        and cmd=v_cmd
        and roles @> array['authenticated']::name[]
        and (
          coalesce(qual,'') ilike '%' || v_bucket || '%'
          or coalesce(with_check,'') ilike '%' || v_bucket || '%'
        )
        and (
          coalesce(qual,'') ilike '%is_admin()%'
          or coalesce(with_check,'') ilike '%is_admin()%'
        );

      if v_count < 1 then
        raise exception 'FAIL: % has no authenticated admin-gated % Storage policy.', v_bucket, v_cmd;
      end if;
    end loop;
  end loop;
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
