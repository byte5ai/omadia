/**
 * Application menu (OM-41, field-test follow-up).
 *
 * Until now the app shipped with ELECTRON'S DEFAULT menu — nobody in this
 * codebase ever called `Menu.setApplicationMenu`. Two consequences the first
 * field test called out:
 *
 *  - "Toggle Full Screen" appeared TWICE in the View menu (the default
 *    template's `togglefullscreen` role next to macOS's own system item),
 *    with two different accelerators.
 *  - The developer tools were reachable in the shipped app via the default
 *    menu item and its accelerator, and the tester explicitly asked whether
 *    that was a deliberate decision. It was not — it was the absence of one.
 *
 * The decision, made explicit here: **DevTools are a development affordance.**
 * In a packaged build the menu carries no DevTools item and no accelerator;
 * support diagnostics go through the tray's "Open Logs" instead, which is what
 * support actually asks customers for. In a dev run (`app.isPackaged` false)
 * the item is present. We deliberately do NOT set `webPreferences.devTools:
 * false`: remote debugging for our own automated testing stays possible via
 * an explicit `--remote-debugging-port` launch, which a customer would never
 * do by accident — the goal is removing the accidental foot-gun from the
 * menu, not fighting intentional diagnostics.
 *
 * The other gap was updates: packaged builds had no manual "check now" surface
 * anywhere, so Windows and Linux users had no honest way to ask the updater for
 * a visible result. A top-level Help menu fixes that on every platform without
 * overloading the macOS app menu, which should stay reserved for OS-conventional
 * items such as About/Hide/Quit.
 *
 * Everything else mirrors the default template closely (edit roles, window
 * roles, zoom) so muscle memory and localized role labels keep working —
 * Electron localizes `role:` items with the OS language for free, which
 * matters for the German-market audience (OM-28).
 *
 * OM-59 follow-up: that free localization covers role ENTRIES only. The
 * top-level headings are plain labels, so a German user saw "File / Edit / View
 * / Window / Help" above correctly-translated submenus. They now go through the
 * shell dictionary like every other main-process string.
 *
 * OM-58 follow-up: the Help menu also carries "Show recovery key…". The wizard
 * step that offers the key could be skipped without the user noticing, and until
 * now there was no second way to ever see it.
 */
import { Menu, app, type MenuItemConstructorOptions } from 'electron';
import { createShellTranslate } from './shellStrings';

export interface MenuActions {
  checkForUpdates: () => void;
  showRecoveryKey: () => void;
}

export function installApplicationMenu(actions: MenuActions): void {
  const isMac = process.platform === 'darwin';
  const showDevTools = !app.isPackaged;
  const t = createShellTranslate(app.getLocale());

  const template: MenuItemConstructorOptions[] = [
    // App menu (macOS only — holds About/Hide/Quit by convention).
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t('menu.file', 'File'),
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: t('menu.edit', 'Edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? ([{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])
          : ([{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t('menu.view', 'View'),
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        // OM-41: exactly ONE fullscreen entry. On macOS the system may still
        // offer its own in the Window menu — but the View menu no longer
        // duplicates it with a second accelerator.
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(showDevTools
          ? ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: t('menu.window', 'Window'),
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t('menu.help', 'Help'),
      submenu: [
        {
          label: t('menu.checkForUpdates', 'Check for Updates…'),
          click: () => actions.checkForUpdates(),
        },
        { type: 'separator' },
        {
          label: t('recovery.menuItem', 'Show recovery key…'),
          click: () => actions.showRecoveryKey(),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
