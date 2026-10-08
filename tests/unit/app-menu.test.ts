import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

const menu = vi.hoisted(() => ({ template: [] as MenuItemConstructorOptions[] }))
vi.mock('electron', () => ({
  app: { getName: () => 'Whisper Flow', isPackaged: true },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => template,
    setApplicationMenu: (template: MenuItemConstructorOptions[]) => (menu.template = template),
  },
}))
import { installAppMenu } from '../../src/main/windows/app-menu'

/** Every item of the menu, those of its submenus included. */
const everyItem = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? everyItem(item.submenu) : [])])

describe("the app's menu", () => {
  it('closes the window with ⌘W, as on any Mac', () => {
    installAppMenu({ openSettings: () => {}, openAbout: () => {} })

    // Electron's own Window menu has no Close on macOS: it has to be one of the menu's items.
    const close = everyItem(menu.template).filter((item) => item.role === 'close')
    expect(close).toHaveLength(1)
    expect(close[0]?.accelerator).toBeUndefined()
  })
})
