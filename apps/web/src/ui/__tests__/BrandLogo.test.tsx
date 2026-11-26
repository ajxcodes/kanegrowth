import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import BrandLogo from '../BrandLogo'

const DARK = '/icons/kanegrowth_logo_gold_green_transparent.png'
const LIGHT = '/icons/kanegrowth_logo_gold_green_transparent.png'

const renderLogo = (props: React.ComponentProps<typeof BrandLogo> = {}) =>
    render(
        <MemoryRouter>
            <BrandLogo {...props} />
        </MemoryRouter>,
    )

describe('BrandLogo', () => {
    afterEach(() => {
        cleanup()
        document.documentElement.removeAttribute('data-theme')
        localStorage.clear()
    })

    it('renders the single gold/green KaneGrowth mark for both themes across sizes, tagline, and links', async () => {
        expect(DARK).toBe('/icons/kanegrowth_logo_gold_green_transparent.png')
        expect(LIGHT).toBe('/icons/kanegrowth_logo_gold_green_transparent.png')

        document.documentElement.setAttribute('data-theme', 'dark')
        const { unmount } = renderLogo({ size: 'sm', showTagline: true, linkTo: '/dashboard' })
        const img = screen.getByAltText('KaneGrowth logo')
        expect(img.getAttribute('src')).toBe(DARK)
        expect(screen.getByText('KaneGrowth')).toBeTruthy()
        expect(screen.getByRole('link').getAttribute('href')).toBe('/dashboard')
        expect(screen.getByText('Building wealth from good habits at home.')).toBeTruthy()

        act(() => {
            document.documentElement.setAttribute('data-theme', 'light')
        })
        await waitFor(() => expect(screen.getByAltText('KaneGrowth logo').getAttribute('src')).toBe(LIGHT))
        unmount()

        document.documentElement.setAttribute('data-theme', 'light')
        for (const size of ['sm', 'md', 'lg'] as const) {
            const view = renderLogo({ size, linkTo: null })
            expect(screen.getByAltText('KaneGrowth logo').getAttribute('src')).toBe(LIGHT)
            expect(screen.getByText('KaneGrowth')).toBeTruthy()
            expect(screen.queryByRole('link')).toBeNull()
            view.unmount()
        }
    })
})
