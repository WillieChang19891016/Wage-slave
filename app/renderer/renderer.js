const { ipcRenderer, shell } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

// id(= ticket key) -> { term, fit, pane, dot, running }
const views = new Map();
let activeId = null;
let persisted = []; // session:list 的結果

const $ = (sel) => document.querySelector(sel);
const ticketListEl = $('#ticket-list');
const sessionListEl = $('#session-list');
const termsEl = $('#terms');
const emptyHintEl = $('#empty-hint');
const errorBarEl = $('#error-bar');

function showError(msg) {
  // ipc invoke 的錯誤會包一層 "Error invoking remote method ...:"，剝掉
  errorBarEl.textContent = String(msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  errorBarEl.classList.remove('hidden');
  clearTimeout(showError._t);
  showError._t = setTimeout(() => errorBarEl.classList.add('hidden'), 8000);
}

// ---------- settings ----------
function repoListFrom(s) {
  const roots = Array.isArray(s.repoRoots) && s.repoRoots.length ? s.repoRoots : [];
  if (s.repoRoot && !roots.includes(s.repoRoot)) roots.unshift(s.repoRoot); // 舊版單一設定相容
  return roots;
}

function renderRepoSelect(s) {
  const sel = $('#repo-select');
  sel.innerHTML = '';
  for (const root of repoListFrom(s)) {
    const opt = document.createElement('option');
    opt.value = root;
    opt.textContent = root.split(/[\\/]/).filter(Boolean).pop() + '  —  ' + root;
    if (root === s.repoRoot) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!sel.options.length) {
    const opt = document.createElement('option');
    opt.textContent = '（請先在 ⚙ 填 repo 清單）';
    opt.disabled = true;
    sel.appendChild(opt);
  }
}

async function loadSettings() {
  const s = await ipcRenderer.invoke('settings:get');
  $('#set-domain').value = s.jiraDomain || '';
  $('#set-email').value = s.jiraEmail || '';
  $('#set-token').value = s.jiraToken || '';
  $('#set-gitlab-token').value = s.gitlabToken || '';
  $('#set-repos').value = repoListFrom(s).join('\n');
  renderRepoSelect(s);
  return s;
}

$('#btn-settings').addEventListener('click', () => $('#settings-panel').classList.toggle('hidden'));
$('#btn-save').addEventListener('click', async () => {
  const repoRoots = $('#set-repos').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cur = $('#repo-select').value;
  const s = await ipcRenderer.invoke('settings:save', {
    jiraDomain: $('#set-domain').value.trim(),
    jiraEmail: $('#set-email').value.trim(),
    jiraToken: $('#set-token').value.trim(),
    gitlabToken: $('#set-gitlab-token').value.trim(),
    repoRoots,
    repoRoot: repoRoots.includes(cur) ? cur : repoRoots[0] || '',
  });
  renderRepoSelect(s);
  $('#settings-panel').classList.add('hidden');
  refreshTickets();
});

$('#repo-select').addEventListener('change', async (e) => {
  await ipcRenderer.invoke('settings:save', { repoRoot: e.target.value });
});
$('#btn-refresh').addEventListener('click', () => {
  refreshTickets();
  refreshSessions();
});

// ---------- Jira ticket 清單 ----------
async function refreshTickets() {
  ticketListEl.innerHTML = '<li class="muted">載入中…</li>';
  try {
    const issues = await ipcRenderer.invoke('jira:list');
    ticketListEl.innerHTML = '';
    if (!issues.length) {
      ticketListEl.innerHTML = '<li class="muted">（沒有未完成的 ticket）</li>';
      return;
    }
    for (const i of issues) {
      const li = document.createElement('li');
      li.className = 'ticket-item';
      const started = persisted.some((s) => s.ticket === i.key);
      li.innerHTML =
        `<span class="key">${i.key}</span><span class="chip">${i.fields.status?.name || '?'}</span>` +
        (started ? '<span class="chip started">已開工</span>' : '') +
        `<span class="sum">${escapeHtml(i.fields.summary || '')}</span>`;
      li.addEventListener('click', () => openSession(i.key));
      ticketListEl.appendChild(li);
    }
  } catch (e) {
    ticketListEl.innerHTML = '<li class="muted">（載入失敗）</li>';
    showError(e.message);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 工作區 session 清單 ----------
async function refreshSessions() {
  persisted = await ipcRenderer.invoke('session:list');
  sessionListEl.innerHTML = '';
  if (!persisted.length) {
    sessionListEl.innerHTML = '<li class="muted">（無）</li>';
    return;
  }
  for (const s of persisted) {
    const li = document.createElement('li');
    li.className = 'sess-item';
    const running = views.get(s.ticket)?.running || s.running;
    li.innerHTML =
      `<div class="row1"><span class="dot ${running ? 'run' : 'dead'}"></span>` +
      `<span class="key">${s.ticket}</span></div>` +
      `<span class="branch">${s.branch}${s.worktreeExists ? '' : '（worktree 遺失）'}</span>`;
    const btnOpen = document.createElement('button');
    btnOpen.textContent = running ? '切換' : '接回';
    btnOpen.addEventListener('click', () => openSession(s.ticket));
    let btnMrLink = null;
    if (s.mrUrl) {
      btnMrLink = document.createElement('button');
      btnMrLink.textContent = 'MR ↗';
      btnMrLink.className = 'mrlink';
      btnMrLink.title = s.mrUrl;
      btnMrLink.addEventListener('click', () => shell.openExternal(s.mrUrl));
    }
    const btnClean = document.createElement('button');
    btnClean.textContent = '清除';
    btnClean.className = 'danger';
    btnClean.addEventListener('click', async () => {
      if (!confirm(`清除 ${s.ticket}?\n會 kill session、移除 worktree 和分支，未 push 的變更會消失。`)) return;
      await ipcRenderer.invoke('session:cleanup', { ticket: s.ticket });
      removeView(s.ticket);
      await refreshSessions();
      refreshTickets();
    });
    li.appendChild(btnOpen);
    if (btnMrLink) li.appendChild(btnMrLink);
    li.appendChild(btnClean);
    sessionListEl.appendChild(li);
  }
}

// ---------- terminal grid：一格一張 Jira task，全部同時可見 ----------
// 格數 → 欄數：1 全螢幕、2 對半、3-4 兩欄、5+ 三欄
function relayout() {
  const n = views.size;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  termsEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  emptyHintEl.style.display = n ? 'none' : 'flex';
  // 等 grid 排完再 fit，每格的 cols/rows 變了會經 term.onResize 通知 pty
  requestAnimationFrame(() => {
    for (const v of views.values()) v.fit.fit();
  });
}

function createView(id, summary = '') {
  const pane = document.createElement('div');
  pane.className = 'pane';

  const head = document.createElement('div');
  head.className = 'pane-head';
  const dot = document.createElement('span');
  dot.className = 'dot dead';
  const key = document.createElement('span');
  key.className = 'key';
  key.textContent = id;
  const sum = document.createElement('span');
  sum.className = 'sum';
  sum.textContent = summary;
  const chg = document.createElement('span');
  chg.className = 'chg';
  chg.title = '⇡ 領先 base 的 commit 數 / ± 未 commit 的檔案數';
  const btnMr = document.createElement('button');
  btnMr.className = 'mr';
  btnMr.textContent = 'MR';
  btnMr.title = 'push 分支 + 開 GitLab Draft MR + 回填 Jira comment';
  btnMr.addEventListener('click', (e) => {
    e.stopPropagation();
    publish(id, btnMr);
  });
  const close = document.createElement('span');
  close.className = 'close';
  close.textContent = '×';
  close.title = '關閉這格（結束 process，保留 worktree，之後可接回）';
  close.addEventListener('click', async (e) => {
    e.stopPropagation();
    await ipcRenderer.invoke('session:kill', { ticket: id });
    removeView(id);
    refreshSessions();
  });
  head.append(dot, key, sum, chg, btnMr, close);

  const body = document.createElement('div');
  body.className = 'pane-body';
  pane.append(head, body);
  termsEl.appendChild(pane);

  const term = new Terminal({
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 13,
    theme: { background: '#0d1117' },
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(body);
  term.onData((data) => ipcRenderer.send('session:write', { id, data }));
  term.onResize(({ cols, rows }) => ipcRenderer.send('session:resize', { id, cols, rows }));
  pane.addEventListener('mousedown', () => activate(id));

  const view = { term, fit, pane, dot, sumEl: sum, chgEl: chg, running: false, lastChanges: null };
  views.set(id, view);
  relayout();
  return view;
}

function removeView(id) {
  const v = views.get(id);
  if (!v) return;
  v.term.dispose();
  v.pane.remove();
  views.delete(id);
  if (activeId === id) {
    activeId = null;
    const next = views.keys().next().value;
    if (next) activate(next);
  }
  relayout();
}

function activate(id) {
  for (const [vid, v] of views) v.pane.classList.toggle('active', vid === id);
  activeId = id;
  views.get(id)?.term.focus();
}

function setRunning(id, running) {
  const v = views.get(id);
  if (!v) return;
  v.running = running;
  v.dot.className = `dot ${running ? 'run' : 'dead'}`;
}

// hook 回報的即時狀態：working(🟢) / waiting(🟡) / attention(🔴)
const STATUS_CLASS = { working: 'run', waiting: 'wait', attention: 'attn' };
ipcRenderer.on('session:status', (_e, { id, status }) => {
  const v = views.get(id);
  if (!v || !v.running) return;
  v.dot.className = `dot ${STATUS_CLASS[status] || 'run'}`;
  if (status === 'waiting') refreshChanges(id); // 回完話的瞬間變更數最可能剛變，馬上刷
});

// ---------- pane header 的 git 變更摘要 ----------
async function refreshChanges(id) {
  const v = views.get(id);
  if (!v) return;
  const c = await ipcRenderer.invoke('session:changes', { ticket: id });
  const v2 = views.get(id); // invoke 期間 pane 可能已被關掉
  if (!v2) return;
  v2.lastChanges = c;
  if (!c) {
    v2.chgEl.textContent = '';
    return;
  }
  const parts = [];
  if (c.ahead) parts.push(`⇡${c.ahead}`);
  if (c.dirty) parts.push(`±${c.dirty}`);
  v2.chgEl.textContent = parts.length ? parts.join(' ') : '無變更';
  v2.chgEl.classList.toggle('none', !parts.length);
}
setInterval(() => {
  for (const id of views.keys()) refreshChanges(id);
}, 5000);

// ---------- 一鍵 push + Draft MR + 回填 Jira ----------
async function publish(id, btn) {
  const dirty = views.get(id)?.lastChanges?.dirty || 0;
  if (dirty && !confirm(`${id} 還有 ${dirty} 個檔案未 commit（不會進 MR）。\n仍要 push 已 commit 的部分並開 Draft MR?`)) return;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await ipcRenderer.invoke('session:publish', { ticket: id });
    refreshChanges(id);
    refreshSessions(); // 側欄長出 MR ↗ 鈕
    if (confirm(`${r.note}\n${r.mrUrl}\n\n在瀏覽器打開 MR?`)) shell.openExternal(r.mrUrl);
  } catch (e) {
    showError(e.message);
  }
  btn.disabled = false;
  btn.textContent = 'MR';
}

// ---------- 開/接回 session ----------
async function openSession(ticket) {
  const existing = views.get(ticket);
  if (existing?.running) {
    activate(ticket); // 已在跑 → 純切換
    return;
  }
  const v = existing || createView(ticket);
  activate(ticket);

  // 有 worktree 紀錄 → 接回舊對話；沒有 → 全新任務
  const hasRecord = persisted.some((s) => s.ticket === ticket && s.worktreeExists);
  const channel = hasRecord ? 'session:resume' : 'session:start';
  v.term.write(hasRecord ? '\x1b[36m[接回 session…]\x1b[0m\r\n' : '\x1b[36m[抓 Jira 內容、建 worktree、啟動 claude…]\x1b[0m\r\n');

  try {
    const meta = await ipcRenderer.invoke(channel, { ticket, cols: v.term.cols, rows: v.term.rows });
    setRunning(ticket, true);
    if (meta.summary) v.sumEl.textContent = meta.summary;
    if (meta.note) v.term.write(`\x1b[36m[${meta.note}]\x1b[0m\r\n`);
    v.term.focus();
    refreshChanges(ticket);
  } catch (e) {
    showError(e.message);
    v.term.write(`\x1b[31m${e.message}\x1b[0m\r\n`);
  }
  await refreshSessions();
  if (!hasRecord) refreshTickets(); // 新開工的單 → 更新「已開工」徽章
}

// ---------- pty 事件 ----------
ipcRenderer.on('pty:data', (_e, { id, data }) => views.get(id)?.term.write(data));
ipcRenderer.on('pty:exit', (_e, { id, code }) => {
  const v = views.get(id);
  if (v) v.term.write(`\r\n\x1b[33m[claude exited: ${code}]  按「接回」可恢復對話\x1b[0m\r\n`);
  setRunning(id, false);
  refreshSessions();
});

// resize 防抖（ConPTY 死鎖防護，spike1 的教訓）— grid 模式下全部格子都要 fit
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const v of views.values()) v.fit.fit();
  }, 200);
});

// ---------- init ----------
(async () => {
  const s = await loadSettings();
  await refreshSessions(); // 先載工作區，ticket 清單的「已開工」徽章才判斷得到
  if (!s.jiraDomain || !s.jiraToken || !s.repoRoot) {
    $('#settings-panel').classList.remove('hidden');
    ticketListEl.innerHTML = '<li class="muted">（請先完成設定）</li>';
  } else {
    refreshTickets();
  }
})();
