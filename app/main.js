// Wage-slave — Electron main process
// 職責：視窗、IPC 路由、把 JiraClient / WorktreeManager / SessionManager 接起來。
const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { JiraClient } = require('./src/jira-client');
const { GitLabClient, parseRemote } = require('./src/gitlab-client');
const { WorktreeManager } = require('./src/worktree-manager');
const { SessionManager } = require('./src/session-manager');
const { HookServer } = require('./src/hook-server');
const { Store } = require('./src/store');

const TASK_FILE = '.wage-slave-task.md';
const INITIAL_PROMPT =
  `請先完整閱讀本目錄的 ${TASK_FILE}（這張 Jira ticket 與關聯單的內容），理解需求後開始處理。` +
  `注意：${TASK_FILE} 是本機工作檔，已被 git exclude，不要 commit 它。`;

let win = null;
let settings, state, jira, sessions, hookServer;

function initJira() {
  const s = settings.get();
  jira = new JiraClient({ domain: s.jiraDomain, email: s.jiraEmail, token: s.jiraToken });
}

function worktreeManager(repoRoot) {
  const root = repoRoot || settings.get().repoRoot;
  if (!root || !fs.existsSync(root)) throw new Error('請先在設定（⚙）填目標 repo 路徑');
  const wm = new WorktreeManager(root);
  wm.validate();
  return wm;
}

// 每個 session 一份 hooks 設定檔（claude --settings 用）
function hookSettingsFile(ticket) {
  const dir = path.join(app.getPath('userData'), 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ticket}.json`);
  fs.writeFileSync(file, JSON.stringify(hookServer.settingsFor(ticket), null, 2));
  return file;
}

const HOOK_STATUS = { prompt: 'working', stop: 'waiting', notification: 'attention' };
const STATUS_TEXT = { waiting: '等你輸入', attention: '需要授權/注意' };

app.whenReady().then(async () => {
  app.setAppUserModelId('com.wage-slave.app'); // Windows 桌面通知需要
  settings = new Store(path.join(app.getPath('userData'), 'settings.json'));
  state = new Store(path.join(app.getPath('userData'), 'state.json'), { sessions: {} });
  sessions = new SessionManager();
  hookServer = new HookServer();
  await hookServer.start();
  initJira();

  // claude hooks 回報 → 更新狀態燈；等輸入/要權限而視窗又不在前景 → 桌面通知
  hookServer.on('hook', (event, ticket) => {
    const status = HOOK_STATUS[event];
    if (!status) return;
    sendToWin('session:status', { id: ticket, status });
    if (STATUS_TEXT[status] && win && !win.isFocused()) {
      const summary = state.get().sessions[ticket]?.summary || '';
      const n = new Notification({ title: `${ticket} ${STATUS_TEXT[status]}`, body: summary });
      n.on('click', () => { win.show(); win.focus(); });
      n.show();
    }
  });

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
    icon: path.join(__dirname, 'assets', 'icon.ico'),
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

// 工作區 ticket 的 Jira 狀態（Done 徽章用）。逐張查而不是 JQL in()：
// 單被刪/無權限時 JQL 會整包 400，逐張查壞的只是缺那一張。
ipcMain.handle('jira:statuses', async (_e, { tickets }) => {
  if (!jira.configured()) return {};
  const out = {};
  await Promise.all(
    tickets.map(async (t) => {
      try {
        const i = await jira.issue(t, ['status']);
        out[t] = {
          name: i.fields.status?.name || '?',
          done: i.fields.status?.statusCategory?.key === 'done',
        };
      } catch {
        /* 查不到就不標 */
      }
    })
  );
  return out;
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
  const repoRoot = settings.get().repoRoot;
  const wm = worktreeManager(repoRoot);
  const { brief, summary } = await jira.composeTaskBrief(ticket);
  const wt = wm.add(ticket);
  fs.writeFileSync(path.join(wt.path, TASK_FILE), brief);
  wm.ensureExclude(TASK_FILE);
  const pid = sessions.start(ticket, {
    cwd: wt.path,
    cols,
    rows,
    initialPrompt: INITIAL_PROMPT,
    settingsFile: hookSettingsFile(ticket),
  });

  const prev = state.get().sessions[ticket];
  const meta = {
    ticket,
    summary,
    branch: wt.branch,
    worktreePath: wt.path,
    repoRoot,
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

  const settingsFile = hookSettingsFile(ticket);
  if (hasConversation(meta.worktreePath)) {
    const pid = sessions.resume(ticket, { cwd: meta.worktreePath, cols, rows, settingsFile });
    return { ...meta, pid, running: true, note: '接回上次對話' };
  }
  // 沒有可接的對話（例如舊版 env 汙染導致沒存檔）→ 重新開始，任務檔還在
  const taskFile = path.join(meta.worktreePath, TASK_FILE);
  if (!fs.existsSync(taskFile) && jira.configured()) {
    const { brief } = await jira.composeTaskBrief(ticket);
    fs.writeFileSync(taskFile, brief);
  }
  const pid = sessions.start(ticket, { cwd: meta.worktreePath, cols, rows, initialPrompt: INITIAL_PROMPT, settingsFile });
  return { ...meta, pid, running: true, note: '找不到舊對話，重新開始（worktree 內的變更都還在）' };
});

ipcMain.on('session:write', (_e, { id, data }) => sessions.write(id, data));
ipcMain.on('session:resize', (_e, { id, cols, rows }) => sessions.resize(id, cols, rows));

ipcMain.handle('session:kill', (_e, { ticket }) => sessions.kill(ticket));

// 非阻塞 git（push 可能好幾秒，WorktreeManager 的 sync 版會卡住 main process）
const gitAsync = (cwd, ...args) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim()));
      else resolve(stdout.trim());
    });
  });

// worktree 的 base 分支名（origin/HEAD → 'main'）；沒設 origin/HEAD 回 null
async function baseBranch(wt) {
  try {
    return (await gitAsync(wt, 'symbolic-ref', 'refs/remotes/origin/HEAD')).replace(/^refs\/remotes\/origin\//, '');
  } catch {
    return null;
  }
}

// pane header 的 git 變更摘要：ahead = 領先 base 的 commit 數，dirty = 未 commit 檔案數
ipcMain.handle('session:changes', async (_e, { ticket }) => {
  const meta = state.get().sessions[ticket];
  if (!meta || !fs.existsSync(meta.worktreePath)) return null;
  const wt = meta.worktreePath;
  try {
    const status = await gitAsync(wt, 'status', '--porcelain');
    const dirty = status ? status.split('\n').filter(Boolean).length : 0;
    let ahead = 0;
    const base = await baseBranch(wt);
    if (base) ahead = parseInt(await gitAsync(wt, 'rev-list', '--count', `origin/${base}..HEAD`), 10) || 0;
    let unpushed = null; // null = 遠端分支不存在（從沒 push 過）
    try {
      await gitAsync(wt, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${meta.branch}`);
      unpushed = parseInt(await gitAsync(wt, 'rev-list', '--count', `origin/${meta.branch}..HEAD`), 10) || 0;
    } catch {
      /* 沒 push 過 */
    }
    return { dirty, ahead, unpushed, mrUrl: meta.mrUrl || null };
  } catch {
    return null; // worktree 半殘（例如手動刪到一半）→ header 不顯示就好，別炸
  }
});

