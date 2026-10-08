import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppStatus, HubPage } from '@shared/ipc'
import { About } from './About'
import { InOrder } from './answers'
import { Cleanup } from './Cleanup'
import { ICONS, Icon, SavingBar } from './components'
import { FirstRun } from './FirstRun'
import { History } from './History'
import { HistoryDetail } from './HistoryDetail'
import { Home } from './Home'
import { STATUS_UNREAD } from './home-status'
import { Privacy } from './Privacy'
import { Settings } from './Settings'

const POLL_MS = 1_500

interface NavItem {
  page: HubPage
  label: string
  /** The icon's outline, on a 16 px grid. */
  d: string
}

/** The pages, in two groups: what is used every day, and what is set once. */
const NAV: NavItem[][] = [
  [
    {
      page: 'home',
      label: 'Home',
      d: 'M2.5 7.2 8 2.8l5.5 4.4v5.8a.5.5 0 0 1-.5.5H10V9.5H6v4H3a.5.5 0 0 1-.5-.5z',
    },
    {
      page: 'history',
      label: 'History',
      d: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 5v3l2 1.5',
    },
    { page: 'cleanup', label: 'Cleanup', d: 'M3 4.5h10M3 8h7M3 11.5h4' },
  ],
  [
    { page: 'settings', label: 'Settings', d: 'M2.5 5h11M2.5 11h11M6 3.2v3.6M10 9.2v3.6' },
    { page: 'privacy', label: 'Privacy', d: 'M3.5 7.5h9v6h-9zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2' },
    {
      page: 'about',
      label: 'About',
      d: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 7.3v3.7M8 5.2v.1',
    },
  ],
]
const PAGES = NAV.flat()

/**
 * The main window: a sidebar of pages and the page chosen. It opens on Home, which
 * says whether dictation is ready and, when it is not, the one thing that is needed.
 * Until the steps of the first launch have been gone through, it shows those instead.
 */
export function App() {
  const { status, failed, refresh } = useStatus()
  const [privacyRevision, setPrivacyRevision] = useState(0)
  useEffect(
    () =>
      window.flowHub.onPrivacyReset(() => {
        setPrivacyRevision((value) => value + 1)
        setOpened(null)
        refresh()
      }),
    [refresh],
  )
  const [page, setPage] = useState<HubPage>('home')
  /** The dictation that is open on the History page, by its id. */
  const [opened, setOpened] = useState<string | null>(null)

  const show = useCallback((next: HubPage): void => {
    setPage(next)
    setOpened(null)
  }, [])
  // The menu's "Settings…" and "About" ask for a page from outside the window.
  useEffect(() => window.flowHub.onNavigate(show), [show])

  if (status?.firstRun)
    return (
      <div className="flex h-full flex-col">
        {status.savingDictations && (
          <SavingBar
            besideWindowButtons
            onStop={() => void window.flowHub.stopSavingDictations().then(refresh, refresh)}
          />
        )}
        <FirstRun key={privacyRevision} status={status} onChanged={refresh} />
      </div>
    )

  const open = (id: string): void => {
    setPage('history')
    setOpened(id)
  }
  return (
    <div className="flex h-full bg-bg text-body text-ink">
      <Sidebar page={page} onPage={show} supportHost={status?.supportHost ?? null} />
      <main key={privacyRevision} className="relative flex min-w-0 flex-1 flex-col">
        {/* The window has no title bar: its top edge is what moves it. */}
        <div className="drags-window-over-page absolute inset-x-0 top-0 h-11" />
        {status?.savingDictations && (
          <SavingBar
            onStop={() => void window.flowHub.stopSavingDictations().then(refresh, refresh)}
          />
        )}
        {/* In words of its own: the error's text is not for the window, and could say anything. */}
        {failed && <p className="px-11 pt-[46px] text-problem">{STATUS_UNREAD}</p>}
        {status && page === 'home' && (
          <Home status={status} onChanged={refresh} onPage={show} onOpen={open} />
        )}
        {status && page === 'history' && (
          <>
            {/* The list stays as it was while one of its dictations is open: what was
                searched for, the row the keyboard was on, how far it was scrolled. */}
            <div className={opened ? 'hidden' : 'contents'}>
              <History status={status} shown={!opened} onChanged={refresh} onOpen={setOpened} />
            </div>
            {opened && (
              <HistoryDetail
                id={opened}
                status={status}
                onBack={() => setOpened(null)}
                onChanged={refresh}
                onPage={show}
              />
            )}
          </>
        )}
        {status && page === 'cleanup' && <Cleanup status={status} onChanged={refresh} />}
        {status && page === 'settings' && <Settings status={status} onChanged={refresh} />}
        {status && page === 'privacy' && <Privacy status={status} onChanged={refresh} />}
        {status && page === 'about' && <About status={status} />}
      </main>
    </div>
  )
}

