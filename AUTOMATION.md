# Automated load plan CSV sync

This site can keep the Supabase `tracker_rows` table updated from a CSV without manually uploading the file in the browser.

The automation is handled by `.github/workflows/sync-load-plan.yml`, which runs `scripts/sync-load-plan.mjs` every weekday at 05:00 UTC and can also be run manually from the GitHub Actions tab.

## Required GitHub secrets

Add these in GitHub under **Settings > Secrets and variables > Actions > Repository secrets**.

| Secret | Purpose |
| --- | --- |
| `LOAD_PLAN_CSV_URL` | Direct URL to the latest CSV export. |
| `SUPABASE_URL` | Supabase project URL, for example `https://example.supabase.co`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key. Keep this private and only store it as a GitHub secret. |

## Optional GitHub secret

| Secret | Purpose |
| --- | --- |
| `LOAD_PLAN_CSV_BEARER_TOKEN` | Bearer token for the CSV source, if the CSV URL is protected. |

## How the sync works

1. GitHub Actions fetches the CSV from `LOAD_PLAN_CSV_URL`.
2. The script parses the same fields supported by the manual upload in `app.js`.
3. Existing tracker statuses are preserved by matching rows on `kenn`.
4. Rows for the configured tracker are replaced in Supabase.

The manual **Upload CSV** button remains available as a fallback.

## Supported CSV headings

The importer accepts the current manual-upload headings, including:

- `kenn` or `reference`
- `model`
- `build_type`, `gru`, or `bespoke`
- `colour` or `color`
- `notes`
- `shipment_date`, `ship_date`, or `date`
- `load_no`, `load`, or `load_number`
- `load_pos`, `position`, or `load_position`

Status columns such as `bumper_picking`, `bumper_picked`, `cage_picking`, `cage_picked`, `checked`, `complete`, `despatched`, and `shortage` are also supported, but existing site progress is preserved by default when the same KENN already exists.
