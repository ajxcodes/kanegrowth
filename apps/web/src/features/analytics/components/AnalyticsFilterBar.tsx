import React from 'react'
import type {
  AnalyticsFilter,
  AttributionMode,
  DateRangePreset,
} from '@domain/analytics/types'
import type { AnalyticsMetadata } from '../hooks/useAnalyticsData'

interface AnalyticsFilterBarProps {
  filter: AnalyticsFilter
  metadata: AnalyticsMetadata
  onChange: (updater: (prev: AnalyticsFilter) => AnalyticsFilter) => void
  onReset: () => void
}

const toggleInList = (list: string[], id: string): string[] =>
  list.includes(id) ? list.filter((item) => item !== id) : [...list, id]

const DATE_PRESETS: Array<{ value: DateRangePreset; label: string }> = [
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'ytd', label: 'YTD' },
  { value: 'last_12_months', label: 'Last 12 Months' },
  { value: 'custom', label: 'Custom' },
]

const ATTRIBUTION_MODES: Array<{ value: AttributionMode; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'shared', label: 'Shared' },
  { value: 'individual', label: 'Individual' },
]

const AnalyticsFilterBar: React.FC<AnalyticsFilterBarProps> = ({
  filter,
  metadata,
  onChange,
  onReset,
}) => {
  const hasActiveFilters =
    filter.accountIds.length > 0 ||
    filter.categoryIds.length > 0 ||
    filter.tagIds.length > 0 ||
    filter.memberIds.length > 0 ||
    filter.attributionMode !== 'all' ||
    filter.includeTransfers ||
    filter.flowBasis !== 'net' ||
    filter.dateRangePreset !== 'this_month'

  return (
    <section
      aria-label="Analytics cross-filters"
      data-testid="analytics-filter-bar"
      className="rounded-xl border border-border bg-elevated p-4 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs font-medium text-text-muted" htmlFor="analytics-date-preset">
            Date Range
          </label>
          <select
            id="analytics-date-preset"
            data-testid="filter-date-preset"
            value={filter.dateRangePreset}
            onChange={(e) => {
              const preset = e.target.value as DateRangePreset
              onChange((prev) => ({
                ...prev,
                dateRangePreset: preset,
                startDate: preset === 'custom' ? (prev.startDate ?? '2026-01-01') : null,
                endDate: preset === 'custom' ? (prev.endDate ?? prev.asOfDate) : null,
              }))
            }}
            className="rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-text-primary"
          >
            {DATE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>

          {filter.dateRangePreset === 'custom' && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                aria-label="Start date"
                data-testid="filter-start-date"
                value={filter.startDate ?? '2026-01-01'}
                onChange={(e) => onChange((prev) => ({ ...prev, startDate: e.target.value }))}
                className="rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
              />
              <span className="text-xs text-text-muted">to</span>
              <input
                type="date"
                aria-label="End date"
                data-testid="filter-end-date"
                value={filter.endDate ?? filter.asOfDate}
                onChange={(e) => onChange((prev) => ({ ...prev, endDate: e.target.value }))}
                className="rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary"
              />
            </div>
          )}

          <div className="inline-flex rounded-lg border border-border bg-bg-secondary p-0.5">
            {ATTRIBUTION_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                data-testid={`filter-attribution-${m.value}`}
                onClick={() => onChange((prev) => ({ ...prev, attributionMode: m.value }))}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  filter.attributionMode === m.value
                    ? 'bg-accent text-on-accent'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {hasActiveFilters && (
          <button
            type="button"
            data-testid="filter-reset"
            onClick={onReset}
            className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-elevated-hover"
          >
            Reset Filters
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-1.5 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Accounts
          </div>
          <div className="flex flex-wrap gap-1.5">
            {metadata.accounts.map((acc) => {
              const active = filter.accountIds.includes(acc.id)
              return (
                <button
                  key={acc.id}
                  type="button"
                  data-testid={`filter-account-${acc.id}`}
                  aria-pressed={active}
                  onClick={() =>
                    onChange((prev) => ({
                      ...prev,
                      accountIds: toggleInList(prev.accountIds, acc.id),
                    }))
                  }
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    active
                      ? 'border-accent bg-accent text-on-accent'
                      : 'border-border bg-bg-secondary text-text-secondary hover:border-accent'
                  }`}
                >
                  {acc.name}
                </button>
              )
            })}
          </div>
        </div>

        <div className="space-y-1.5 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Categories / Envelopes
          </div>
          <div className="flex flex-wrap gap-1.5">
            {metadata.categories.map((cat) => {
              const active = filter.categoryIds.includes(cat.id)
              return (
                <button
                  key={cat.id}
                  type="button"
                  data-testid={`filter-category-${cat.id}`}
                  aria-pressed={active}
                  onClick={() =>
                    onChange((prev) => ({
                      ...prev,
                      categoryIds: toggleInList(prev.categoryIds, cat.id),
                    }))
                  }
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    active
                      ? 'border-accent bg-accent text-on-accent'
                      : 'border-border bg-bg-secondary text-text-secondary hover:border-accent'
                  }`}
                >
                  {cat.name}
                </button>
              )
            })}
          </div>
        </div>

        <div className="space-y-1.5 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Tags
          </div>
          <div className="flex flex-wrap gap-1.5">
            {metadata.tags.map((tag) => {
              const active = filter.tagIds.includes(tag.id)
              return (
                <button
                  key={tag.id}
                  type="button"
                  data-testid={`filter-tag-${tag.id}`}
                  aria-pressed={active}
                  onClick={() =>
                    onChange((prev) => ({
                      ...prev,
                      tagIds: toggleInList(prev.tagIds, tag.id),
                    }))
                  }
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    active
                      ? 'border-accent bg-accent text-on-accent'
                      : 'border-border bg-bg-secondary text-text-secondary hover:border-accent'
                  }`}
                >
                  #{tag.name}
                </button>
              )
            })}
          </div>
        </div>

        <div className="space-y-1.5 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Household Members
          </div>
          <div className="flex flex-wrap gap-1.5">
            {metadata.members.map((member) => {
              const active = filter.memberIds.includes(member.id)
              return (
                <button
                  key={member.id}
                  type="button"
                  data-testid={`filter-member-${member.id}`}
                  aria-pressed={active}
                  onClick={() =>
                    onChange((prev) => ({
                      ...prev,
                      memberIds: toggleInList(prev.memberIds, member.id),
                    }))
                  }
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    active
                      ? 'border-accent bg-accent text-on-accent'
                      : 'border-border bg-bg-secondary text-text-secondary hover:border-accent'
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: member.color }}
                  />
                  {member.name}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

export default AnalyticsFilterBar
