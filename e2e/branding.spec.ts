import { test, expect, type Page } from '@playwright/test'

const DARK = '/icons/kanegrowth_logo_gold_green_transparent.png'
const LIGHT = '/icons/kanegrowth_logo_gold_green_transparent.png'

async function expectLogo(page: Page, src: string) {
  const logo = page.locator('[data-testid="brand-logo-icon"]:visible').first()
  await expect(logo).toBeVisible()
  await expect(logo).toHaveAttribute('src', src)
  await expect(logo).toHaveAttribute('alt', 'KaneGrowth logo')
  await expect
    .poll(() => logo.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await expect(page.getByText('KaneGrowth', { exact: true }).locator('visible=true').first()).toBeVisible()
}

async function expectNoOverflow(page: Page) {
  const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  expect(ok).toBe(true)
}

test('renders theme-aware KaneGrowth logo and wordmark with naturalWidth > 0 in light and dark themes across Desktop and Mobile', async ({
  page,
}) => {
  const failedRequests: string[] = []
  page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url()}`))

  await page.addInitScript(() => {
    if (!localStorage.getItem('kanegrowth_theme')) localStorage.setItem('kanegrowth_theme', 'dark')
  })
  await page.goto('/analytics', { waitUntil: 'networkidle' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page).toHaveTitle(/KaneGrowth/)
  await expectLogo(page, DARK)
  await expectNoOverflow(page)

  await page.locator('[data-testid="theme-toggle"]:visible').first().click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expectLogo(page, LIGHT)
  await expectNoOverflow(page)

  for (const [route, theme, src] of [
    ['/download', 'dark', DARK],
    ['/download', 'light', LIGHT],
    ['/privacy', 'dark', DARK],
    ['/privacy', 'light', LIGHT],
  ] as const) {
    await page.evaluate((t) => localStorage.setItem('kanegrowth_theme', t), theme)
    await page.goto(route, { waitUntil: 'networkidle' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page).toHaveTitle(/KaneGrowth/)
    await expectLogo(page, src)
    await expectNoOverflow(page)
  }

  expect(failedRequests).toEqual([])
})
