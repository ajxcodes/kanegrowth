import { expect, test } from '@playwright/test'

// Targets the `docker compose up` stack (as the CI compose job does): the ntfy service must
// accept the publish, the API must persist the row, and the SPA is served from the same origin.

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

test('notification center reads and dismisses persisted notifications and preferences survive a reload', async ({
  page,
  request,
}) => {
  const suffix = uniqueSuffix()
  const email = `notify-${suffix}@example.com`
  const password = 'Password123!'
  const title = `E2E bill ${suffix}`

  const register = await request.post('/api/v1/auth/register', {
    data: { email, password, fullName: 'Notify E2E' },
  })
  expect(register.ok()).toBeTruthy()
  const registered = await register.json()
  const token = registered.data.token as string
  const auth = { Authorization: `Bearer ${token}` }

  // Registering through the API leaves the legal gate closed; accept up front so the UI goes
  // straight to the dashboard.
  const accepted = await request.post('/api/v1/auth/legal/accept', {
    headers: auth,
    data: {},
  })
  expect(accepted.ok()).toBeTruthy()

  // Seed one bill reminder through the event ingress.
  const seeded = await request.post('/api/v1/notifications/events', {
    headers: auth,
    data: {
      type: 'bill_due',
      title,
      message: 'Seeded by the E2E suite',
      referenceType: 'recurring_rule',
      referenceId: 'e2e-rule',
      dedupeKey: 'e2e-bill',
    },
  })
  expect(seeded.ok()).toBeTruthy()
  const seededBody = await seeded.json()
  const notificationId = seededBody.data.notification._id as string

  // AC4 proof: the compose stack's ntfy service accepted the publish. Poll the row instead of
  // sleeping so the assertion is timing-independent.
  await expect
    .poll(
      async () => {
        const list = await request.get('/api/v1/notifications', { headers: auth })
        const payload = await list.json()
        const row = payload.data.notifications.find(
          (entry: { _id: string }) => entry._id === notificationId
        )
        return row?.ntfyStatus
      },
      { timeout: 20_000 }
    )
    .toBe('sent')

  // UI login. The API registration above set the shared context's refresh cookie, which would
  // make the guest-only /login route bounce straight to the dashboard; drop it first.
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel('Email address', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard/)
  await expect(page.getByTestId('notification-center-bell')).toBeVisible()

  // List -> read survives a reload.
  await page.getByTestId('notification-center-bell').click()
  await expect(page.getByText(title)).toBeVisible()
  await expect(page.getByTestId('notification-unread-badge')).toHaveText('1')
  await page.getByTestId('notification-mark-read').click()
  await expect(page.getByTestId('notification-unread-badge')).toHaveCount(0)

  await page.reload()
  await expect(page.getByTestId('notification-center-bell')).toBeVisible()
  await page.getByTestId('notification-center-bell').click()
  await expect(page.getByText(title)).toBeVisible()
  await expect(page.getByTestId('notification-mark-read')).toHaveCount(0)

  // Dismiss survives a reload.
  await page.getByTestId('notification-dismiss').click()
  await expect(page.getByText(title)).toHaveCount(0)

  await page.reload()
  await expect(page.getByTestId('notification-center-bell')).toBeVisible()
  await page.getByTestId('notification-center-bell').click()
  await expect(page.getByText(title)).toHaveCount(0)

  // Preferences persist through the dedicated endpoint and survive a reload.
  await page.getByRole('button', { name: 'Open settings' }).click()
  const toggle = page.getByTestId('bill-reminders-toggle')
  await expect(toggle).toBeChecked()
  await toggle.uncheck()

  await expect
    .poll(
      async () => {
        const prefs = await request.get('/api/v1/notifications/preferences', { headers: auth })
        const payload = await prefs.json()
        return payload.data.billRemindersEnabled
      },
      { timeout: 10_000 }
    )
    .toBe(false)

  await page.getByRole('button', { name: 'Close' }).click()
  await page.reload()
  await expect(page.getByTestId('notification-center-bell')).toBeVisible()
  await page.getByRole('button', { name: 'Open settings' }).click()
  await expect(page.getByTestId('bill-reminders-toggle')).not.toBeChecked()

  const preferences = await request.get('/api/v1/notifications/preferences', { headers: auth })
  const preferencesBody = await preferences.json()
  expect(preferencesBody.data.billRemindersEnabled).toBe(false)
})
