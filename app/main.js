// Wage-slave — Electron main process
// 職責：視窗、IPC 路由、把 JiraClient / WorktreeManager / SessionManager 接起來。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

  // 視窗關閉瞬間 claude 可能還在吐輸出，往已銷毀的 webContents send 會炸 main process
  const sendToWin = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  sessions.on('data', (id, data) => sendToWin('pty:data', { id, data }));
  sessions.on('exit', (id, code) => sendToWin('pty:exit', { id, code }));

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
  // renderer 的 console/錯誤轉印到 stdout，headless 也能 debug UI 層
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', () => sessions.killAll()); // 先收掉所有 pty 再讓視窗關
  win.on('closed', () => { win = null; });
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

// claude 把對話存在 ~/.claude/projects/<cwd 編碼>/*.jsonl；沒有就不能 --continue
function hasConversation(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[\\/:.]/g, '-'));
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

ipcMain.handle('session:resume', async (_e, { ticket, cols, rows }) => {
  const meta = state.get().sessions[ticket];
  if (!meta) throw new Error(`沒有 ${ticket} 的 session 紀錄`);
  if (!fs.existsSync(meta.worktreePath)) throw new Error('worktree 已不存在，請先清除這筆再重新開始');

  if (hasConversation(meta.worktreePath)) {
    const pid = sessions.resume(ticket, { cwd: meta.worktreePath, cols, rows });
    return { ...meta, pid, running: true, note: '接回上次對話' };
  }
  // 沒有可接的對話（例如舊版 env 汙染導致沒存檔）→ 重新開始，任務檔還在
  const taskFile = path.join(meta.worktreePath, TASK_FILE);
  if (!fs.existsSync(taskFile) && jira.configured()) {
    const { brief } = await jira.composeTaskBrief(ticket);
    fs.writeFileSync(taskFile, brief);
  }
  const pid = sessions.start(ticket, { cwd: meta.worktreePath, cols, rows, initialPrompt: INITIAL_PROMPT });
  return { ...meta, pid, running: true, note: '找不到舊對話，重新開始（worktree 內的變更都還在）' };
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
