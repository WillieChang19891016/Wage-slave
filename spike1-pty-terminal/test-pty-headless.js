// 無 UI 驗證：node-pty 在 Windows (ConPTY) 能不能 spawn claude 並拿到輸出。
// 先跑這個，通過了再跑 npm start 驗證 xterm.js 渲染。
const os = require('os');
const pty = require('@lydell/node-pty');

const isWin = os.platform() === 'win32';
const shell = isWin ? 'cmd.exe' : 'bash';
const args = isWin ? ['/c', 'claude --version'] : ['-c', 'claude --version'];

console.log('[spike1] spawning pty:', shell, args.join(' '));

const proc = pty.spawn(shell, args, {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: os.homedir(),
  env: process.env,
  useConpty: true,
});

let output = '';
proc.onData((data) => {
  output += data;
  process.stdout.write(data);
});

proc.onExit(({ exitCode }) => {
  const ok = exitCode === 0 && /\d+\.\d+/.test(output);
  console.log(`\n[spike1] exit code = ${exitCode}, got version output = ${ok}`);
  console.log(ok ? '[spike1] PASS ✅ node-pty + ConPTY + claude OK' : '[spike1] FAIL ❌');
  process.exit(ok ? 0 : 1);
});

setTimeout(() => {
  console.log('\n[spike1] FAIL ❌ timeout (30s)');
  proc.kill();
  process.exit(1);
}, 30000);
