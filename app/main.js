// Wage-slave — Electron main process
// 職責：視窗、IPC 路由、把 JiraClient / WorktreeManager / SessionManager 接起來。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { JiraClient } = require('./src/jira-client');
const { WorktreeManager } = require('./src/worktree-manager');
const { SessionManager } = require('./src/session-manager');
const { Store } = require('./src/store');

const TASK_FILE = '.wage-slave-task.md';
const INITIAL_PROMPT =
  `請先完整閱讀本目錄的 ${TASK_FILE}（這張 Jira ticket 與關聯單的內容），理解需求後開始處理。` +
  `注意：${TASK_FILE} 是本機工作檔，已被 git exclude，不要 commit 它。`;

let win = null;
let settings, state, jira, sessions;

function initJira() {
  const s = settings.get();
  jira = new JiraClient({ domain: s.jiraDomain, email: s.jiraEmail, token: s.jiraToken });
}

function worktreeManager() {
  const repoRoot = settings.get().repoRoot;
  if (!repoRoot || !fs.existsSync(repoRoot)) throw new Error('請先在設定（⚙）填目標 repo 路徑');
  const wm = new WorktreeManager(repoRoot);
  wm.validate();
  return wm;
}

app.whenReady().then(() => {
  settings = new Store(path.join(app.getPath('userData'), 'settings.json'));
  state = new Store(path.join(app.getPath('userData'), 'state.json'), { sessions: {} });
  sessions = new SessionManager();
  initJira();

  sessions.on('data', (id, data) => win?.webContents.send('pty:data', { id, data }));
  sessions.on('exit', (id, code) => win?.webContents.send('pty:exit', { id, code }));

  win = new BrowserWindow({
    width: 1500,
    height: 900,
    title: 'Wage-slave',
    backgroundColor: '#0d1117',
    webPreferences: {
      // Phase 1 沿用 spike 的便宜行事；上架/分發前要改 preload + contextBridge
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});

app.on('window-all-closed', () => {
  sessions.killAll();
  app.quit();
});

// ---- settings ----
ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:save', (_e, patch) => {
  settings.set(patch);
  initJira();
  return settings.get();
});

// ---- jira ----
ipcMain.handle('jira:list', async () => {
  if (!jira.configured()) throw new Error('請先在設定（⚙）填 Jira domain / email / token');
  return jira.myOpenIssues();
});

// ---- sessions ----
ipcMain.handle('session:list', () => {
  const all = state.get().sessions;
  return Object.values(all).map((s) => ({
    ...s,
    running: sessions.isRunning(s.ticket),
    worktreeExists: fs.existsSync(s.worktreePath),
  }));
});

ipcMain.handle('session:start', async (_e, { ticket, cols, rows }) => {
  const wm = worktreeManager();
  const { brief, summary } = await jira.composeTaskBrief(ticket);
  const wt = wm.add(ticket);
  fs.writeFileSync(path.join(wt.path, TASK_FILE), brief);
  wm.ensureExclude(TASK_FILE);
  const pid = sessions.start(ticket, { cwd: wt.path, cols, rows, initialPrompt: INITIAL_PROMPT });

  const prev = state.get().sessions[ticket];
  const meta = {
    ticket,
    summary,
    branch: wt.branch,
    worktreePath: wt.path,
    createdAt: prev?.createdAt || new Date().toISOString(),
  };
  state.set({ sessions: { ...state.get().sessions, [ticket]: meta } });
  return { ...meta, pid, running: true };
});

ipcMain.handle('session:resume', (_e, { ticket, cols, rows }) => {
  const meta = state.get().sessions[ticket];
  if (!meta) throw new Error(`沒有 ${ticket} 的 session 紀錄`);
  if (!fs.existsSync(meta.worktreePath)) throw new Error('worktree 已不存在，請先清除這筆再重新開始');
  const pid = sessions.resume(ticket, { cwd: meta.worktreePath, cols, rows });
  return { ...meta, pid, running: true };
});

ipcMain.on('session:write', (_e, { id, data }) => sessions.write(id, data));
ipcMain.on('session:resize', (_e, { id, cols, rows }) => sessions.resize(id, cols, rows));

ipcMain.handle('session:kill', (_e, { ticket }) => sessions.kill(ticket));

// 清除：kill process + 移除 worktree/分支 + 刪紀錄（worktree 內未 push 的工作會消失）
ipcMain.handle('session:cleanup', (_e, { ticket }) => {
  sessions.kill(ticket);
  const meta = state.get().sessions[ticket];
  if (meta) {
    try {
      worktreeManager().remove(ticket);
    } catch {
      /* worktree 可能已被手動移除 */
    }
    const all = { ...state.get().sessions };
    delete all[ticket];
    state.set({ sessions: all });
  }
});
