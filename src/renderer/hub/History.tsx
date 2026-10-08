import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppStatus, DictationMode, HistoryKeep, HistoryPage, HistoryRow } from '@shared/ipc'
import { HISTORY_KEEPS, MOST_HISTORY_ROWS } from '@shared/ipc-values'
import { dictationKeyLabel } from '@shared/keycodes'
import { PRODUCT_NAME } from '@shared/product'
import { whenSettled } from './answers'
import {
  Button,
  Field,
  ICONS,
  Icon,
  Keys,
  Notice,
  PageTitle,
  PopUp,
  Toggle,
  useSaidForAMoment,
} from './components'
import { DictationRow, ROW_COLUMNS_WITH_ACTION } from './DictationRow'
import { counted } from './format'
import {
  KEEP_LABELS,
  LIST_UNREAD,
  groupByDay,
  historyProblems,
  keepNotice,
  rowView,
} from './history-view'
import { useFacts } from './use-facts'

const SEARCH_AFTER_MS = 150
const NO_ROWS: HistoryRow[] = []

/**
 * History: every dictation, newest first, under its day. By default the list is held
 * in memory and gone when the app quits; keeping it on disk is chosen here, and asked
 * again in a dialog of the system's.
 *
 * The list is one stop for the keyboard: the arrows move through it, Return opens a
 * row, ⌘C copies it and Delete removes it. The same things are in each row's menu.
 */
