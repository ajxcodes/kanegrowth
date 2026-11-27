# Envelope / zero-based budgeting — documented rule set

Authoritative pure implementation: [`apps/web/src/domain/envelope.ts`](./envelope.ts)
(`computeEnvelopeMonthView`, `evaluateAssignment`, `planMoveAllocation`, `migrateCapToEnvelopeTarget`,
`incomePoolMinor`, `expenseInEnvelopeMinor`, `monthKeyForDate`, `monthBounds`, `isEnvelopeCategory`).
All arithmetic is **integer minor units**; no floats; no rounding drift. Hexagonal slice: pure domain
(`@domain/envelope`) → port (`@ports/envelope/EnvelopeLedgerPort`) → SQLite adapter
(`@adapters/envelope/SqliteEnvelopeLedgerAdapter` + `createEnvelopeLedgerService`); **no SQL in React**.

- **Envelope** = a non-archived `category` whose `envelopeType ∈ {expense, sinking_fund, savings}`.
  `envelopeType` absent is treated as `'expense'` (SQL `NOT NULL DEFAULT 'expense'`, migration 0005).
  `envelopeType='income' | 'transfer'` and archived categories are **not** envelopes. `envelopeId === categoryId`.
  **Sinking fund** = `envelopeType='sinking_fund' | 'savings'`. `targetMinor = categories.monthlyTargetMinor`.
- **Monthly target** = existing `categories.monthlyTargetMinor` (migration 0005). Not a new field.
- **Assignment** = `LocalEnvelopeAssignment`, syncable table `envelopeAssignments`, singular entity
  `envelopeAssignment`, `kind='assignment' | 'monthClose'`, `month='YYYY-MM'`, integer `amountMinor`
  (may be negative for re-allocation; `0` for `monthClose`), `source ∈ {manual, income_split, reallocate, month_close}`.
  **Uniqueness:** at most one `kind='assignment'` row per `(workspaceId, envelopeId, month)`;
  re-allocation **updates** that row. `assignedTotal(month)` = Σ `amountMinor` over `kind='assignment'`.
  **Uniqueness:** at most one `kind='monthClose'` row per `(workspaceId, month)`.

"Cumulative through end(M)" = sum over months `k ≤ M` plus transactions `date ≤ periodEnd(M)`.

## Numbered rules (each pinned in `apps/web/src/domain/__tests__/envelope.test.ts`)

### Transaction counting (mirrors `@shared/budget` `computeBudgetSpentMinorPure`, `@domain/budgetProgress`)

1. **TR-1** Only `status === 'posted'` transactions count; `'draft'` excluded.
2. **TR-2** `type === 'transfer'` excluded from income **and** activity.
3. **TR-3** Splitting: a split **child** counts in its own `categoryId`; its **split parent is excluded
   once it has children** (`splitTransactionId` graph; `hasSplitChildren`); an ordinary non-split
   transaction still counts. Same rule as `computeBudgetSpentMinorPure`.
4. **TR-4** Workspace scope: transactions + assignments filtered to `workspaceId` (`null` = personal;
   matches `@domain/budgetProgress` account filter convention; `accountIds` empty = all accounts;
   `accountIds=[...]` restricts). `categories` are personal and not workspace-filtered.

### Month + timezone (`@shared/timezone`, `@shared/budget`, `DEFAULT_TIMEZONE`)

5. **TR-5** `monthKey` = `'YYYY-MM'`. `monthKeyForDate(iso, timezone)` =
   `dateStringInTimezone(new Date(iso), timezone).slice(0,7)`.
   e.g. `monthKeyForDate('2027-01-01T02:00:00.000Z','America/New_York')==='2026-12'`.
6. **TR-6** `monthBounds(monthKey, timezone)` = `resolveMonthlyPeriod(year, month, timezone)`.
   `income(M)` / `activity(M)` inside `[periodStart, periodEnd]` (inclusive); cumulative sums cut off
   at `periodEnd(M)`. A transaction exactly at `periodEnd` is included; a transaction after is excluded.

### Income pool → Ready to Assign

7. **TR-7** `incomePool(k)` = Σ posted `type==='income'` in month `k`, **any category** (income in an
   envelope category still funds the pool; it does **not** also add to envelope activity).
8. **TR-8/TR-9** `readyToAssign(M) = Σ_{k≤M} incomePool(k) − Σ_{k≤M} assignedTotal(k)`.
   `readyToAssignThisMonth(M) = incomePool(M) − assignedTotal(M)`. `readyToAssign` is always visible,
   integer minor; `=== 0` when every unit assigned; `> 0` when unassigned.

### Envelope balances

9. **TR-10/TR-11** `assigned(E, M)` integer (may be negative for re-allocation); uniqueness per `(E, month)`;
   duplicate `(E, month)` collapses to one. `activity(E, k) = − Σ expense in E in k`.
   Income-in-E counts toward `incomePool` (rule 7) but does **not** add to envelope activity; it is
   funded back via `assigned`. `spentMinor = Σ expense in E`; `activityMinor = −spentMinor`. Transfers excluded.
