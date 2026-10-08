import type { ReactNode } from 'react'
import { AppTile, Chip, ModeMark } from './components'
import type { RowView } from './history-view'

/**
 * One dictation as a row: when, the app it was meant for, the start of its text, a
 * chip when it was not simply pasted, and a glyph when its mode was not the usual one.
 * Home's "Recent" and the History page draw the same row, so that a chip and a glyph
 * mean the same thing in both.
 */
export function DictationRow({ row, action }: { row: RowView; action?: ReactNode }) {
  return (
    <>
      <span className="text-caption text-ink-2 tabular-nums">{row.time}</span>
      <AppTile name={row.app} />
      {/* What was said is marked as such: a picture taken for a test leaves it blank. */}
      <span
        className={`truncate ${row.muted ? 'text-ink-2' : ''}`}
        {...(row.said ? { 'data-said': '' } : {})}
      >
        {row.text}
      </span>
      <span className="flex">{row.chip && <Chip icon={row.chip.icon}>{row.chip.text}</Chip>}</span>
      <span className="flex w-4 justify-center">{row.glyph && <ModeMark glyph={row.glyph} />}</span>
      {action !== undefined && <span className="flex justify-end">{action}</span>}
    </>
  )
}

/** The columns of a row, with and without room for an action at its end. */
export const ROW_COLUMNS = 'grid-cols-[44px_20px_minmax(0,1fr)_auto_16px]'
export const ROW_COLUMNS_WITH_ACTION = 'grid-cols-[44px_20px_minmax(0,1fr)_auto_16px_52px]'
