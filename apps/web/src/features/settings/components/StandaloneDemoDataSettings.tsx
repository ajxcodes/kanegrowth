import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import type {
    StandaloneDemoDataPort,
    StandaloneDemoDataSnapshot,
} from '@ports/demoData/StandaloneDemoDataPort'
import type { StandaloneDemoStatus } from '@domain/standaloneDemo'
import { createStandaloneDemoDataService } from '@adapters/demoData/createStandaloneDemoDataService'
import ConfirmDialog from '@ui/ConfirmDialog'

const STATUS_LABELS: Record<StandaloneDemoStatus, string> = {
    demo: 'Demo data is loaded',
    custom: 'Your own data is loaded',
    empty: 'Workspace is empty',
}

type MutationKind = 'clear' | 'reset'

const ERROR_MESSAGES: Record<MutationKind, string> = {
    clear: 'Failed to clear demo data. Your data was not changed.',
    reset: 'Failed to reset demo data. Your data was not changed.',
}

const SUCCESS_MESSAGES: Record<MutationKind, string> = {
    clear: 'Demo data cleared',
    reset: 'Demo data reset',
}

const StandaloneDemoDataSettings: React.FC = () => {
    const [service, setService] = useState<StandaloneDemoDataPort | null>(null)
    const [snapshot, setSnapshot] = useState<StandaloneDemoDataSnapshot | null>(null)
    const [loading, setLoading] = useState(true)
    const [pending, setPending] = useState<MutationKind | null>(null)
    const [dialog, setDialog] = useState<MutationKind | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false

        const load = async () => {
            try {
                const resolved = await createStandaloneDemoDataService()
                if (cancelled) return
                setService(resolved)
                const current = await resolved.readSnapshot()
                if (!cancelled) setSnapshot(current)
            } catch {
                if (!cancelled) setError('Failed to load demo data status.')
            } finally {
                if (!cancelled) setLoading(false)
            }
        }

        void load()
        return () => {
            cancelled = true
        }
    }, [])

    const handleConfirm = async () => {
        if (!service || !dialog) return

        const kind = dialog
        setPending(kind)
        setError(null)
        try {
            const next =
                kind === 'clear'
                    ? await service.clearDemoData()
                    : await service.resetToDemoData()
            setSnapshot(next)
            toast.success(SUCCESS_MESSAGES[kind])
            setDialog(null)
        } catch {
            // The adapter's transaction has already rolled back, so the previous workspace is intact.
            const message = ERROR_MESSAGES[kind]
            setError(message)
            toast.error(message)
        } finally {
            setPending(null)
        }
    }

    const isBusy = pending !== null
    const clearDisabled = loading || isBusy || snapshot?.status === 'empty'
    const resetDisabled = loading || isBusy

    return (
        <div
            data-testid="standalone-demo-settings"
            className="rounded-xl border border-border-subtle bg-bg-secondary/40 p-4"
        >
            <p className="section-label mb-3">Standalone demo data</p>
            <p
                data-testid="demo-data-status"
                className="text-sm font-medium text-text-primary"
            >
                {snapshot ? STATUS_LABELS[snapshot.status] : 'Loading workspace data...'}
            </p>
            <p className="mt-1 text-xs text-text-muted">
                This device keeps its household records in a local SQLite store. Clear them to
                start fresh with your own finances, or load the canonical demo household again.
            </p>

            {error && (
                <p
                    data-testid="demo-data-error"
                    role="alert"
                    className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                    {error}
                </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
                <button
                    type="button"
                    data-testid="clear-demo-data-button"
                    onClick={() => setDialog('clear')}
                    disabled={clearDisabled}
                    className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-destructive/50 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Clear demo data
                </button>
                <button
                    type="button"
                    data-testid="reset-demo-data-button"
                    onClick={() => setDialog('reset')}
                    disabled={resetDisabled}
                    className="rounded-lg border border-accent/30 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent-subtle disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Reset to demo data
                </button>
            </div>

            <ConfirmDialog
                open={dialog === 'clear'}
                onClose={() => setDialog(null)}
                onConfirm={() => void handleConfirm()}
                title="Clear demo data"
                message="This deletes every household record stored on this device: accounts, transactions, categories, budgets, goals, tags, rules and templates. Your preferences are kept. This cannot be undone."
                confirmLabel="Clear data"
                loading={pending === 'clear'}
                confirmTestId="demo-data-confirm-clear"
            />
            <ConfirmDialog
                open={dialog === 'reset'}
                onClose={() => setDialog(null)}
                onConfirm={() => void handleConfirm()}
                title="Reset to demo data"
                message="This replaces every household record stored on this device with the canonical demo dataset. Any data you entered will be deleted. This cannot be undone."
                confirmLabel="Reset to demo"
                loading={pending === 'reset'}
                confirmTestId="demo-data-confirm-reset"
            />
        </div>
    )
}

export default StandaloneDemoDataSettings
