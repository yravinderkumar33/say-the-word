import { Menu, app, type MenuItemConstructorOptions } from 'electron'

/**
 * The app's own menu, in place of Electron's default one (which offers Reload and the
 * developer tools). It is what makes Copy, Paste and Undo work in the window's text
 * fields, and gives the window the shortcuts a Mac window has. With no Dock icon the
 * menu bar does not show it, but its shortcuts work all the same.
 */
export function installAppMenu(actions: { openSettings(): void; openAbout(): void }): void {
  const development: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.getName(),
        submenu: [
          { label: `About ${app.getName()}`, click: () => actions.openAbout() },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Command+,', click: () => actions.openSettings() },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      // ⌘W closes the window, as on any Mac. Electron's Window menu has no Close on macOS:
      // it belongs to the File menu there.
      { label: 'File', submenu: [{ role: 'close' }] },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          // The window's text one size larger, or smaller: the layout allows for it.
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'resetZoom' },
          ...development,
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}
