# KaneGrowth Code Review Standards (Critique)

These standards guide automated PR reviews (`ajxcodes/critique`) and human reviews across `kanegrowth`.

## 1. Hexagonal Architecture & Layer Boundaries
- Pure domain logic (`crates/analytics-domain` and `apps/web/src/domain/analytics`) must have **zero** dependencies on SQLite/rusqlite, Tauri, React, browser DOM, filesystem, network, or ambient wall-clock time (`as_of_date` / `asOfDate` must be passed explicitly).
- Ports (`crates/analytics-domain/src/ports.rs`, `apps/web/src/ports/analytics/`) depend only on domain types.
- Driven adapters (`crates/analytics-sqlite`, `apps/web/src/adapters/analytics/`) implement ports and never leak SQL/driver types into domain or UI layers.
- ESLint `import-x/no-restricted-paths` boundary zones must remain strict with zero violations.

## 2. Financial & Data Integrity
- All monetary values, budgets, targets, interest accruals, and rollups must use **integer minor units** (`i64` in Rust, integer cents in TypeScript). Floating-point currency math is forbidden in domain calculations.
- Ledger aggregations must exclude soft-deleted rows (`deletedAt IS NOT NULL`), draft rows (`status = 'draft'`), and split parent rows (`hasSplitChildren = 1`) to prevent double-counting.
- Linked internal transfers (`type = 'transfer'` or `transferPairId IS NOT NULL`) must be excluded by default in cash-flow and category spending views unless `includeTransfers` is explicitly enabled.
- Sankey flow conservation must hold (`sum(Tier-0 Sources) == Pool == sum(Tier-2 Uses)`), including explicit `Deficit / Balance Draw` balancing on zero-income months with zero `NaN` or division-by-zero errors.
- Debt payoff simulations must terminate deterministically and surface `NonAmortizingDebt` cleanly rather than looping indefinitely.

## 3. Security & SQLite Persistence
- Every SQLite/SQLCipher query must use parameterized bindings — never interpolate user input or filter values into SQL strings.
- Desktop SQLCipher databases must remain encrypted at rest with device-local keys; never degrade to plaintext or log secrets/keys.
- Maintain strict CSP policies in `apps/web/index.html`, `apps/web/src-tauri/tauri.conf.json`, and `apps/web/nginx.conf`.

## 4. Testing & Commits
- Follow the test pyramid: pure domain unit tests (Rust + Vitest), real encrypted SQLCipher/SQLite integration tests, and Playwright E2E tests across Desktop (`1280x800`) and Mobile (`390x844`) viewports.
- Use Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`, `ci:`).
