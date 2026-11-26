import React, { useEffect, useState } from 'react'
import { FiMoon, FiSun } from 'react-icons/fi'
import { applyTheme, resolveCurrentTheme, type AppTheme } from '@lib/theme'

export type { AppTheme }

interface ThemeToggleProps {
  onThemeChange?: (theme: AppTheme) => void
}

const ThemeToggle: React.FC<ThemeToggleProps> = ({ onThemeChange }) => {
  const [theme, setTheme] = useState<AppTheme>(resolveCurrentTheme)

  useEffect(() => {
    applyTheme(theme)
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
