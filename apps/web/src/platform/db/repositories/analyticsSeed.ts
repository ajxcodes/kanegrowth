import type { LocalDb } from '../LocalDb'
import householdFixture from '@fixtures/analytics/household_fixture.json'

export interface StandaloneFixtureMeta {
  asOfDate: string
  workspaceId: string
  userId: string
}

export const STANDALONE_FIXTURE_META: StandaloneFixtureMeta = {
  asOfDate: householdFixture.asOfDate,
  workspaceId: householdFixture.workspaceId,
  userId: householdFixture.userId,
}

/**
 * Seeds a local SQLite database with the canonical multi-year household fixture
 * when the `accounts` table is empty. Safe to call repeatedly (idempotent).
 */
export const seedAnalyticsHouseholdFixture = async (db: LocalDb): Promise<boolean> => {
  const existing = await db.select<{ count: number }>(
    'SELECT count(*) AS count FROM accounts WHERE deletedAt IS NULL'
  )
  if ((existing[0]?.count ?? 0) > 0) {
    return false
  }

  const now = `${householdFixture.asOfDate}T12:00:00.000Z`
  const { workspaceId, userId } = householdFixture

  await db.transaction(async (tx) => {
    for (const member of householdFixture.members) {
      await tx.exec(
        `INSERT OR REPLACE INTO household_members
          (_id, workspaceId, name, role, color, isArchived, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, ?, 0, ?, NULL)`,
        [member.id, workspaceId, member.name, member.role, member.color, now]
      )
    }

    for (const acc of householdFixture.accounts) {
      const doc = {
        _id: acc.id,
        userId,
        workspaceId,
        name: acc.name,
        type: acc.accountType,
        currency: acc.currency,
        currentBalance: acc.currentBalanceMinor,
        accountGroup: acc.accountGroup,
        isLiability: acc.isLiability,
        interestRateBps: acc.interestRateBps,
        minimumPaymentMinor: acc.minimumPaymentMinor,
        isArchived: false,
        updatedAt: now,
      }
      await tx.exec(
        `INSERT OR REPLACE INTO accounts
          (_id, userId, workspaceId, name, type, currency, currentBalance, isArchived,
           accountGroup, isLiability, interestRateBps, minimumPaymentMinor,
           data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 'synced')`,
        [
          acc.id,
          userId,
          workspaceId,
          acc.name,
          acc.accountType,
          acc.currency,
          acc.currentBalanceMinor,
          acc.accountGroup,
          acc.isLiability ? 1 : 0,
          acc.interestRateBps,
          acc.minimumPaymentMinor,
          JSON.stringify(doc),
          now,
          now,
        ]
      )
    }

    for (const cat of householdFixture.categories) {
      const doc = {
        _id: cat.id,
        userId,
        name: cat.name,
        envelopeType: cat.envelopeType,
        monthlyTargetMinor: cat.monthlyTargetMinor,
        isArchived: false,
        updatedAt: now,
      }
      await tx.exec(
        `INSERT OR REPLACE INTO categories
          (_id, userId, masterCategoryId, name, isArchived, envelopeType, monthlyTargetMinor,
           data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState)
         VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?, NULL, ?, 0, 'synced')`,
        [
          cat.id,
          userId,
          cat.name,
          cat.envelopeType,
          cat.monthlyTargetMinor,
          JSON.stringify(doc),
          now,
          now,
        ]
      )
    }

    for (const tag of householdFixture.tags) {
      const doc = {
        _id: tag.id,
        userId,
        name: tag.name,
        updatedAt: now,
      }
      await tx.exec(
        `INSERT OR REPLACE INTO tags
          (_id, userId, name, data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 'synced')`,
        [tag.id, userId, tag.name, JSON.stringify(doc), now, now]
      )
    }

    for (const rule of householdFixture.recurringRules) {
      const doc = {
        _id: rule.id,
        userId,
        workspaceId,
        accountId: rule.accountId,
        categoryId: rule.categoryId,
        type: rule.txType,
        amountMinor: rule.amountMinor,
        cadence: rule.cadence,
        isActive: rule.isActive,
        updatedAt: now,
      }
      await tx.exec(
        `INSERT OR REPLACE INTO recurringRules
          (_id, userId, workspaceId, accountId, categoryId, nextDueDate, isActive, isArchived,
           data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, 0, 'synced')`,
        [
          rule.id,
          userId,
          workspaceId,
          rule.accountId,
          rule.categoryId,
          householdFixture.asOfDate,
          rule.isActive ? 1 : 0,
          JSON.stringify(doc),
          now,
          now,
        ]
      )
    }

    for (const t of householdFixture.transactions) {
      const doc = {
        _id: t.id,
        userId,
        workspaceId,
        accountId: t.accountId,
        categoryId: t.categoryId,
        type: t.txType,
        status: t.status,
        amount: t.amountMinor,
        date: t.date,
        description: t.description,
        memberId: t.memberId,
        isShared: t.isShared,
        transferPairId: t.transferPairId,
        hasSplitChildren: t.hasSplitChildren,
        splitTransactionId: t.splitTransactionId,
        tags: t.tagIds,
        updatedAt: now,
      }
      await tx.exec(
        `INSERT OR REPLACE INTO transactions
          (_id, userId, workspaceId, accountId, categoryId, type, status, amount, date, clearedStatus,
           memberId, isShared, transferPairId, hasSplitChildren, splitTransactionId, tagsJson,
           data, updatedAt, deletedAt, _localUpdatedAt, _dirty, _syncState)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cleared', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 'synced')`,
        [
          t.id,
          userId,
          workspaceId,
          t.accountId,
          t.categoryId,
          t.txType,
          t.status,
          t.amountMinor,
          t.date,
          t.memberId,
          t.isShared ? 1 : 0,
          t.transferPairId,
          t.hasSplitChildren ? 1 : 0,
          t.splitTransactionId,
          JSON.stringify(t.tagIds),
          JSON.stringify(doc),
          now,
          now,
        ]
      )
      for (const tagId of t.tagIds) {
        await tx.exec(
          `INSERT OR IGNORE INTO transaction_tags (transactionId, tagId) VALUES (?, ?)`,
          [t.id, tagId]
        )
      }
    }
  })

  return true
}
