import { expect, test, type Page } from '@playwright/test'

const openSettings = async (page: Page) => {
  const openNavigation = page.getByRole('button', { name: 'Open navigation' })
  if (await openNavigation.isVisible()) {
    await openNavigation.click()
  }
  // The service-worker "installed" toast sits above the sidebar and can cover the settings
  // button on the narrow Mobile project; dismiss it before clicking through.
  const dismissPrompt = page.getByRole('button', { name: 'Dismiss' })
  if (await dismissPrompt.isVisible().catch(() => false)) {
    await dismissPrompt.click()
  }
  // The Mobile sidebar can clip this button below the viewport on short screens, so dispatch the
  // click directly instead of relying on hit-testing (the repo's analytics spec does the same for
  // its SVG links).
  await page.locator('button[aria-label="Open settings"]:visible').dispatchEvent('click')
}

test.describe('Standalone demo data clear & reset (TR-17)', () => {
  test('clears and resets standalone demo data behind confirmation, staying empty across a reload', async ({
    page,
  }) => {
    await page.goto('/analytics', { waitUntil: 'networkidle' })
    await expect(page.getByTestId('analytics-page')).toBeVisible()

    await openSettings(page)
    await expect(page.getByTestId('demo-data-status')).toHaveText('Demo data is loaded')

    // Cancelling the clear confirmation changes nothing.
    await page.getByTestId('clear-demo-data-button').dispatchEvent('click')
    await expect(page.getByTestId('demo-data-confirm-clear')).toBeVisible()
    await page.getByRole('button', { name: /^cancel$/i }).click()
    await expect(page.getByTestId('demo-data-status')).toHaveText('Demo data is loaded')

    // Confirming clears the workspace.
    await page.getByTestId('clear-demo-data-button').dispatchEvent('click')
    await page.getByTestId('demo-data-confirm-clear').click()
    await expect(page.getByTestId('demo-data-status')).toHaveText('Workspace is empty')

    // Empty before the reload...
    await page.goto('/transactions', { waitUntil: 'networkidle' })
    await expect(page.getByText('No transactions yet')).toBeVisible()

    // ...and after it: the dismissed marker stops first-boot seeding from re-running.
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByText('No transactions yet')).toBeVisible()

    await openSettings(page)
    await expect(page.getByTestId('demo-data-status')).toHaveText('Workspace is empty')

    // Cancelling the reset confirmation leaves the workspace empty.
    await page.getByTestId('reset-demo-data-button').dispatchEvent('click')
    await expect(page.getByTestId('demo-data-confirm-reset')).toBeVisible()
    await page.getByRole('button', { name: /^cancel$/i }).click()
    await expect(page.getByTestId('demo-data-status')).toHaveText('Workspace is empty')

    // Confirming restores the canonical demo dataset.
    await page.getByTestId('reset-demo-data-button').dispatchEvent('click')
    await page.getByTestId('demo-data-confirm-reset').click()
    await expect(page.getByTestId('demo-data-status')).toHaveText('Demo data is loaded')

    // Restored totals before and after a reload.
    await page.goto('/analytics', { waitUntil: 'networkidle' })
    await expect(page.getByTestId('sankey-total-inflow')).toHaveText('$6,500.00')
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('sankey-total-inflow')).toHaveText('$6,500.00')

    // Fixture rows are back.
    await page.goto('/transactions', { waitUntil: 'networkidle' })
    await page
      .getByPlaceholder('Search by title, description, amount...')
      .fill('Costco Specialty Pantry')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByText('Costco Specialty Pantry')).toBeVisible()
  })
})
