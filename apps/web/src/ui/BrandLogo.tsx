import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BRAND } from '@lib/brand'
import {
    resolveCurrentTheme,
    THEME_CHANGE_EVENT,
    THEME_STORAGE_KEY,
    type AppTheme,
} from '@lib/theme'

interface BrandLogoProps {
    showTagline?: boolean
    size?: 'sm' | 'md' | 'lg'
    linkTo?: string | null
}

const textSizeClasses = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-3xl',
} as const

const iconSizeClasses = {
    sm: 'h-7 w-7',
    md: 'h-9 w-9',
    lg: 'h-11 w-11',
} as const

const LOGO_SRC_BY_THEME: Record<AppTheme, string> = {
    light: '/icons/kanegrowth_logo_bonsai_transparent.png',
    dark: '/icons/kanegrowth_logo_bonsai_dark_transparent.png',
}

const BrandLogo: React.FC<BrandLogoProps> = ({
    showTagline = false,
    size = 'md',
    linkTo = '/',
}) => {
    const [theme, setTheme] = useState<AppTheme>(resolveCurrentTheme)

    useEffect(() => {
        const syncTheme = () => setTheme(resolveCurrentTheme())
        syncTheme()

        const observer =
            typeof MutationObserver !== 'undefined'
                ? new MutationObserver(syncTheme)
                : null
        if (observer && typeof document !== 'undefined') {
            observer.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['data-theme'],
            })
        }

        const handleStorage = (event: StorageEvent) => {
            if (event.key === null || event.key === THEME_STORAGE_KEY) {
                syncTheme()
            }
        }

        window.addEventListener(THEME_CHANGE_EVENT, syncTheme)
        window.addEventListener('storage', handleStorage)

        return () => {
            observer?.disconnect()
            window.removeEventListener(THEME_CHANGE_EVENT, syncTheme)
            window.removeEventListener('storage', handleStorage)
        }
    }, [])

    const content = (
        <div className="inline-flex flex-col">
            <span className="inline-flex items-center gap-2.5">
                <img
                    src={LOGO_SRC_BY_THEME[theme]}
                    alt="KaneGrowth logo"
                    data-testid="brand-logo-icon"
                    className={`${iconSizeClasses[size]} shrink-0 object-contain`}
                />
                <span className={`font-display font-bold tracking-tight ${textSizeClasses[size]}`}>
                    <span className="text-gradient-accent">{BRAND.name}</span>
                </span>
            </span>
            {showTagline && (
                <p className="text-xs text-text-muted mt-0.5 font-body">{BRAND.tagline}</p>
            )}
        </div>
    )

    if (linkTo === null) {
        return content
    }

    return (
        <Link
            to={linkTo}
            className="inline-block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded-sm"
        >
            {content}
        </Link>
    )
}

export default BrandLogo
