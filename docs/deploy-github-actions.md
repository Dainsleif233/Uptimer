# Deployment Guide (GitHub Actions)

English | [中文](deploy-github-actions.zh-CN.md)

Deploy Uptimer to Cloudflare using the built-in GitHub Actions workflow.

## Prerequisites

- A GitHub repository (default branch: `master` or `main`)
- A Cloudflare account
- A Cloudflare API Token with deployment permissions
- Access to repository Settings > Secrets and Variables

## Workflow Overview

**Trigger**: Push to `main`/`master`, or manual `workflow_dispatch`

**File**: `.github/workflows/deploy.yml`

**Steps (in order)**:

1. Install Node + pnpm + dependencies
2. Resolve Cloudflare Account ID (reads from config, falls back to API query)
3. Compute resource names (Worker / D1)
4. Check or create D1 database, inject real `database_id` into temp `wrangler.ci.toml`
5. Run remote D1 migrations
6. Build the frontend (Vite) into `apps/web/dist`
7. Deploy the Worker — uploads the built SPA as static assets alongside the API
8. (Optional) Write Worker Secret: `ADMIN_TOKEN`

The frontend and API ship as a single Worker, so there is no separate Pages project and no cross-origin API base to configure.

## Configuration

### Required Secrets

| Name                   | Required | Description                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN` | Yes      | Cloudflare API authentication                                            |
| `UPTIMER_ADMIN_TOKEN`  | Yes      | Admin dashboard access key; auto-injected as Worker `ADMIN_TOKEN` secret |

### Recommended Secrets

| Name                    | Description                     |
| ----------------------- | ------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Avoids auto-resolution failures |

### Optional Variables

Override default naming:

| Name                                     | Default                   | Description                  |
| ---------------------------------------- | ------------------------- | ---------------------------- |
| `UPTIMER_PREFIX`                         | Repository name slug      | Unified resource name prefix |
| `UPTIMER_WORKER_NAME`                    | `${UPTIMER_PREFIX}`       | Worker name                  |
| `UPTIMER_D1_NAME`                        | `${UPTIMER_PREFIX}`       | D1 database name             |
| `UPTIMER_D1_BINDING`                     | `DB`                      | D1 binding name in Worker    |
| `VITE_ADMIN_PATH` / `UPTIMER_ADMIN_PATH` | —                         | Custom admin dashboard path  |

> If no naming variables are set, the workflow uses the repository name slug as the default prefix. This keeps names stable across forks.
>
> **API address**: No configuration needed — the frontend and API share the same origin (the Worker URL), so the SPA calls `/api/v1` relative to itself.

## Cloudflare Token Permissions

The workflow creates and updates multiple resources. Your token needs:

- Workers Scripts: deploy and manage secrets
- D1: query, create, and migrate databases
- Account: read account info (for account ID resolution)

## First Deployment

1. Add `CLOUDFLARE_API_TOKEN` to repository secrets
2. Add `UPTIMER_ADMIN_TOKEN` (admin dashboard access key)
3. Add `CLOUDFLARE_ACCOUNT_ID` (recommended)
4. (Optional) Set `UPTIMER_PREFIX` to avoid name collisions
5. Push to `master`/`main`, or manually trigger "Deploy to Cloudflare"
6. Once the workflow succeeds, note the Worker URL from the logs — the status page, admin dashboard, and API all live on that one origin

## Post-deployment Verification

### Check the Status Page

- Visit the Worker URL (public status page)
- Navigate to `/admin` (or your custom `VITE_ADMIN_PATH`)

### Test the API

```bash
# Public API
curl https://<worker-url>/api/v1/public/status

# Admin API
curl https://<worker-url>/api/v1/admin/monitors \
  -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>"
```

### Verify the Database (Optional)

Use Wrangler to check that key tables exist in D1:

```
monitors, monitor_state, check_results, outages, settings
```

## Troubleshooting

### "Resolve Cloudflare Account ID" fails

- Verify `CLOUDFLARE_API_TOKEN` is set and valid
- Confirm the token has account read permissions
- Set `CLOUDFLARE_ACCOUNT_ID` explicitly to skip auto-resolution

### D1 migration fails

- Check that `UPTIMER_D1_BINDING` matches the binding in `apps/worker/wrangler.toml`
- Verify migration SQL is idempotent and syntactically correct

### Static assets or SPA routes return 404

- Confirm the `Build Web (Vite)` step produced `apps/web/dist` before the `Deploy Worker` step ran
- Confirm `apps/worker/wrangler.toml` has the `[assets]` block pointing at `../web/dist` with `not_found_handling = "single-page-application"`
- Deep links like `/admin` rely on the SPA fallback; they only work through the deployed Worker (in local dev, use the Vite server on `:5173`)

### Admin returns 401

- Confirm `UPTIMER_ADMIN_TOKEN` was written to the Worker Secret
- Check that the token in the browser's localStorage matches the secret

## Rollback

Prefer redeploying the last known-good commit:

1. Find the last green deployment commit
2. Re-trigger "Deploy to Cloudflare" from that commit
3. If schema changes are involved, add a new forward-compatible migration rather than rolling back

> D1 migrations should not be rolled back destructively. If a remote migration was already applied, fix forward with a new migration.

## Relationship to CI

| Workflow     | Purpose                             |
| ------------ | ----------------------------------- |
| `ci.yml`     | Quality gate: lint, typecheck, test |
| `deploy.yml` | Production release                  |

Recommended branch strategy:

- PRs must pass CI before merging
- `master`/`main` only receives reviewed changes
- Releases are triggered automatically on push — no manual drift
