# Dagoldol Phase 4.1 — Test Baseline

## Native verification

`npm run verify`: **PASS**

- 72 Node tests passed
- 0 Node tests failed
- source-contract verifier passed

## Runtime Playwright/Python

| Script | Result |
|---|---|
| `tests/delivery-location-runtime.spec.py` | PASS |
| `tests/device-auth-runtime.spec.py` | PASS |
| `tests/mobile-matrix.spec.py` | PASS |
| `tests/mobile-resilience.spec.py` | PASS |
| `tests/payment-settings-runtime.spec.py` | PASS |
| `tests/runtime_mobile_fast.py` | PASS |
| `tests/smart-delivery-runtime.spec.py` | PASS |
| `tests/desktop-regression.spec.py` | BLOCKED — historical baseline directory absent |

`python -m pytest -q tests` reports no collected tests because the runtime scripts do not follow pytest naming/structure; they must currently be executed directly.

## Build

`npm run build`: **INFRASTRUCTURE-BLOCKED** in the audit runtime.

Failure: DNS resolution of `rvrjkfbenramappteuae.supabase.co` returned `EAI_AGAIN` during build-time Supabase fetch.

This must not be presented as a successful build or as a source-code regression. It is retained as evidence that the build path requires live Supabase/network availability.
