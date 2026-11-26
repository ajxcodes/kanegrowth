export type AppTheme = 'dark' | 'light'

export const THEME_STORAGE_KEY = 'kanegrowth_theme'
export const THEME_CHANGE_EVENT = 'kanegrowth:theme-change'

function readStoredTheme(): AppTheme | null {
    if (typeof window === 'undefined') return null
    try {
        const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
        if (stored === 'light' || stored === 'dark') return stored
    } catch {
        // Ignore restricted storage
    }
    return null
}

/** Resolve the active theme from the DOM attribute, persisted preference, or dark default. */
export function resolveCurrentTheme(): AppTheme {
    if (typeof document !== 'undefined') {
        const attr = document.documentElement.getAttribute('data-theme')
        if (attr === 'light' || attr === 'dark') return attr
    }
    return readStoredTheme() ?? 'dark'
}

/** Apply the given theme to `<html data-theme>`, persist it, and notify listeners. */
export function applyTheme(theme: AppTheme): AppTheme {
    if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', theme)
    }
    if (typeof window !== 'undefined') {
        try {
            window.localStorage.setItem(THEME_STORAGE_KEY, theme)
        } catch {
            // Ignore restricted storage
        }
        window.dispatchEvent(new CustomEvent<AppTheme>(THEME_CHANGE_EVENT, { detail: theme }))
    }
    return theme
}

/** Initialize `<html data-theme>` on boot from persisted preference or default dark theme. */
export function initTheme(): AppTheme {
    const theme = readStoredTheme() ?? resolveCurrentTheme()
    if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', theme)
    }
    return theme
}
