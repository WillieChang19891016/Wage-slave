// WorktreeManager — 從 spike2 抽出。worktree 放 .claude/worktrees/<ticket>，
// base 對齊 claude --worktree 的 fresh 行為（origin/HEAD，無遠端 fallback 本地 HEAD）。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class WorktreeManager {
  constructor(repoRoot) {
    this.root = repoRoot;
  }

  git(...args) {
    try {
      return execFileSync('git', args, { cwd: this.root, encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch (e) {
      e.message = (e.stderr || e.message).toString().trim();
      throw e;
    }
  }

  validate() {
    const top = this.git('rev-parse', '--show-toplevel');
    if (path.resolve(top) !== path.resolve(this.root)) {
      throw new Error(`設定的路徑不是 repo 根目錄（根目錄是 ${top}）`);
    }
  }

  baseRef() {
    try {
      return this.git('symbolic-ref', 'refs/remotes/origin/HEAD').replace('refs/remotes/', '');
    } catch {
      return 'HEAD';
    }
  }

  wtPath(ticket) {
    return path.join(this.root, '.claude', 'worktrees', ticket);
  }

  branchExists(branch) {
    return this.git('branch', '--list', branch) !== '';
  }

  add(ticket) {
    const p = this.wtPath(ticket);
    if (fs.existsSync(p)) {
      return { path: p, branch: this.currentBranch(p), reused: true };
    }
    const branch = `feature/${ticket}`;
    if (this.branchExists(branch)) {
      this.git('worktree', 'add', p, branch); // 分支已存在（上次保留的）→ 直接 checkout
    } else {
      this.git('worktree', 'add', p, '-b', branch, this.baseRef());
    }
    this.copyIncludes(p);
    return { path: p, branch, reused: false };
  }

  currentBranch(wtPath) {
    return this.git('-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  }

  // .worktreeinclude：把 gitignored 的 .env 等檔複製進新 worktree（官方只有 claude --worktree 會做）
  copyIncludes(wtPath) {
    const incFile = path.join(this.root, '.worktreeinclude');
    if (!fs.existsSync(incFile)) return;
    const lines = fs
      .readFileSync(incFile, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    for (const rel of lines) {
      const src = path.join(this.root, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(wtPath, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  }

  remove(ticket) {
    const p = this.wtPath(ticket);
    if (!fs.existsSync(p)) throw new Error(`找不到 worktree：${p}`);
    const branch = this.currentBranch(p);
    this.git('worktree', 'remove', p, '--force');
    try {
      this.git('branch', '-D', branch);
    } catch {
      /* 分支可能已不存在 */
    }
  }

  list() {
    return this.git('worktree', 'list');
  }

  // 把工作檔 pattern 加進 .git/info/exclude（common dir，所有 worktree 共用），避免污染 git status
  ensureExclude(pattern) {
    const common = this.git('rev-parse', '--git-common-dir');
    const excludeFile = path.resolve(this.root, common, 'info', 'exclude');
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const cur = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(pattern)) {
      fs.appendFileSync(excludeFile, (cur === '' || cur.endsWith('\n') ? '' : '\n') + pattern + '\n');
    }
  }
}

module.exports = { WorktreeManager };
