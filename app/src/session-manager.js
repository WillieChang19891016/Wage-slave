// SessionManager — 從 spike1 抽出。一個 session = 一個 pty 跑 claude。
// 直接 spawn claude.exe（不經 cmd /c），避免引號/換行的 quoting 地雷。
const os = require('os');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const pty = require('@lydell/node-pty');

function resolveClaude() {
  try {
    const out = execFileSync(os.platform() === 'win32' ? 'where.exe' : 'which', ['claude'], {
      encoding: 'utf8',
    });
    return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

// 清掉繼承到的 CLAUDE* 環境變數：如果 app 是從某個 Claude Code session 裡啟動的，
// 子 claude 會以為自己是巢狀 session，對話不會正常存檔（--continue 會找不到東西）
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^CLAUDE/i.test(key)) delete env[key];
  }
  return env;
}

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.procs = new Map(); // id -> pty
    this.claudePath = resolveClaude();
  }

  spawn(id, { cwd, cols, rows, args = [] }) {
    if (this.procs.has(id)) throw new Error(`session ${id} 已在執行中`);
    if (!this.claudePath) throw new Error('找不到 claude CLI（不在 PATH）');
    const proc = pty.spawn(this.claudePath, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: cleanEnv(),
      useConpty: true,
    });
    proc.onData((data) => this.emit('data', id, data));
    proc.onExit(({ exitCode }) => {
      this.procs.delete(id);
      this.emit('exit', id, exitCode);
    });
    this.procs.set(id, proc);
    return proc.pid;
  }

  // 新任務：claude "<初始 prompt>" 直接帶進互動 session
  start(id, { cwd, cols, rows, initialPrompt, settingsFile }) {
    const args = initialPrompt ? [initialPrompt] : [];
    if (settingsFile) args.push('--settings', settingsFile);
    return this.spawn(id, { cwd, cols, rows, args });
  }

  // 接回：claude --continue 恢復該目錄最近一次對話
  resume(id, { cwd, cols, rows, settingsFile }) {
    const args = ['--continue'];
    if (settingsFile) args.push('--settings', settingsFile);
    return this.spawn(id, { cwd, cols, rows, args });
  }

  write(id, data) {
    this.procs.get(id)?.write(data);
  }

  resize(id, cols, rows) {
    this.procs.get(id)?.resize(cols, rows);
  }

  kill(id) {
    this.procs.get(id)?.kill();
  }

  isRunning(id) {
    return this.procs.has(id);
  }

  killAll() {
    for (const proc of this.procs.values()) {
      try {
        proc.kill();
      } catch {
        /* ConPTY 偶爾在關閉時丟例外，不影響結果 */
      }
    }
    this.procs.clear();
  }
}

module.exports = { SessionManager };
