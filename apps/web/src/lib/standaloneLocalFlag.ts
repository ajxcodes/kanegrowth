/**
 * Gates KaneGrowth standalone offline-first mode (`--mode standalone` / `.env.standalone`),
 * allowing the Web UI and E2E suite to boot with a local household profile and SQLite store
 * with zero remote API server dependency.
 */
export const isStandaloneLocalEnabled = (): boolean => import.meta.env.VITE_STANDALONE_LOCAL === 'true'
