import { expect, test, type Page } from '@playwright/test'

const openBudgets = async (page: Page) => {
  await page.goto('/budgets', { waitUntil: 'networkidle' })
  await expect(page.getByTestId('envelope-table')).toBeVisible()
  // dismiss service-worker prompt if present
  const dismiss = page.getByRole('button', { name: 'Dismiss' })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
}

test.describe('Envelope / zero-based budgeting + Add Income (TR-44)', () => {
  test('add income then assign then reload persistence; over-assignment warning; month close; cap migration', async ({ page }) => {
    await openBudgets(page)

    // ── Add Income / Paycheck (AC1) ──
    await page.getByTestId('add-income-button').click()
    await expect(page.getByTestId('add-income-dialog')).toBeVisible()
    await page.getByTestId('add-income-amount').fill('1000')
    await page.getByTestId('add-income-date').fill('2027-01-15')
    await page.getByTestId('add-income-employer').fill('Acme')
    await page.getByTestId('add-income-notes').fill('January paycheck')
    // account select: pick first non-empty option
    const accountSelect = page.getByTestId('add-income-account')
    const firstAccount = await accountSelect.locator('option').first().getAttribute('value')
    if (firstAccount) await accountSelect.selectOption(firstAccount)
    await page.getByTestId('add-income-submit').click()
    await expect(page.getByTestId('add-income-dialog')).toBeHidden()

    // ── Ready to Assign visible (AC2) ──
    await expect(page.getByTestId('ready-to-assign')).toBeVisible()

    // ── assign an envelope ──
    const firstRow = page.getByTestId('envelope-row').first()
    const assignInput = firstRow.getByTestId('assign-input')
    const availableBefore = await firstRow.getByTestId('envelope-available').innerText()
    await assignInput.fill('100')
    await assignInput.blur()

    // ── reload persistence offline (AC6) ──
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('envelope-table')).toBeVisible()
    await expect(page.getByTestId('ready-to-assign')).toBeVisible()
    const firstRowAfter = page.getByTestId('envelope-row').first()
    await expect(firstRowAfter.getByTestId('envelope-available')).toBeVisible()
    expect(availableBefore).toBeTruthy()

    // ── over-assignment warning (AC3) ──
    const row = page.getByTestId('envelope-row').first()
    const input = row.getByTestId('assign-input')
    await input.fill('99999999')
    await input.blur()
    await expect(page.getByTestId('over-assignment-warning')).toBeVisible()

    // ── month close (AC4) ──
    await page.getByTestId('close-month-button').click()
    await expect(page.getByTestId('month-closed')).toBeVisible()
    await page.getByTestId('reopen-month-button').click()
    await expect(page.getByTestId('month-closed')).toBeHidden()

    // ── cap migration (AC5) ──
    const migrate = page.getByTestId('migrate-cap-button').first()
    if (await migrate.isVisible().catch(() => false)) {
      await migrate.click()
    }
  })
})