export function History(props: {
  status: AppStatus
  /** False while one of its dictations is open over it: the list is kept, and not drawn. */
  shown: boolean
  onChanged: () => void
  onOpen: (id: string) => void
}) {
  const { status, onChanged, shown } = props
  const { history } = status
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const { said: copied, say } = useSaidForAMoment()
  const list = useRef<HTMLDivElement>(null)

  // Back from an opened dictation: the keyboard returns to the list, on the row it left.
  const wasShown = useRef(shown)
  useEffect(() => {
    if (shown && !wasShown.current) list.current?.focus()
    wasShown.current = shown
  }, [shown])

  // The list is asked for when the search has settled, and whenever the history changes.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), SEARCH_AFTER_MS)
    return () => clearTimeout(timer)
  }, [typed])
  const {
    facts: page,
    failed,
    refresh,
  } = useFacts<HistoryPage>(
    () => window.flowHub.getHistory({ search, limit: MOST_HISTORY_ROWS }),
    null,
    `${search}\n${history.version}`,
  )
  const rows = page?.rows ?? NO_ROWS
  // The page is drawn again each time the status is asked for, every second and a half;
  // the days are worked out again only for another list, or on another day.
  const today = new Date().toDateString()
  const days = useMemo(() => groupByDay(rows, new Date()), [rows, today])
  const empty = history.count === 0
  // A row that was selected and is gone (deleted from its menu, or expired) hands the
  // selection to the row that took its place, so that the arrows go on from there.
  const selectedAt = useRef(-1)
  useEffect(() => {
    const listed = page?.rows ?? []
    if (selected === null) return
    const at = listed.findIndex((row) => row.id === selected)
    if (at !== -1) {
      selectedAt.current = at
      return
    }
    if (!page) return
    setSelected(listed[Math.min(Math.max(selectedAt.current, 0), listed.length - 1)]?.id ?? null)
  }, [page, selected])
  // The same functions from one drawing to the next, so that a row that has not changed
  // is not drawn again.
  const done = useCallback((): void => {
    onChanged()
    refresh()
  }, [onChanged, refresh])
  const after = (asked: Promise<unknown>): void => whenSettled(asked, done)

  const copy = useCallback(
    (id: string): void => {
      void window.flowHub.copyHistoryEntry(id, 'written').then((made) => {
        if (made) say(id)
        done()
      }, done)
    },
    [say, done],
  )
  const remove = (id: string): void => {
    // The keyboard stays in the list: the row after the one that went is selected.
    const at = rows.findIndex((row) => row.id === id)
    setSelected(rows[at + 1]?.id ?? rows[at - 1]?.id ?? null)
    after(window.flowHub.deleteHistoryEntry(id))
  }
  const menu = (id: string): void => {
    setSelected(id)
    void window.flowHub.historyMenu(id).then((chosen) => {
      if (chosen === 'open') props.onOpen(id)
      done()
    }, done)
  }
  const move = (step: number): void => {
    const at = rows.findIndex((row) => row.id === selected)
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + step))] ?? rows[0]
    if (!next) return
    setSelected(next.id)
    list.current?.querySelector(`[data-row="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const notice = keepNotice(history.keep, PRODUCT_NAME)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-none flex-col gap-3.5 border-b border-line px-8 pt-10 pb-3.5 compact:px-6 compact:pt-6">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <PageTitle>History</PageTitle>
          </div>
          <label className="flex flex-none items-center gap-2.5 whitespace-nowrap">
            <span>Pause history</span>
            <Toggle
              label="Pause history"
              on={history.paused}
              onChange={(paused) =>
                after(window.flowHub.changePreference({ historyPaused: paused }))
              }
            />
          </label>
        </div>
        <div className="flex items-center gap-2.5">
          <Field
            label="Search"
            placeholder="Search"
            value={typed}
            onChange={setTyped}
            disabled={empty}
            className="flex-1"
            icon={<Icon d={ICONS.search} size={13} strokeWidth={1.5} className="text-ink-2" />}
          />
          <span className="flex-none text-ink-2">Keep</span>
          <PopUp
            label="Keep"
            value={history.keep}
            options={HISTORY_KEEPS.map((keep) => ({ value: keep, label: KEEP_LABELS[keep] }))}
            onChange={(keep) => after(window.flowHub.setHistoryKeep(keep as HistoryKeep))}
          />
          <Button
            disabled={
              empty && history.leftOnDisk === 0 && !history.disk?.files && !history.disk?.scanFailed
            }
            onClick={() => after(window.flowHub.deleteAllHistory())}
          >
            Delete All…
          </Button>
        </div>
      </header>

      {/* Where the list lives. Amber only when what was said is written to disk. */}
      {history.keep === 'session' ? (
        <p
          data-notice="memory"
          className="flex flex-none items-center gap-2.5 border-b border-line bg-card px-8 py-2.5 text-caption text-ink-2 compact:px-6"
        >
          <Icon d={ICONS.chip} size={15} strokeWidth={1.3} />
          <span className="text-pretty">
            <span className="font-medium text-ink">{notice.lead}</span> {notice.rest}
          </span>
        </p>
      ) : (
        <p
          data-notice="disk"
          className="flex flex-none items-center gap-2.5 border-b border-saving-line bg-saving-bg px-8 py-2.5 text-caption text-saving compact:px-6"
        >
          <Icon d={ICONS.save} size={15} />
          {/* The longest of these takes two lines in a window of the first size: no word is left alone on the second. */}
          <span className="text-pretty">
            <span className="font-semibold">{notice.lead}</span> {notice.rest}
          </span>
        </p>
      )}

      {historyProblems(history).map((problem) => (
        <div key={problem.name} className="mx-8 mt-3.5 flex-none compact:mx-6">
          <Notice name={problem.name} title={problem.title}>
            {problem.body}
          </Notice>
        </div>
      ))}

      {failed && !empty && (
        <div className="mx-8 mt-3.5 flex-none compact:mx-6">
          <Notice
            name="history-unread"
            title={LIST_UNREAD}
            actions={<Button onClick={refresh}>Try Again</Button>}
          />
        </div>
      )}

      {history.leftOnDisk > 0 && (
        <div className="mx-8 mt-3.5 flex-none compact:mx-6">
          <Notice name="history-left" title="Dictations saved earlier are still on this Mac">
            They are not listed here ({counted(history.leftOnDisk, 'file')} on disk): the settings
            no longer say how long to keep them, or they could not be deleted. Choose a time under
            Keep to list them again, or Delete All to remove them.
          </Notice>
        </div>
      )}

      {history.paused && (
        <div className="mx-8 mt-3.5 flex-none compact:mx-6">
          <Notice
            name="history-paused"
            title="History is paused"
            icon={<Icon d={ICONS.pause} size={18} strokeWidth={1.5} className="mt-px" />}
            actions={
              <Button
                prominent
                onClick={() => after(window.flowHub.changePreference({ historyPaused: false }))}
              >
                Resume History
              </Button>
            }
          >
            New dictations are not added. Dictation still works, and ⌘⌃V still pastes the last one.
          </Notice>
        </div>
      )}

      {empty ? (
        <EmptyHistory status={status} />
      ) : (
        <div
          ref={list}
          role="listbox"
          aria-label="Dictations"
          aria-activedescendant={selected ? `row-${selected}` : undefined}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-4 outline-offset-[-3px] compact:px-3"
          onFocus={() => {
            if (!selected || !rows.some((row) => row.id === selected)) {
              setSelected(rows[0]?.id ?? null)
            }
          }}
          onKeyDown={(event) => {
            const copies = event.key.toLowerCase() === 'c' && event.metaKey
            const deletes = event.key === 'Delete' || event.key === 'Backspace'
            if (event.key === 'ArrowDown') move(1)
            else if (event.key === 'ArrowUp') move(-1)
            // One press, one dictation: a key that is held goes on moving through the list,
            // and does not open, copy or delete a row for every repeat. Nothing asks before
            // a row is deleted, and with the history in memory there is no other copy of it.
            else if (event.repeat && (deletes || copies || event.key === 'Enter')) {
              // Swallowed, so that a held Backspace does not become "back" either.
            } else if (event.key === 'Enter' && selected) props.onOpen(selected)
            else if (copies && selected) copy(selected)
            else if (deletes && selected) remove(selected)
            else return
            event.preventDefault()
          }}
          onContextMenu={(event) => {
            // From the keyboard (VoiceOver's menu command) it is the selected row's menu.
            event.preventDefault()
            const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row]')
            const id = row?.dataset['row'] ?? selected
            if (id) menu(id)
          }}
        >
          {rows.length === 0 && page && (
            <p className="px-3 pt-5 text-ink-2">No dictation holds “{search}”.</p>
          )}
          {days.map((group) => (
            <div key={group.day} role="group" aria-label={group.day}>
              <div className="px-3 pt-4 pb-1.5 text-heading text-ink-2">{group.day}</div>
              {group.rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  mode={status.mode}
                  selected={row.id === selected}
                  copied={row.id === copied}
                  onOpen={props.onOpen}
                  onCopy={copy}
                />
              ))}
            </div>
          ))}
          {page && page.matched > rows.length && (
            <p className="px-3 pt-4 text-caption text-ink-2">
              The newest {rows.length} of {counted(page.matched, 'dictation')} are listed. Search
              finds the others.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** One row of the list. It is drawn again only when what it shows has changed. */
const Row = memo(function Row(props: {
  row: HistoryRow
  /** The mode in use now: a glyph marks a dictation made in the other one. */
  mode: DictationMode
  selected: boolean
  copied: boolean
  onOpen: (id: string) => void
  onCopy: (id: string) => void
}) {
  const view = rowView(props.row, props.mode)
  return (
    <div
      id={`row-${props.row.id}`}
      role="option"
      aria-selected={props.selected}
      data-row={props.row.id}
      onClick={() => props.onOpen(props.row.id)}
      className={`group grid h-10 items-center gap-3 rounded-control px-3 hover:bg-row-hover ${ROW_COLUMNS_WITH_ACTION} ${
        props.selected ? 'bg-fill-selected shadow-selected' : ''
      }`}
    >
      <DictationRow
        row={view}
        action={
          // The pointer's way to Copy. The keyboard's is ⌘C, and the row's menu has it too.
          view.said && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Copy"
              onClick={(event) => {
                event.stopPropagation()
                props.onCopy(props.row.id)
              }}
              className={`h-[22px] items-center rounded-control bg-control px-2.5 text-caption font-medium shadow-control ${
                props.copied ? 'inline-flex' : 'hidden group-hover:inline-flex'
              }`}
            >
              {props.copied ? 'Copied' : 'Copy'}
            </button>
          )
        }
      />
    </div>
  )
})

/** Before the first dictation: the gesture, and where the list will live. */
function EmptyHistory({ status }: { status: AppStatus }) {
  const keep = status.history.keep
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-12 pb-[60px]">
      <div className="flex max-w-[380px] flex-col items-center gap-3.5 text-center">
        <svg
          width="44"
          height="44"
          viewBox="0 0 44 44"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          className="text-ink-2"
          aria-hidden="true"
        >
          <rect x="6" y="9" width="32" height="26" rx="5" />
          <path d="M12 17h20M12 22h14M12 27h9" />
        </svg>
        <h2 className="text-[17px] font-semibold">No dictations yet</h2>
        {/* One sentence with the key in it: it wraps as a sentence does. */}
        <p className="leading-[1.9] text-pretty text-ink-2">
          Hold{' '}
          <Keys caps={[dictationKeyLabel(status.dictationKey)]} className="mx-0.5 align-middle" />{' '}
          and speak in any app. What you say appears here,{' '}
          {keep === 'session'
            ? 'held in memory until you quit.'
            : keep === 'forever'
              ? 'and is kept until you delete it.'
              : `and is kept for ${KEEP_LABELS[keep]}.`}
        </p>
      </div>
    </div>
  )
}
