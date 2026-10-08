import type { ReactNode } from 'react'
import type { AppStatus, PrivacyFacts, StoredKind } from '@shared/ipc'
import { Button, ICONS, Icon, Notice, PageTitle } from './components'
import {
  FACTS_UNREAD,
  contactedLines,
  everythingNote,
  problemWords,
  storedRows,
} from './privacy-view'
import { useFacts } from './use-facts'

const LOOK_EVERY_MS = 2_500

/**
 * Privacy: what the app promises, each promise beside a fact read from the app as it
 * runs; what is stored on this Mac and how much, with the way to see it and to delete
 * it. Nothing is deleted before a dialog of the system's has asked.
 */
export function Privacy({ status, onChanged }: { status: AppStatus; onChanged: () => void }) {
  const { facts, failed, refresh, set } = useFacts<PrivacyFacts>(
    () => window.flowHub.getPrivacyFacts(),
    LOOK_EVERY_MS,
    status.history.version,
  )
  const remove = (kind: StoredKind | 'everything'): void => {
    void window.flowHub.deleteStored(kind).then((after) => {
      set(after)
      onChanged()
    }, refresh)
  }
  if (!facts) {
    // Nothing read yet: blank for the moment it takes, and said once it has failed.
    if (!failed) return null
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-8 pt-10 pb-5 compact:px-6 compact:pt-6">
        <PageTitle>Privacy</PageTitle>
        <Notice
          name="privacy-unread"
          title={FACTS_UNREAD}
          actions={<Button onClick={refresh}>Try Again</Button>}
        />
      </div>
    )
  }
  const rows = storedRows(facts)
  const everything = everythingNote(rows)
  const problem = facts.problem

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-8 pt-10 pb-5 compact:px-6 compact:pt-6">
      <div className="flex flex-col gap-1.5">
        <PageTitle>Privacy</PageTitle>
        <p className="text-ink-2">Everything runs on this Mac. These facts are read live.</p>
      </div>

      <dl className="flex flex-col border-t border-line">
        <Fact name="Where speech is recognized">On this Mac, by {facts.recognizer}</Fact>
        <Fact name="Contacted over the network since launch">
          <span data-contacted className="flex flex-col">
            {contactedLines(facts.contacted).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        </Fact>
        <Fact name="Account, cloud, telemetry">None</Fact>
      </dl>

      {problem && (
        <Notice
          name="delete-problem"
          title={problemWords(problem).title}
          actions={
            <>
              <Button onClick={() => void window.flowHub.revealStored(problem.kind)}>
                Show in Finder
              </Button>
              <Button prominent onClick={() => remove(problem.kind)}>
                Try Again
              </Button>
            </>
          }
        >
          {problemWords(problem).body}
        </Notice>
      )}

      <section aria-label="Stored on this Mac" className="flex flex-col">
        <h2 className="pb-2 text-heading">Stored on this Mac</h2>
        <div className="flex flex-col border-t border-line">
          {rows.map((row) => (
            <div
              key={row.kind}
              data-stored={row.kind}
              className="grid min-h-[52px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2.5 border-b border-line"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-[7px]">
                  <span>{row.label}</span>
                  {row.saving && (
                    <span className="inline-flex h-5 items-center gap-[5px] rounded-[5px] bg-saving-bg px-[7px] text-[11.5px] font-semibold text-saving shadow-[inset_0_0_0_1px_var(--saving-line)]">
                      <Icon d={ICONS.save} size={11} strokeWidth={1.7} />
                      Saving
                    </span>
                  )}
                </span>
                <span className="text-caption text-ink-2">{row.value}</span>
              </div>
              <Button
                label={`Show ${row.label} in Finder`}
                disabled={!row.canShow}
                onClick={() => void window.flowHub.revealStored(row.kind)}
              >
                Show in Finder
              </Button>
              <Button
                label={`Delete ${row.label}…`}
                disabled={!row.canDelete}
                onClick={() => remove(row.kind)}
              >
                Delete…
              </Button>
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button danger disabled={!everything.enabled} onClick={() => remove('everything')}>
          Delete Everything…
        </Button>
        <span className="text-caption text-ink-2">{everything.text}</span>
      </div>
    </div>
  )
}

/** One promise, and the fact that stands behind it. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid min-h-[46px] grid-cols-2 items-center gap-4 border-b border-line py-1.5">
      <dt>{name}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  )
}
