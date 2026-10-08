import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppStatus, HistoryEntry, HubPage } from '@shared/ipc'
import { whenSettled } from './answers'
import { AppTile, Button, ICONS, Icon, Notice, useSaidForAMoment } from './components'
import {
  ENTRY_UNREAD,
  NOT_DELETED,
  detailLine,
  diffMarks,
  modeWords,
  outcomeWords,
  reasonFor,
  timingRows,
  type Mark,
  type ReasonFix,
} from './history-view'
import { useFacts } from './use-facts'

/**
 * One dictation, opened: how it ended and in which mode, why it went as it did when
 * there is something to explain, what was heard beside what was written, and where
 * the time went.
 */
export function HistoryDetail(props: {
  id: string
  status: AppStatus
  onBack: () => void
  onChanged: () => void
  onPage: (page: HubPage) => void
}) {
  const { id, status } = props
  const {
    facts: entry,
    failed,
    refresh,
  } = useFacts<HistoryEntry | 'gone'>(
    () => window.flowHub.getHistoryEntry(id).then((found) => found ?? 'gone'),
    null,
    `${id}\n${status.history.version}`,
  )
  /** Says for a moment that something was done, where the button that did it is. */
  const { said: done, say } = useSaidForAMoment()
  /** The dictation a Delete failed for, while it is the one open. */
  const [notDeleted, setNotDeleted] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const loaded = entry !== null && entry !== 'gone'
  // Word against word, which costs with the square of the length: worked out when the texts
  // change, and not at every drawing. The page is drawn again each time the status is asked.
  const heard = loaded ? entry.heard : ''
  const written = loaded ? entry.written : ''
  const marks = useMemo(
    () => (heard !== written && heard.length > 0 ? diffMarks(heard, written) : null),
    [heard, written],
  )
  // The page has changed under the keyboard: it starts again from the top of this one.
  useEffect(() => {
    if (loaded) heading.current?.focus()
  }, [id, loaded])

  const copy = (which: 'written' | 'heard'): void => {
    void window.flowHub.copyHistoryEntry(id, which).then((made) => {
      if (made) say(which)
      props.onChanged()
    }, props.onChanged)
  }
  const remove = (): void => {
    setNotDeleted(null)
    void window.flowHub.deleteHistoryEntry(id).then(
      () => {
        props.onChanged()
        props.onBack()
      },
      () => {
        // It is still here, and the page stays on it.
        setNotDeleted(id)
        props.onChanged()
      },
    )
  }

  const back = (
    <button
      type="button"
      // The sidebar has a button that says "History" as well: this one is the way back.
      data-name="Back to History"
      onClick={props.onBack}
      className="flex items-center gap-1.5 self-start rounded-[3px] text-caption text-ink-2"
    >
      <Icon d={ICONS.back} size={10} strokeWidth={1.8} />
      History
    </button>
  )
  if (entry === null) {
    return (
      <div className="flex flex-col gap-4 px-8 pt-10">
        {back}
        {failed && (
          <Notice
            name="entry-unread"
            title={ENTRY_UNREAD}
            actions={<Button onClick={refresh}>Try Again</Button>}
          />
        )}
      </div>
    )
  }
  if (entry === 'gone') {
    return (
      <div className="flex flex-col gap-4 px-8 pt-10">
        {back}
        <p className="text-ink-2">This dictation is no longer in the history.</p>
      </div>
    )
  }

  const reason = reasonFor(entry, {
    cleanupLine: status.cleanup,
    ollamaInstalled: status.ollamaInstalled,
  })
  const fixes: Record<ReasonFix, { label: string; run: () => void }> = {
    copy: { label: done === 'written' ? 'Copied' : 'Copy', run: () => copy('written') },
    startOllama: {
      label: 'Start Ollama',
      run: () => whenSettled(window.flowHub.startOllama(), props.onChanged),
    },
    getOllama: { label: 'Get Ollama', run: () => void window.flowHub.openLink('ollama') },
    cleanup: { label: 'Open Cleanup', run: () => props.onPage('cleanup') },
  }
  const fix = reason?.fix ? fixes[reason.fix] : null
  const timings = timingRows(entry)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-8 pt-10 pb-5 compact:px-6 compact:pt-6">
      {back}
      <div className="flex items-center gap-3">
        <AppTile name={entry.app} large />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <h1 ref={heading} tabIndex={-1} className="truncate text-title outline-none">
            {entry.app ?? 'A dictation'}
          </h1>
          <span className="text-caption text-ink-2">{detailLine(entry, new Date())}</span>
        </div>
        <Button disabled={entry.written.length === 0} onClick={() => copy('written')}>
          {done === 'written' ? 'Copied' : 'Copy'}
        </Button>
        <Button onClick={remove}>Delete</Button>
      </div>

      {notDeleted === id && <Notice name="not-deleted" title={NOT_DELETED} />}

      <dl className="grid grid-cols-2 border-y border-line">
        <div className="flex flex-col gap-[3px] py-[11px]">
          <dt className="text-caption text-ink-2">Outcome</dt>
          <dd className="font-medium">{outcomeWords(entry)}</dd>
        </div>
        <div className="flex flex-col gap-[3px] border-l border-line py-[11px] pl-4">
          <dt className="text-caption text-ink-2">Mode</dt>
          <dd className="font-medium">{modeWords(entry)}</dd>
        </div>
      </dl>

      {reason && (
        <div
          data-notice="reason"
          className="flex items-center gap-3 rounded-card bg-card px-3.5 py-3"
        >
          <Icon d={ICONS.info} size={16} strokeWidth={1.35} />
          <span className="flex-1 text-pretty">{reason.text}</span>
          {fix && (
            <Button prominent onClick={fix.run}>
              {fix.label}
            </Button>
          )}
        </div>
      )}

      {entry.written.length > 0 &&
        (marks ? (
          <>
            <div className="grid grid-cols-2 gap-3.5">
              <Text title="Heard" marks={marks.heard} />
              <Text title="Written" marks={marks.written} />
            </div>
            <div
              className="-mt-1.5 flex items-center gap-[18px] text-caption text-ink-2"
              aria-hidden="true"
            >
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span className="rounded-[3px] bg-mark-removed px-[3px] line-through">uh</span>
                removed
              </span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span className="text-ink underline decoration-[1.5px] underline-offset-[3px]">
                  Thursday,
                </span>
                capital or punctuation added
              </span>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => copy('heard')}>
                {done === 'heard' ? 'Raw Text Copied' : 'Use the Raw Text'}
              </Button>
            </div>
          </>
        ) : (
          <Text title="Written" marks={[{ word: entry.written, kind: 'plain', spoken: null }]} />
        ))}

      {timings.length > 0 && (
        <section className="flex flex-col" aria-label="Timings">
          <h2 className="pb-1.5 text-heading">Timings</h2>
          {timings.map((row) => (
            <div key={row.label} className="flex justify-between border-t border-line py-[7px]">
              <span className={row.total ? 'font-semibold' : 'text-ink-2'}>{row.label}</span>
              <span className={`tabular-nums ${row.total ? 'font-semibold' : ''}`}>
                {row.value}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

/**
 * A text with its marks. A removed word is struck through on a light fill; a changed
 * one is underlined. A screen reader reports neither, so each mark carries its words.
 */
function Text({ title, marks }: { title: string; marks: Mark[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-card p-3.5 shadow-outline">
      <span className="text-caption text-ink-2">{title}</span>
      <p className="text-[14px] leading-[1.7] whitespace-pre-wrap" data-said>
        {marks.map((mark, index) => (
          <span key={index}>
            {mark.kind === 'plain' ? (
              mark.word
            ) : (
              <>
                <span
                  aria-hidden="true"
                  className={
                    mark.kind === 'removed'
                      ? 'rounded-[3px] bg-mark-removed px-[3px] text-ink-2 line-through'
                      : 'underline decoration-[1.5px] underline-offset-[3px]'
                  }
                >
                  {mark.word}
                </span>
                <span className="only-spoken">{mark.spoken}</span>
              </>
            )}{' '}
          </span>
        ))}
      </p>
    </div>
  )
}
