/**
 * main.js — the Electron shell.
 *
 * Wiring only, exactly like `tauri/src/main.rs`. All metadata work goes to the
 * `revery-exif-core` sidecar, which is the same Rust code the Tauri build links
 * directly, so both shells share one verified write path.
 *
 * What stays here is what is genuinely shell-specific: the window, the file
 * dialogs, and the navigation policy.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const { createCoreClient } = require('./core_client');

let core = null;
let mainWindow = null;
/**
 * Photos holding unwritten changes, as last reported by the renderer.
 *
 * Kept here rather than asked for at close time: the answer has to be
 * available synchronously, and `close` cannot wait on a round trip to the
 * renderer without letting the window go in the meantime.
 */
let dirtyCount = 0;

/** Locates the sidecar in a packaged app and in a dev checkout. */
function findCore() {
  const name = process.platform === 'win32' ? 'revery-exif-core.exe' : 'revery-exif-core';
  const candidates = [
    // Packaged: shipped as an unpacked resource so it stays executable.
    path.join(process.resourcesPath || '', 'core', name),
    // Development.
    path.join(__dirname, '..', 'tauri', 'target', 'release', name),
    path.join(__dirname, '..', 'tauri', 'target', 'debug', name),
  ];
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: 'Revery Exif',
    backgroundColor: '#16181c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The renderer gets no Node and no direct access to this process; the
      // only surface is what preload.js puts on the contextBridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // Renderer problems are otherwise invisible from a terminal: a preload that
  // fails to load, or a script that throws, leaves the app looking merely
  // inert. Surfacing both is the difference between a five-minute diagnosis
  // and an hour of guessing.
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[preload] failed: ${preloadPath}\n${error}`);
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${source}:${line} ${message}`);
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'www', 'index.html'));

  // The app must never act as a browser. A stray link in a caption or a
  // metadata value must not be able to navigate the window away from the app,
  // which on a borderless window can leave someone with no way back.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void url;
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  void shell;

  // Drafts live only in the renderer's memory: nothing is staged on disk until
  // Apply runs. Closing the window used to discard them silently, while the
  // grid was still badging the photos holding them.
  //
  // `close`, not `beforeunload`: Electron will run a page's `beforeunload`, but
  // answering it means blocking in the renderer, and the dialog we want is the
  // native one. This fires first and can simply refuse.
  mainWindow.on('close', (event) => {
    if (!dirtyCount) return;
    event.preventDefault();
    const photos = dirtyCount === 1 ? '1 photo' : `${dirtyCount} photos`;
    dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Discard changes'],
        defaultId: 0,
        cancelId: 0,
        title: 'Unsaved changes',
        message: `${photos} have changes that have not been written.`,
        detail: 'Closing now discards them. Nothing has been written to your files yet.',
      })
      .then(({ response }) => {
        if (response !== 1) return;
        // Clear first: destroy() would otherwise re-enter this handler.
        dirtyCount = 0;
        mainWindow.destroy();
      });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ── IPC ────────────────────────────────────────────────────────────────────
   Each channel mirrors a Tauri command of the same name. Everything except the
   dialogs is a straight pass-through to the core.                          */

const CORE_COMMANDS = [
  'engine_version',
  'writable_tags',
  'open_library',
  'rescan_library',
  'read_metadata',
  'read_fields',
  'read_preview',
  'read_file_bytes',
  'read_thumb_cache',
  'write_thumb_cache',
  'apply_edit',
  'apply_edits',
  'preview_geotag',
  'apply_geotag',
  'preview_date_shift',
  'undo_last',
  'undo_available',
];

function registerIpc() {
  for (const command of CORE_COMMANDS) {
    ipcMain.handle(command, async (_event, args) => {
      if (!core) throw new Error('The metadata engine is not running.');
      return core.call(command, args || {});
    });
  }

  // Not a core command: the sidecar has no opinion about unsaved drafts, which
  // never leave the renderer until Apply runs. This only feeds the close guard.
  ipcMain.handle('set_dirty', async (_event, args) => {
    dirtyCount = (args && args.dirty && Number(args.count)) || 0;
  });

  ipcMain.handle('choose_folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Open a folder of photos',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('choose_gpx_file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'GPS track', extensions: ['gpx', 'GPX'] }],
      title: 'Choose a GPS track',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Not a core command, and the one place in this app that writes to a path
  // outside the open folder. The renderer hands over the text and nothing
  // else: the destination comes from a native save dialog here, so there is no
  // renderer-supplied path to validate and no way to reach one. The Tauri side
  // does exactly the same thing in `export_csv`, for the same reason.
  ipcMain.handle('export_csv', async (_event, args) => {
    const csv = args && args.csv;
    if (typeof csv !== 'string') throw new Error('There was nothing to export.');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export metadata as CSV',
      defaultPath: (args && args.suggestedName) || 'metadata.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return null;
    // utf8, and the caller has already put a BOM at the front of the string —
    // without one Excel on Windows reads the file in the system code page and
    // every accented caption in it comes out as mojibake.
    await fs.promises.writeFile(result.filePath, csv, 'utf8');
    return result.filePath;
  });

  ipcMain.handle('initial_folder', async () => {
    // A folder on the command line, for "Open with" from a file manager.
    const candidate = process.argv
      .slice(app.isPackaged ? 1 : 2)
      .find((arg) => !arg.startsWith('-'));
    try {
      return candidate && fs.statSync(candidate).isDirectory() ? candidate : null;
    } catch (_) {
      return null;
    }
  });

  ipcMain.handle('report_renderer', async (_event, detail) => {
    console.log(`[map] ${detail}`);
  });
}

/* ── Lifecycle ─────────────────────────────────────────────────────────────*/

// One window only: two instances editing the same folder would each hold their
// own undo store, and the second would silently discard the first's.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const executable = findCore();
    if (!executable) {
      dialog.showErrorBox(
        'Revery Exif cannot start',
        'The metadata engine (revery-exif-core) is missing.\n\n' +
          'In a development checkout, build it with:\n' +
          '  cargo build --manifest-path tauri/Cargo.toml --release'
      );
      app.quit();
      return;
    }
    core = createCoreClient(executable);
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (core) core.dispose();
  });
}
