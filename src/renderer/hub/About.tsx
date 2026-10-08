import { useState } from 'react'
import type { AppStatus } from '@shared/ipc'
import { MAKER_NAME, PRODUCT_NAME } from '@shared/product'
import { THIRD_PARTY, thirdPartySummary } from '@shared/third-party'
import { AppIcon, ICONS, Icon } from './components'

/**
 * About: which build this is, where its source and its licences are, and a note from
 * whoever makes it. The speech model's terms ask that its makers be named, and this is
 * where they are.
 */
export function About({ status }: { status: AppStatus }) {
  const [licences, setLicences] = useState(false)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex max-w-[640px] flex-col gap-[26px] px-12 pt-14 pb-8 compact:px-6 compact:pt-8">
        <div className="flex items-center gap-[18px]">
          <AppIcon size={72} />
          <div className="flex flex-col gap-[3px]">
            <h1 className="text-title">{PRODUCT_NAME}</h1>
            <span className="whitespace-nowrap text-ink-2">
              Version {status.versions.app} · free and open source
            </span>
          </div>
        </div>

        {/* There is nothing to check against yet, and the app says so rather than pretend. */}
        <p className="text-caption text-ink-2">
          There is no update check in this build: it looks nowhere for a newer one.
        </p>

        <div className="flex flex-col border-t border-line">
          {status.links.source && (
            <LinkRow
              label="Source code"
              sub="Opens the repository in your browser"
              onClick={() => void window.flowHub.openLink('source')}
            />
          )}
          {status.links.issues && (
            <LinkRow
              label="Report a problem"
              sub="Opens a new issue in your browser. Copy Diagnostics first, if it helps."
              onClick={() => void window.flowHub.openLink('issues')}
            />
          )}
          <button
            type="button"
            aria-expanded={licences}
            onClick={() => setLicences((open) => !open)}
            className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line text-left"
          >
            <span className="flex flex-col gap-px">
              <span>Licences and attributions</span>
              <span className="text-caption text-ink-2">{thirdPartySummary()}</span>
            </span>
            <Icon
              d={ICONS.back}
              size={12}
              className={`text-ink-2 ${licences ? 'rotate-90' : '-rotate-90'}`}
            />
          </button>
          {licences && (
            <ul className="flex flex-col border-b border-line py-1.5" aria-label="Licences">
              {THIRD_PARTY.map((item) => (
                <li
                  key={item.name}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-[5px] text-caption"
                >
                  <span>
                    <span className="font-medium">{item.name}</span>
                    <span className="text-ink-2"> · {item.what}</span>
                  </span>
                  <span className="text-ink-2">{item.licence}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* A link that leads nowhere is not shown, and neither is the note that goes with it. */}
        {status.supportHost && (
          <div className="flex flex-col gap-3 rounded-card bg-card p-[18px]">
            <p className="leading-[1.55] text-pretty">
              I built {PRODUCT_NAME} because I wanted dictation that never leaves my Mac. It is free
              and will stay free. If it saves you time, you can buy me a coffee.
            </p>
            <p className="text-caption text-ink-2">
              {MAKER_NAME}, who makes {PRODUCT_NAME}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void window.flowHub.openLink('support')}
                className="inline-flex h-[26px] items-center gap-[7px] rounded-control bg-control px-3.5 font-medium whitespace-nowrap shadow-control"
              >
                <Icon d={ICONS.cup} size={14} />
                Buy me a coffee
              </button>
              <span className="text-caption text-ink-2">
                Opens {status.supportHost} in your browser
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** A link that opens in the browser, and says so. */
function LinkRow(props: { label: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line text-left"
    >
      <span className="flex flex-col gap-px">
        <span>{props.label}</span>
        <span className="text-caption text-ink-2">{props.sub}</span>
      </span>
      <Icon d={ICONS.out} size={12} className="text-ink-2" />
    </button>
  )
}
