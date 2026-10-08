import { dialog, type BrowserWindow } from 'electron'

/** Something that will not be done unless the person at the Mac says yes to it. */
export interface Question {
  /** What is being asked, for the log and for tests: `keepHistory`, `deleteLog`… */
  kind: string
  message: string
  detail: string
  /** The words on the button that says yes. The other one is always Cancel. */
  confirm: string
}

export type Ask = (question: Question) => Promise<boolean>

/**
 * Asks in a dialog of the system's own, drawn by the main process. A page of the app
 * cannot draw it, answer it or take it away, which is the point: keeping what was said
 * on disk, and deleting it, are never done on a page's word alone.
 *
 * Cancel is the button that Return presses.
 */
export function askInDialog(parent: () => BrowserWindow | null): Ask {
  return async (question) => {
    const options = {
      type: 'warning' as const,
      message: question.message,
      detail: question.detail,
      buttons: [question.confirm, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    }
    const window = parent()
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    console.log(`[app] asked: ${question.kind}; answered ${response === 0 ? 'yes' : 'no'}`)
    return response === 0
  }
}

/**
 * For the automated tests, which cannot press a button in a system dialog: the
 * question is answered by whatever the test has said the answer is, and every question
 * is written down. With no answer given it is refused.
 */
export function askForTests(): { ask: Ask; asked: Question[]; answer: { value: boolean | null } } {
  const asked: Question[] = []
  const answer: { value: boolean | null } = { value: null }
  return {
    asked,
    answer,
    ask: (question) => {
      asked.push(question)
      console.log(`[app] asked: ${question.kind}; a test answered ${answer.value ? 'yes' : 'no'}`)
      return Promise.resolve(answer.value === true)
    },
  }
}