/**
 * The list of pages. It is one stop for the keyboard: the arrow keys move through it,
 * and the page follows. The page in view is told by its fill and its weight, and by an
 * outline as well when the system asks for more contrast.
 */
function Sidebar(props: {
  page: HubPage
  onPage: (page: HubPage) => void
  supportHost: string | null
}) {
  const list = useRef<HTMLDivElement>(null)
  const move = (step: number): void => {
    const at = PAGES.findIndex((item) => item.page === props.page)
    const next = PAGES[(at + step + PAGES.length) % PAGES.length]
    if (!next) return
    props.onPage(next.page)
    list.current?.querySelector<HTMLElement>(`[data-page="${next.page}"]`)?.focus()
  }
  return (
    <nav
      aria-label="Pages"
      className="drags-window flex w-[212px] flex-none flex-col border-r border-line bg-sidebar px-2.5 pt-[52px] pb-4 compact:w-[180px] compact:px-2 compact:pb-3.5"
    >
      <div
        ref={list}
        className="flex flex-col"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') move(1)
          else if (event.key === 'ArrowUp') move(-1)
          else return
          event.preventDefault()
        }}
      >
        {NAV.map((group, index) => (
          <div
            key={index}
            className={`flex flex-col gap-0.5 compact:gap-px ${index > 0 ? 'mt-3.5 compact:mt-2' : ''}`}
          >
            {group.map((item) => {
              const current = item.page === props.page
              return (
                <button
                  key={item.page}
                  type="button"
                  data-page={item.page}
                  aria-current={current ? 'page' : undefined}
                  // One stop: the page in view. The arrows reach the others.
                  tabIndex={current ? 0 : -1}
                  onClick={() => props.onPage(item.page)}
                  className={`flex h-7 items-center gap-2 rounded-control px-2.5 text-left whitespace-nowrap compact:h-[26px] ${
                    current ? 'bg-fill-selected font-semibold shadow-selected' : ''
                  }`}
                >
                  <Icon d={item.d} className={current ? '' : 'text-ink-2'} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex-1" />
      {/* Shown only once there is a page to open: a link that leads nowhere is not shown. */}
      {props.supportHost && (
        <button
          type="button"
          title={`Opens ${props.supportHost} in your browser`}
          onClick={() => void window.flowHub.openLink('support')}
          className="flex items-center gap-[7px] rounded-control px-2.5 py-1 text-left text-caption whitespace-nowrap text-ink-2"
        >
          <Icon d={ICONS.cup} size={14} strokeWidth={1.3} />
          <span>Buy me a coffee</span>
        </button>
      )}
    </nav>
  )
}

function useStatus(): { status: AppStatus | null; failed: boolean; refresh: () => void } {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [failed, setFailed] = useState(false)
  /** Counts the askings: each change of it puts the question again. */
  const [asking, setAsking] = useState(0)
  const refresh = useCallback(() => setAsking((count) => count + 1), [])
  // An answer older than the one shown is dropped. One that is only slow is shown when it
  // comes: the status is asked for more often than a busy helper answers.
  const [answers] = useState(() => new InOrder())

  useEffect(() => {
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const isNews = answers.ask()
    window.flowHub.getStatus().then(
      (next) => {
        if (!isNews()) return
        setStatus(next)
        setFailed(false)
      },
      () => {
        if (isNews()) setFailed(true)
      },
    )
  }, [asking, answers])

  return { status, failed, refresh }
}
