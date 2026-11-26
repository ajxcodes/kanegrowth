import React, { useState } from 'react'
import { FiBookmark, FiTrash2 } from 'react-icons/fi'
import type { SavedAnalyticsView } from '@domain/analytics/types'

interface SavedViewsBarProps {
  views: SavedAnalyticsView[]
  onSave: (name: string) => Promise<void>
  onApply: (view: SavedAnalyticsView) => void
  onDelete: (id: string) => Promise<void>
}

const SavedViewsBar: React.FC<SavedViewsBarProps> = ({
  views,
  onSave,
  onApply,
  onDelete,
}) => {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(name)
      setName('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      aria-label="Saved analytics views"
      data-testid="saved-views-bar"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-elevated px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
          <FiBookmark size={14} />
          Saved Views
        </span>
        {views.length === 0 ? (
          <span className="text-xs text-text-muted">No saved views yet</span>
        ) : (
          views.map((view) => (
            <div
              key={view.id}
              data-testid={`saved-view-chip-${view.id}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-secondary pl-3 pr-1.5 py-1 text-xs"
            >
              <button
                type="button"
                onClick={() => onApply(view)}
                className="font-medium text-text-primary hover:text-accent"
              >
                {view.name}
              </button>
              <button
                type="button"
                aria-label={`Delete saved view ${view.name}`}
                onClick={() => void onDelete(view.id)}
                className="rounded-full p-0.5 text-text-muted hover:text-negative"
              >
                <FiTrash2 size={12} />
              </button>
            </div>
          ))
        )}
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Save current view..."
          aria-label="Saved view name"
          data-testid="saved-view-name-input"
          className="w-40 sm:w-48 rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-muted"
        />
        <button
          type="submit"
          disabled={saving || !name.trim()}
          data-testid="saved-view-save-btn"
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-opacity disabled:opacity-50"
        >
          Save View
        </button>
      </form>
    </section>
  )
}

export default SavedViewsBar
