// Electron main process：管 pty，renderer 只負責 xterm.js 渲染。
// 這就是未來 SessionManager 的雛形 — 一個 IPC channel 對應一個 pty session。
const { app, BrowserWindow, ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const pty = require('@lydell/node-pty');

const sessions = new Map(); // id -> ptyProcess

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Wage-slave spike1 — claude in xterm.js',
    webPreferences: {
      // spike 圖方便直接開 nodeIntegration；正式版要改 preload + contextBridge
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('pty:spawn', (event, { id, cols, rows, cwd }) => {
  const isWin = os.platform() === 'win32';
  const shell = isWin ? 'cmd.exe' : 'bash';
  const args = isWin ? ['/c', 'claude'] : ['-c', 'claude'];

  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || os.homedir(),
    env: process.env,
    useConpty: true,
  });

  proc.onData((data) => event.sender.send(`pty:data:${id}`, data));
  proc.onExit(({ exitCode }) => event.sender.send(`pty:exit:${id}`, exitCode));
  sessions.set(id, proc);
  return { pid: proc.pid };
});

ipcMain.on('pty:write', (_e, { id, data }) => sessions.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => sessions.get(id)?.resize(cols, rows));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  for (const proc of sessions.values()) proc.kill();
  app.quit();
});
