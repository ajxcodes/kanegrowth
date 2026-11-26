import { expect, test } from '@playwright/test'

test.describe('KaneGrowth Enhanced Analytics Suite (TR-12)', () => {
  test('renders offline analytics suite with drill-down, debt what-if, cross-filters, saved views, and light/dark themes on Desktop and Mobile', async ({
    page,
  }) => {
    const externalRequests: string[] = []
    const failedRequests: string[] = []

    page.on('request', (req) => {
      const url = req.url()
      if (url.startsWith('http://127.0.0.1:4173') || url.startsWith('data:') || url.startsWith('blob:')) {
        return
      }
      externalRequests.push(url)
    })
    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.method()} ${req.url()} (${req.failure()?.errorText ?? 'failed'})`)
    })

    await page.goto('/analytics', { waitUntil: 'networkidle' })
    await expect(page.getByTestId('analytics-page')).toBeVisible()

    // 1. Cash Flow Sankey renders with non-zero SVG bounding box and exact canonical totals
    const sankeySvg = page.getByTestId('sankey-svg')
    await expect(sankeySvg).toBeVisible()
    const sankeyBox = await sankeySvg.boundingBox()
    expect(sankeyBox).not.toBeNull()
    expect(sankeyBox!.width).toBeGreaterThan(200)
    expect(sankeyBox!.height).toBeGreaterThan(80)

    await expect(page.getByTestId('sankey-total-inflow')).toHaveText('$6,500.00')
    await expect(page.getByTestId('sankey-total-outflow')).toHaveText('$5,080.00')
    await expect(page.getByTestId('sankey-excluded-transfers')).toHaveText('$800.00')

    // Zero horizontal overflow in dark theme
    const darkOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    )
    expect(darkOverflow).toBe(true)

    // Toggle internal transfers & net/gross basis
    await page.getByTestId('sankey-exclude-transfers-toggle').click()
    await expect(page.getByTestId('sankey-excluded-transfers')).toHaveText('$0.00')
    await expect(page.getByTestId('sankey-total-outflow')).toHaveText('$5,880.00')
    await page.getByTestId('sankey-exclude-transfers-toggle').click()
    await expect(page.getByTestId('sankey-total-outflow')).toHaveText('$5,080.00')

    await page.getByTestId('sankey-basis-gross').click()
    await expect(page.getByTestId('sankey-total-inflow')).toHaveText('$6,530.00')
    await page.getByTestId('sankey-basis-net').click()
    await expect(page.getByTestId('sankey-total-inflow')).toHaveText('$6,500.00')

    // Sankey link click-through drill-down matches Dining Out $520.00
    await page.getByTestId('sankey-link-link_pool_dst_cat_dining').dispatchEvent('click')
    await expect(page.getByTestId('drilldown-drawer')).toBeVisible()
    await expect(page.getByTestId('drilldown-total')).toHaveText('$520.00')
    await page.getByTestId('drilldown-close-btn').click()
    await expect(page.getByTestId('drilldown-drawer')).toBeHidden()

    // 2. Category Trends (MoM & YoY) + anomaly badge drill-down
    await page.getByTestId('analytics-tab-trends').click()
    const trendsSvg = page.getByTestId('trends-svg')
    await expect(trendsSvg).toBeVisible()
    const trendsBox = await trendsSvg.boundingBox()
    expect(trendsBox).not.toBeNull()
    expect(trendsBox!.width).toBeGreaterThan(200)
    expect(trendsBox!.height).toBeGreaterThan(80)

    await page.getByTestId('trends-mode-yoy').click()
    await page.getByTestId('trends-mode-mom').click()

    const anomalyBadge = page.getByTestId('trend-anomaly-cat_dining-2026-11')
    await expect(anomalyBadge).toContainText('$520.00')
    await anomalyBadge.click()
    await expect(page.getByTestId('drilldown-drawer')).toBeVisible()
    await expect(page.getByTestId('drilldown-total')).toHaveText('$520.00')
    await page.getByTestId('drilldown-close-btn').click()

    // 3. Net Worth & Debt Payoff what-if controls (Snowball vs Avalanche + extra payment slider)
    await page.getByTestId('analytics-tab-net_worth').click()
    const nwSvg = page.getByTestId('networth-svg')
    await expect(nwSvg).toBeVisible()
    const nwBox = await nwSvg.boundingBox()
    expect(nwBox).not.toBeNull()
    expect(nwBox!.width).toBeGreaterThan(200)
    expect(nwBox!.height).toBeGreaterThan(60)

    await expect(page.getByTestId('networth-total')).toHaveText('$79,000.00')
    const baseDebtFreeDate = await page.getByTestId('debt-free-date').textContent()
    const baseInterestSaved = await page.getByTestId('debt-interest-saved').textContent()

    await page.getByTestId('debt-extra-monthly-slider').fill('50000')
    await expect(page.getByTestId('debt-free-date')).not.toHaveText(baseDebtFreeDate ?? '')
    await expect(page.getByTestId('debt-interest-saved')).not.toHaveText(baseInterestSaved ?? '')

    await page.getByTestId('debt-strategy-snowball').click()
    await page.getByTestId('debt-strategy-avalanche').click()

    // 4. Light/Dark theme toggle + zero horizontal overflow in light theme
    await page.getByTestId('theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    const lightOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    )
    expect(lightOverflow).toBe(true)

    // 5. Cross-filter + Saved View persistence across reload
    await page.getByTestId('analytics-tab-sankey').click()
    await page.getByTestId('filter-member-mem_sam').click()
    await page.getByTestId('filter-attribution-individual').click()
    await page.getByTestId('filter-tag-tag_discretionary').click()
    await expect(page.getByTestId('sankey-total-outflow')).toHaveText('$520.00')

    const viewName = 'E2E Sam Dining View'
    await page.getByTestId('saved-view-name-input').fill(viewName)
    await page.getByTestId('saved-view-save-btn').click()
    await expect(page.getByTestId('saved-views-bar')).toContainText(viewName)

    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByTestId('saved-views-bar')).toContainText(viewName)

    // 6. Zero external API requests and zero failed requests
    expect(externalRequests).toEqual([])
    expect(failedRequests).toEqual([])
  })
})
