import React, { useEffect, useState } from 'react'
import { FiMoon, FiSun } from 'react-icons/fi'

const THEME_STORAGE_KEY = 'kanegrowth_theme'

export type AppTheme = 'dark' | 'light'

const getInitialTheme = (): AppTheme => {
  if (typeof window === 'undefined') return 'dark'
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'light' || attr === 'dark') return attr
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return 'dark'
}

interface ThemeToggleProps {
  onThemeChange?: (theme: AppTheme) => void
}

const ThemeToggle: React.FC<ThemeToggleProps> = ({ onThemeChange }) => {
  const [theme, setTheme] = useState<AppTheme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Ignore restricted storage
    }
    onThemeChange?.(theme)
  }, [theme, onThemeChange])

  const toggle = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-elevated-hover"
    >
      {theme === 'dark' ? <FiSun size={14} /> : <FiMoon size={14} />}
      <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
    </button>
  )
}

export default ThemeToggle