// 一鍵發布：push 分支 → 開 GitLab Draft MR（冪等）→ 回填 Jira comment
ipcMain.handle('session:publish', async (_e, { ticket }) => {
  const meta = state.get().sessions[ticket];
  if (!meta) throw new Error(`沒有 ${ticket} 的 session 紀錄`);
  const wt = meta.worktreePath;
  if (!fs.existsSync(wt)) throw new Error('worktree 已不存在');
  const s = settings.get();
  if (!s.gitlabToken) throw new Error('請先在設定（⚙）填 GitLab token（scope: api）');

  const remote = await gitAsync(wt, 'remote', 'get-url', 'origin');
  const { host, project } = parseRemote(remote);

  let target = await baseBranch(wt);
  if (target) {
    const ahead = parseInt(await gitAsync(wt, 'rev-list', '--count', `origin/${target}..HEAD`), 10) || 0;
    if (!ahead) throw new Error(`分支 ${meta.branch} 尚無新 commit，先讓 claude commit 再開 MR`);
  }

  await gitAsync(wt, 'push', '-u', 'origin', meta.branch);

  const gl = new GitLabClient({ host, token: s.gitlabToken });
  if (!target) target = (await gl.project(project)).default_branch;
  const mr = await gl.ensureDraftMr({
    project,
    sourceBranch: meta.branch,
    targetBranch: target,
    title: `Draft: ${ticket} ${meta.summary || ''}`.trim(),
    description: `Jira: https://${s.jiraDomain}/browse/${ticket}`,
  });

  let note = mr.existed ? '已 push（MR 先前已開過，沿用）' : '已 push + 開 Draft MR';
  if (!mr.existed && jira.configured()) {
    // Jira 回填失敗不擋流程：MR 已經開了，只是連結要自己貼
    try {
      await jira.addComment(ticket, 'Draft MR:', mr.web_url);
      note += '，已回填 Jira comment';
    } catch (err) {
      note += `（Jira 回填失敗：${String(err.message).slice(0, 120)}）`;
    }
  }
  state.set({ sessions: { ...state.get().sessions, [ticket]: { ...meta, mrUrl: mr.web_url } } });
  return { mrUrl: mr.web_url, note };
});

// 清除：kill process + 移除 worktree/分支 + 刪紀錄（worktree 內未 push 的工作會消失）
ipcMain.handle('session:cleanup', (_e, { ticket }) => {
  sessions.kill(ticket);
  const meta = state.get().sessions[ticket];
  if (meta) {
    try {
      worktreeManager(meta.repoRoot).remove(ticket); // 用建立當時的 repo，不受之後切換影響
    } catch {
      /* worktree 可能已被手動移除 */
    }
    const all = { ...state.get().sessions };
    delete all[ticket];
    state.set({ sessions: all });
  }
});