10. **TR-12** `available(E, M)` (cumulative) `= Σ_{k≤M} assigned(E, k) + Σ_{k≤M} activity(E, k)`.
11. **TR-13** `budgeted(E, M) = assigned(E, M)`; `activityThisMonth(E, M) = activity(E, M)`;
    `carriedIn(E, M) = available(E, M−1)`; `available = carriedIn + budgeted + activityThisMonth`;
    `targetMinor = monthlyTargetMinor`.
12. **TR-14/TR-15 Rollover:** nothing clamps to zero. **Positive rollover** = leftover `available > 0`
    carries forward into `M+1`. **Negative rollover** = `available < 0` (overspend / over-assignment
    inside an envelope) carries forward and reduces `M+1` availability until covered by future
    `assigned`; `rolledOverNegative = available < 0`. Existing `Budget.rollover` caps flag is unaffected;
    envelopes always roll.
13. **TR-16..TR-20 Month close:** a `kind='monthClose'` marker per `(workspaceId, month)`.
    `closeMonth(M)` requires nothing else; it records `closedAt` + an `EnvelopeMonthSnapshot`
    (per-envelope `carriedIn/budgeted/activity/available` + `readyToAssign`) in `snapshotJson` for
    audit. **Carry-forward is derived**, so `available(E, M+1 start) === available(E, M)` regardless
    of whether `M` is closed. `isClosed(M)` blocks `assign` / `moveAllocation` targeting `M`
    (`MONTH_CLOSED`); `reopenMonth(M)` removes the marker. Transactions in a closed month still
    recompute (conservation preserved); only assignment edits are locked. `kind='monthClose'` `amountMinor=0`.
14. **TR-21/TR-22 Re-allocation** `moveAllocation(A→B, M, x)` (`x ≥ 0` integer):
    `assigned(A,M) −= x`, `assigned(B,M) += x`. `assignedTotal` unchanged ⇒ `readyToAssign` unchanged;
    `available(A) −= x`, `available(B) += x`. Source may go negative (negative rollover; **not** an
    over-assignment). Rejected if `x < 0` → `INVALID_AMOUNT`, `A === B` → `INVALID_ENVELOPE`, `M`
    closed → `MONTH_CLOSED`. `x === 0` noop. No separate transfer record; a pair of adjustments in
    the same month. `source='reallocate'`.
15. **TR-23 Conservation invariant** (pinned):
    `Σ_E available(E, M) + readyToAssign(M) = Σ_{k≤M} incomePool(k) − Σ_{k≤M} expenseInEnvelope(k)`
    where `expenseInEnvelope` counts posted expenses in envelope categories. Integer.

### Over-assignment (AC3)

16. **TR-24/TR-25** `assign(E, M, …)` computes current `readyToAssign(end M)` (before this change) then
    `resultingReadyToAssign = currentReadyToAssign − deltaAssignedTotal`. If `resultingReadyToAssign < 0`:
    - default `'refuse'` → `EnvelopeError` code `'OVER_ASSIGNMENT'`, **nothing written**; OR
    - `onOverAssignment: 'confirm'` + `allowOverAssign: true` → applied **with warning**
      `'over-assignment'` and `'negative-ready-to-assign'`.
    **A negative `readyToAssign` can never be produced without an explicit warning; silently producing
    it is a contract violation.** `moveAllocation` never changes `readyToAssign`. UI shows
    `data-testid="over-assignment-warning"` when `readyToAssign < 0`.
17. **TR-26** `assigned` from `readyToAssign` cannot exceed available `readyToAssign` unless rule 16
    confirm path is taken. `assigned` inside `recordIncome` splits: `Σ splits ≤ incomeAmount`, validated
    before any write; remaining income stays in `readyToAssign`. (Income-split `kind='assignment'`
    `source='income_split'`; **not** `splitTransactionId` children.)

### `assign` semantics

`assign(E, M, amountMinor)` **sets** `assigned(E, M) = amountMinor` (integer, may be negative);
uniqueness per `(E, month)`; re-allocation **updates** that row; `deltaAssignedTotal =
amountMinor − previouslyAssigned(E, M)` for the rule-16 check. `kind='assignment'`, `source='manual'`
(or `'reallocate'`). `monthClose` blocks `assign`. `snapshotJson` round-trips `EnvelopeMonthSnapshot`.

### Cap coexistence + migration (AC5)

18. **TR-27** Existing `budgets` rows are **untouched**; legacy `kind` absent ⇒ cap;
    `listLocalBudgetsWithProgress` and `computeBudgetSpentMinorPure` keep working; caps render
    independently of envelope rows (separate table). Existing per-category caps keep rendering unchanged.
