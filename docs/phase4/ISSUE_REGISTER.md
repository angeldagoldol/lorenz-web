# Dagoldol Phase 4 — Issue Register

Status reflects the 3.3.5 source baseline. Items requiring live DB evidence remain **UNVERIFIED**, not assumed vulnerable or safe.

| ID | Priority | Severity | Finding | Evidence / root cause | Impact | Phase / disposition |
|---|---|---|---|---|---|---|
| P4-001 | P0 | Critical | Browser-authoritative checkout | `script.js` computes item prices, subtotal, promo, delivery/bulk fees and total, then inserts full order row | price/fee/promo tampering can be accepted if DB only checks ownership | 4.3 server-authoritative transaction |
| P4-002 | P0 | Critical | Stock/order/promo are not one transaction | stock RPC → order INSERT → separate promo usage increment; restore RPC is compensation | partial commercial state under failures/concurrency | 4.3 atomic checkout |
| P4-003 | P0 | Critical | Explicit idempotency key absent | client-generated order ID + per-page `isSubmittingOrder` only | network retry/cross-device duplicate order risk | 4.3 idempotency |
| P4-004 | P0 | Critical | Promo use count has read-modify-write race | `incrementPromoUsage()` SELECTs `used_count` then UPDATEs +1 | max-use promos can be oversubscribed | 4.3 transaction/locking |
| P4-005 | P0 | Critical, live status unknown | Profile role immutability not proven live | old schema permits owner UPDATE; Phase 1 guard exists separately; Phase 3 migration does not install it | possible self-promotion to admin if Phase 1 guard absent | 4.2 verify/install role guard |
| P4-006 | P0 | Critical, live status unknown | Customer order protected-field immutability not proven live | old schema owner UPDATE is broad; Phase 1 order guard is separate from Phase 3 migration | customer may mutate totals/status/items if live guard absent | 4.2 verify/install order guard |
| P4-007 | P0 | Critical blocker | Modern table RLS is unverified | brands/bundles/promos/settings/DM tables absent from old schema; Phase 3 migration does not define all their RLS | authorization cannot be certified | 4.1 live export → 4.2 policies |
| P4-008 | P0 | Critical blocker | DM participant isolation unverified | frontend participant filters are not authorization; live `dm_threads`/`dm_messages` policies unknown | private chat exposure/modification possible if RLS weak | 4.2 DM RLS tests |
| P4-009 | P0 | Critical blocker | Customer location privacy unverified | admin loads all customer profiles/order addresses; protection relies on RLS | private address/GPS exposure if policies weak | 4.2 privacy/RLS tests |
| P4-010 | P0 | High | Cancellation/restock is not atomic | order cancelled first, stock restored second, rollback attempted on restore failure | inconsistent order/inventory under partial failure | 4.3/4.4 transactional cancellation |
| P4-011 | P1 | High | Order status transitions are browser/admin direct updates | admin sets numeric `status_override` directly; no server state-machine guard observed | illegal transitions/history corruption | 4.4 server transition API/RPC |
| P4-012 | P1 | High | Payment verification state is not explicit | checkout records method/reference/proof but no trusted SUBMITTED/VERIFIED lifecycle observed | uploaded proof can be confused with verified payment | 4.4 payment state machine |
| P4-013 | P1 | High | Account deletion can partially delete on failure | Storage removed before Auth delete; profile may be deleted before retry; later Auth failure can leave mismatch | destructive partial-state/data loss risk | 4.4 account deletion redesign |
| P4-014 | P1 | High | Live Storage policy/limits are unverified | Phase 3 migration defines intended policy, but deployment status and bucket limits unknown | payment/location/account privacy cannot be certified | 4.1 live export → 4.2 tests |
| P4-015 | P1 | High | Build availability coupled to live Supabase | `npm run build` fetches live catalogue; no successful offline build path | deployments fail when Supabase/DNS unavailable | 4.9 build resilience/staging |
| P4-016 | P1 | High | Public Nominatim/OSRM dependence not production-governed | client directly calls public geocoder/router endpoints | rate-limit/privacy/availability risk | 4.7/4.9 provider abstraction |
| P4-017 | P1 | High | God-file architecture | `script.js`: 7,260 lines, 327 functions, many domains | regression risk and difficult test isolation | 4.5 incremental modules |
| P4-018 | P1 | Medium/High | CSP still permits inline script/style | Vercel CSP includes `'unsafe-inline'` | reduces XSS defense depth | 4.7 CSP migration after inline audit |
| P4-019 | P1 | Medium | Payment/image upload source-size limits not enforced in browser helper | image is decoded/re-encoded, but source file size isn't rejected before decode | memory/resource abuse on client; bucket limits unknown | 4.2/4.7 validation + Storage limits |
| P4-020 | P1 | Medium | Rating insert and order rated-state update are separate | rating may commit while `orders.rated` update fails | inconsistent UX/state after partial failure | 4.4 atomic rating flow |
| P4-021 | P1 | Medium | Desktop regression test depends on missing absolute path | `tests/desktop-regression.spec.py` references `/mnt/data/DAGOLDOL-PASTED-TEXT1-MOBILE-FIX` | suite is not portable/reproducible | 4.8 fixture/baseline repair |
| P4-022 | P1 | Medium | Python runtime suites are not part of `npm run verify` | standalone Playwright scripts must be run manually | CI can miss runtime regressions | 4.8 integrate runtime tests |
| P4-023 | P1 | Medium | Production Git/Vercel commit not tied to supplied archive | `.git` absent; GitHub inaccessible from audit runtime | traceability/rollback uncertainty | 4.1 capture deployment identity |
| P4-024 | P1 | Medium | Live DB/Storage backup not confirmed | source backup exists; production backup evidence absent | unsafe migration/rollback posture | 4.1/4.9 backup evidence |

## Critical gate owners

Until project-specific human owners are named, Phase 4 uses functional owners rather than inventing people:

- Security/RLS owner: **Database Security workstream (Phase 4.2)**
- Commerce transaction owner: **Checkout/Inventory workstream (Phase 4.3)**
- Payment/order integrity owner: **Order Integrity workstream (Phase 4.4)**
- Live evidence owner: **Phase 4.1 Supabase preflight**

No Critical issue is marked resolved from source code alone when live deployment evidence is required.
