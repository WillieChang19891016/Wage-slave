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
// 診斷資訊：分辨「pty 死了」還是「只是失去焦點」
let pid = '?';
let lastData = null;
let lastKey = null;
function refreshStatus() {
  const fmt = (d) => (d ? d.toLocaleTimeString('zh-TW', { hour12: false }) : '—');
  statusEl.textContent =
    `pid ${pid} | 最後輸出 ${fmt(lastData)} | 最後按鍵 ${fmt(lastKey)} | ` +
    `focus ${term.textarea === document.activeElement ? '✅' : '❌(點一下終端機)'}`;
}
setInterval(refreshStatus, 1000);

ipcRenderer.invoke('pty:spawn', { id: ID, cols: term.cols, rows: term.rows }).then((r) => {
  pid = r.pid;
  term.focus(); // xterm 沒焦點時打字沒反應，看起來像凍住
});

ipcRenderer.on(`pty:data:${ID}`, (_e, data) => {
  lastData = new Date();
  term.write(data);
});
ipcRenderer.on(`pty:exit:${ID}`, (_e, code) => {
  statusEl.textContent = `claude exited (code ${code})`;
  term.write(`\r\n\x1b[33m[process exited: ${code}]\x1b[0m\r\n`);
});

term.onData((data) => {
  lastKey = new Date();
  ipcRenderer.send('pty:write', { id: ID, data });
});

// 點終端機區域一律拉回焦點
document.getElementById('terminal').addEventListener('mousedown', () => term.focus());

// resize 防抖：連續 resize 事件打進 ConPTY 是已知的死鎖來源（node-pty win32）
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    fit.fit();
    ipcRenderer.send('pty:resize', { id: ID, cols: term.cols, rows: term.rows });
  }, 200);
});