19. **TR-28/TR-29 `migrateCapToEnvelopeTarget(budgetId)`**: reads a legacy per-category cap
    (`budgets.categoryId != null`, `!isArchived`, `kind` absent/`'cap'`, `budget.amount > 0`;
    `LocalBudget.amount` integer minor), and **sets `categories.monthlyTargetMinor = budget.amount`** on
    that category (cap becomes envelope target). Does **not** delete/archive/modify the `budgets` row;
    does **not** create assignments; **idempotent**. Overall-scope caps (`categoryId == null`) →
    `migrated:false, reason:'overall-scope'`; already-migrated targets → `migrated:false` + `reason`.
    `category.update` is queued for sync.

### Sync (offline-first, AC6)

`envelopeAssignment` reuses the existing sync engine; one new table + entity. `Repository<LocalEnvelopeAssignment>('envelopeAssignments')`
`create`/`update`/`remove` enqueue outbox ops `entity: 'envelopeAssignment:<id>'` inside the same SQLite
transaction (`_dirty`, `_syncState='pending'`); `operation ∈ create|update|delete`; `baseUpdatedAt` on
update; tombstone `deletedAt`; `upsertFromServer` applies pulls. `ENTITY_TO_TABLE.envelopeAssignment='envelopeAssignments'`;
`SYNCABLE_TABLES += 'envelopeAssignments'`; `PROMOTED_COLUMNS.envelopeAssignments = ['userId','workspaceId','kind','envelopeId','month','amountMinor']`
with defaults `kind:'assignment'`, `envelopeId:''`, `amountMinor:0`. `tableInvalidationBus.publish('envelopeAssignments')`
after every mutation. `recordIncome` writes income `transaction` + splits atomically in **one**
`db.transaction`; no `applyLocalCategorizationRules`. Account balance is **derived**, recomputed
(`recomputeLocalAccountBalance`) and persisted, **never pushed** through the outbox. Migration `0007`
(`envelopeAssignments`, additive `CREATE TABLE IF NOT EXISTS` + indexes) shared with Rust
`MIGRATION_0007`, version **7**; Rust `envelopeAssignment`/`envelopeAssignments` registration; legacy
`budgets` rows untouched. Pending ops persist in `_outbox`; `flushOutbox()` → `pushOutboxOps`; server
`noop→applied`; `conflict→recordConflict` (entity `envelopeAssignment`); `pullChanges` applies docs +
tombstones. (TR-32..TR-43)

## Rule → test map

| Rule | Test (`apps/web/src/domain/__tests__/envelope.test.ts` unless noted) |
|---|---|
| 1 / TR-1 | `excludes draft transactions from income and activity` |
| 2 / TR-2 | `excludes transfers from income pool and envelope activity` |
| 3 / TR-3 | `counts split children in own category and excludes split parent once it has children` |
| 4 / TR-4 | `scopes transactions and assignments to workspace` |
| 5 / TR-5 | `derives month key YYYY-MM in timezone` |
| 6 / TR-6 | `resolves month bounds via resolveMonthlyPeriod and cumulative cutoff at periodEnd` |
| 7 / TR-7 | `counts all posted income into incomePool regardless of category` |
| 8 / TR-8 | `readyToAssign equals cumulative income minus cumulative assigned` |
| 9 / TR-9 | `readyToAssign is always visible and integer minor units` |
| 9 / TR-10 | `assigned integer may be negative for re-allocation and unique per envelope month` |
| 9 / TR-11 | `activity equals negative expense in envelope` |
| 10 / TR-12 | `available is cumulative assigned plus cumulative activity` |
| 11 / TR-13 | `budgeted activity available per envelope per month` |
| 12 / TR-14 | `positive rollover carries leftover forward` |
| 12 / TR-15 | `negative rollover carries overspend forward until covered` |
| 13 / TR-16 | `month close records snapshot and blocks assignment` (+ adapter) |
| 13 / TR-17 | `carry forward equals available at close regardless of closed flag` |
| 13 / TR-18 | `reopen removes month close marker and restores assignment` (+ adapter) |
| 13 / TR-19 | `month close marker unique per workspace month` |
| 13 / TR-20 | `transactions in closed month still recompute conservation` |
| 14 / TR-21 | `moveAllocation shifts assigned between envelopes without changing ready to assign` |
| 14 / TR-22 | `moveAllocation rejects negative zero self and closed` |
| 15 / TR-23 | `conservation sum available plus ready to assign equals income minus envelope expense` |
| 16 / TR-24 | `over-assignment refused by default` |
| 16 / TR-25 | `over-assignment applied only with explicit confirmation and warns negative ready to assign` |
| 17 / TR-26 | `income split sum cannot exceed income and remainder stays ready to assign` |
| 18 / TR-27 | `localDomainParity.test.ts :: computes budget spent identically to the server under the split-children rule (food=11000, transport=4000, overall=15000 minor)` + preserved `BudgetsPage.test.tsx` |
| 19 / TR-28 | `migrateCapToEnvelopeTarget sets monthlyTargetMinor without touching budget and is idempotent` (+ adapter) |
| 19 / TR-29 | `overall scope caps are not migratable` |
