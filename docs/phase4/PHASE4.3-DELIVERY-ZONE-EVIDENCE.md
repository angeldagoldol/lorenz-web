# Phase 4.3 Delivery-Zone Evidence

The Phase 4.3 server boundary preserves the delivery behavior already present in the uploaded Dagoldol 3.3.5 source.

The browser source names two historical free-delivery reference locations in `script.js`:

1. `Katipunan National High School, Katipunan, Arakan, Cotabato, Philippines`
2. `Kimasog, Marilog District, Davao City, Davao del Sur, Philippines`

The Stage A database pins those names to the coordinates used during isolated verification:

| ID | Name | Latitude | Longitude | Road-radius rule |
|---|---|---:|---:|---:|
| `katipunan-nhs-arakan` | Katipunan National High School, Arakan | 7.423760 | 125.233630 | 5 km |
| `kimasog-marilog` | Kimasog / Crossing Quimasog, Marilog | 7.316345 | 125.299076 | 5 km |

These coordinates are configuration data, not browser authority. The Edge Function asks the routing provider for road distance; PostgreSQL applies the configured free-zone radius.

The preserved normal delivery contract is:

- main-origin road distance at or below `free_km_threshold` (currently 5 km): free;
- otherwise, a destination within a configured free-zone road radius: free;
- otherwise: `rate_per_km × full main-origin road distance` (currently PHP 60/km);
- if the main route cannot be obtained after the bounded retry: configured fallback fee (currently PHP 600).

The source strings can be rechecked with:

```bash
rg -n "FREE_ZONE_ADDRESSES|Katipunan National High School|Kimasog|DELIVERY_FREE_KM_THRESHOLD" script.js
```
