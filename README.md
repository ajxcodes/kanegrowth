# KaneGrowth

Local-first household finance and analytics platform built on top of [Corvale](https://github.com/RRI-Atharv37/corvale) (React 19 + Tauri v2 + local SQLCipher/SQLite + shared Web UI) with Hexagonal Architecture.

## Features

- **Cash Flow / Sankey Diagrams:** Income sources flowing into budget categories/envelopes, sinking funds/savings, and unallocated surplus (with explicit deficit balancing), configurable date ranges, internal transfer exclusion toggle (excluded by default), net vs. gross basis toggle, hover tooltips, and click-through transaction drill-down.
- **Category Spending Trends (MoM & YoY):** Month-over-Month bars/lines with trailing rolling average overlay, Year-over-Year deltas, envelope threshold overage and spend anomaly highlighting, and transaction drill-down.
- **Net Worth & Debt Payoff Projections:** Historical Assets vs. Liabilities timeline by account group plus forward-looking net worth and **Snowball vs. Avalanche** debt payoff scenarios with monthly extra-payment and lump-sum what-if controls, estimated debt-free date, and total interest saved.
- **Interactive Cross-Filtering & Saved Views:** Multi-select filtering by Account, Category/Envelope, Tag, Household Member (`all` / `shared` / `individual`), and Date Range, with saved filter presets persisted in local SQLCipher/SQLite and Light/Dark theme support across Desktop, Web UI, and Mobile viewports.

## Repository Structure

- `crates/analytics-domain/` — Pure Rust Hexagonal domain core & ports (zero DB/Tauri/IO deps).
- `crates/analytics-sqlite/` — Driven Rust SQLCipher/SQLite adapter (`rusqlite` with `bundled-sqlcipher-vendored-openssl`).
- `shared/` — Shared TypeScript domain modules and canonical cross-language analytics fixtures (`shared/fixtures/analytics/`).
- `apps/web/` — Offline-first React 19 Web UI + Tauri v2 desktop/mobile shell (`apps/web/src-tauri/`).
- `e2e/` — Playwright end-to-end tests across Desktop (`1280x800`) and Mobile (`390x844`) viewports.

## Development & Verification

```bash
# Install dependencies
npm ci
npm --prefix apps/web ci

# Frontend lint, typecheck, unit tests, and standalone production build
npm run lint
npm run typecheck
npm run test
npm run build

# Rust workspace check and encrypted SQLCipher integration tests
cargo check --workspace
cargo test --workspace

# Playwright E2E (Desktop & Mobile)
npm run test:e2e
```

## Self-Hosted Web UI (Docker)

```bash
docker compose up --build
# Served on http://127.0.0.1:8080/analytics
```

## License

Licensed under `AGPL-3.0-or-later`. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
