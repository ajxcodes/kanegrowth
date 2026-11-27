# Testing & CI

## What runs in CI

| Job (required check name) | Scope |
|---|---|
| `Frontend Lint, Typecheck, Unit Tests & Build` | ESLint, `tsc --noEmit`, Vitest (incl. the CI-workflow guard), standalone bundle build |
| `Rust Workspace Check & SQLCipher Tests` | fmt, clippy, `cargo check`, `cargo test --workspace`, architecture tests |
| `Playwright E2E (Desktop & Mobile)` | compose stack + `apps/web/e2e/auth-sync.spec.ts` against the real API |
| `Playwright E2E Standalone Suites (Desktop & Mobile)` | every `e2e/*.spec.ts` against the standalone bundle |
| `Container Build (Single Image)` | `docker build` |

## Real feature E2E suites

`e2e-standalone` runs `npm run test:e2e`, the root Playwright project (`playwright.config.ts`,
`testDir: './e2e'`) on both the `Desktop` (1280x800) and `Mobile` (390x844, touch) projects:

- `e2e/envelope-budgeting.spec.ts` — envelope/zero-based budgeting and Add Income (TR-44, #13)
- `e2e/branding.spec.ts` — theme-aware logo/wordmark and zero horizontal overflow (#10)
- `e2e/analytics.spec.ts` — analytics suite, drill-down, saved views, light/dark (#3)
- `e2e/standalone-demo-data.spec.ts` — demo data clear/reset (#4)

A new `e2e/*.spec.ts` is picked up automatically on both projects; no workflow edit is needed.
CSV/OFX import, recurring bills and offline relaunch smoke specs will therefore join the required
suite as they land.
`apps/web/src/platform/ci/__tests__/e2eWorkflow.test.ts` fails if the job stops running the whole
suite (spec path, `--grep`, `--project`, `continue-on-error`), if the root config stops
discovering `e2e/`, or if the standalone artifact stops being reused.

## Determinism

- The bundle under test is the artifact built once by the `frontend` job
  (`standalone-frontend-dist`); it is never rebuilt inside the E2E job.
- The suite talks only to `http://127.0.0.1:4173` (`vite preview`). `e2e/analytics.spec.ts` fails
  on any non-localhost request and `e2e/branding.spec.ts` fails on any failed request.
- `CI=true` enables `forbidOnly` and `workers: 1`; the demo dataset is seeded locally
  (OPFS/localStorage), so no external service, fixture server or container is involved.
- Runtime is 21.8 s with 4 workers and 50.5 s with `--workers=1`; no sharding is needed — revisit
  if the job approaches 15 minutes.

## Required status checks (branch protection)

Repository settings → Branches → `main` → *Require status checks to pass before merging*:

- `Playwright E2E (Desktop & Mobile)`
- `Playwright E2E Standalone Suites (Desktop & Mobile)`

Both are emitted by `.github/workflows/ci.yml` on every `pull_request` targeting `main`,
`phase/*` or `feature/*`. `auto-tag` also `needs` them, so a red E2E suite blocks a release.

## Running locally

```bash
npm ci
npm --prefix apps/web ci
npx playwright install chromium

npm run build          # standalone bundle -> dist/frontend
npm run test:e2e       # all e2e/*.spec.ts, Desktop + Mobile

# single suite
npx playwright test e2e/envelope-budgeting.spec.ts
```
