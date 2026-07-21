const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const ID = 'session-1';
const statusEl = document.getElementById('status');

const term = new Terminal({
  fontFamily: 'Consolas, "Courier New", monospace',
  fontSize: 14,
  theme: { background: '#1e1e1e' },
  allowProposedApi: true,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();

// 驗證重點清單（通過標準）：
//  1. claude TUI 正常畫出來、方向鍵 / Enter / Ctrl+C 可用
//  2. 中文輸入與顯示正常
//  3. 視窗 resize 後 TUI 重繪不破版
//  4. permission prompt (y/n) 可互動
ipcRenderer
  .invoke('pty:spawn', { id: ID, cols: term.cols, rows: term.rows })
  .then(({ pid }) => (statusEl.textContent = `claude running (pid ${pid}) — 測試：中文輸入、resize、Ctrl+C`));

ipcRenderer.on(`pty:data:${ID}`, (_e, data) => term.write(data));
ipcRenderer.on(`pty:exit:${ID}`, (_e, code) => {
  statusEl.textContent = `claude exited (code ${code})`;
  term.write(`\r\n\x1b[33m[process exited: ${code}]\x1b[0m\r\n`);
});

term.onData((data) => ipcRenderer.send('pty:write', { id: ID, data }));

window.addEventListener('resize', () => {
  fit.fit();
  ipcRenderer.send('pty:resize', { id: ID, cols: term.cols, rows: term.rows });
});
