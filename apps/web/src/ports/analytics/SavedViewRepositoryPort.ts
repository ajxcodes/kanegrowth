import type { SavedAnalyticsView } from '@domain/analytics/types'

export interface SavedViewRepositoryPort {
  listSavedViews(workspaceId?: string | null): Promise<SavedAnalyticsView[]>
  saveView(view: SavedAnalyticsView): Promise<SavedAnalyticsView>
  deleteView(id: string): Promise<void>
}
