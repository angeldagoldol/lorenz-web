# Dagoldol Phase 4.2A2 — Storage Policy UI Checklist

**Target:** Supabase hosted project `rvrjkfbenramappteuae`  
**Scope:** `Storage -> Policies -> OBJECTS` only  
**Why this is separate:** the live hosted project owns `storage.objects` and `storage.buckets` with the managed `supabase_storage_admin` role, while SQL Editor runs as `postgres`. The failed combined migration produced `ERROR: must be owner of table objects`. Do not change ownership. Do not grant `postgres` membership in `supabase_storage_admin`.

The Storage schema itself is managed by Supabase. Do not run `ALTER TABLE storage.objects ...` and do not delete Storage metadata rows directly.

## Precondition

Confirm the buckets are still exactly:

- `avatars` — public
- `brand-logos` — public
- `payment-proofs` — private
- `payment-settings` — public
- `product-images` — public

## Step 1 — Delete only the six unsafe/redundant legacy policies

In **Storage -> Policies -> OBJECTS**, delete these policy names exactly:

1. `storage_public_read`
2. `storage_avatar_upload_own`
3. `storage_payment_proof_upload_own`
4. `storage_admin_delete`
5. `storage_admin_manage`
6. `storage_admin_upload`

Why these six:

- `storage_public_read` includes the private `payment-proofs` bucket and is the confirmed payment-proof exposure.
- `storage_avatar_upload_own` allows any authenticated user to insert anywhere in the avatars bucket without enforcing their own user folder.
- `storage_payment_proof_upload_own` has the same namespace-bypass problem for payment proofs.
- the three `storage_admin_*` policies are redundant broad-role policies; the existing `dagoldol admin ...` policies already provide authenticated admin-gated media management.

Keep the existing policies whose names begin with `dagoldol ...`; the live inspection shows those policies are already owner/admin scoped and are used as the secure baseline.

## Step 2 — Add `p42_storage_avatar_owner_read`

Create a new policy on **OBJECTS**:

- Name: `p42_storage_avatar_owner_read`
- Operation: `SELECT`
- Target roles: `authenticated`
- USING expression:

```sql
bucket_id = 'avatars'
and (storage.foldername(name))[1] = (select auth.uid()::text)
```

Purpose: Storage upsert/metadata return requires SELECT while keeping metadata access inside the signed-in user's own avatar namespace. The bucket remains public for normal public object delivery.

## Step 3 — Add `p42_storage_payment_proof_owner_update`

Create a new policy on **OBJECTS**:

- Name: `p42_storage_payment_proof_owner_update`
- Operation: `UPDATE`
- Target roles: `authenticated`
- USING expression:

```sql
bucket_id = 'payment-proofs'
and (storage.foldername(name))[1] = (select auth.uid()::text)
```

- WITH CHECK expression:

```sql
bucket_id = 'payment-proofs'
and (storage.foldername(name))[1] = (select auth.uid()::text)
```

Purpose: permits an authenticated customer to overwrite only a payment-proof object in their own namespace. It does not permit cross-account proof access.

## Step 4 — Add `p42_storage_admin_media_read`

Create a new policy on **OBJECTS**:

- Name: `p42_storage_admin_media_read`
- Operation: `SELECT`
- Target roles: `authenticated`
- USING expression:

```sql
bucket_id in ('brand-logos','payment-settings','product-images')
and (select public.is_admin())
```

Purpose: admin Storage upsert/metadata return requires SELECT. Public object delivery for these public buckets remains handled by Supabase Storage; this policy does not grant customer writes.

## Step 5 — Do not recreate a broad public Storage SELECT policy

Do **not** create a policy equivalent to:

```sql
bucket_id in ('product-images','brand-logos','avatars','payment-proofs','payment-settings')
```

for `public` or `anon`. The private `payment-proofs` bucket must never be included in a public/anonymous SELECT policy.

## Step 6 — Verify

Run the read-only file:

`database/tests/phase4_2_storage_regression.sql`

Expected result: the `DO` block completes without exception.

Then, on an isolated staging project only, run:

`scripts/phase4-2-storage-runtime.mjs`

with `P42_ALLOW_STORAGE_TESTS=staging-only-confirmed` and the required staging JWTs.

## Rollback reference

If any UI-created policy causes a staging regression, delete only the three new `p42_storage_*` policies created above and restore the prior Storage-policy snapshot from Phase 4.1 evidence. Do not restore `storage_public_read` or the two broad user upload policies unless a security review explicitly proves a replacement boundary first.
