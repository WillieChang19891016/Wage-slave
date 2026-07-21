#!/usr/bin/env node
// Spike 2：git worktree 管理 — 未來 WorktreeManager 模組的雛形。
//
// 用法（在目標 git repo 根目錄執行）：
//   node worktree.js add PROJ-123 [slug]   建 worktree + 分支 feature/PROJ-123[-slug]，複製 .worktreeinclude 檔案
//   node worktree.js list                  列出所有 worktree
//   node worktree.js remove PROJ-123       移除 worktree + 刪分支
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKTREE_ROOT = path.join('.claude', 'worktrees');

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function repoRoot() {
  try {
    return git('rev-parse', '--show-toplevel');
  } catch {
    console.error('❌ 這裡不是 git repo，請在目標 repo 根目錄執行');
    process.exit(1);
  }
}

// 對齊 claude --worktree 的 fresh 行為：從遠端預設分支開新分支；沒有遠端就用本地 HEAD
function baseRef() {
  try {
    const head = git('symbolic-ref', 'refs/remotes/origin/HEAD'); // refs/remotes/origin/main
    return head.replace('refs/remotes/', '');
  } catch {
    return 'HEAD';
  }
}

// .worktreeinclude：一行一個相對路徑（spike 只支援明確路徑，不做 glob）
function copyIncludes(root, wtPath) {
  const incFile = path.join(root, '.worktreeinclude');
  if (!fs.existsSync(incFile)) return;
  const lines = fs
    .readFileSync(incFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const rel of lines) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) {
      console.log(`  ⚠️  .worktreeinclude 指定的 ${rel} 不存在，略過`);
      continue;
    }
    const dst = path.join(wtPath, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    console.log(`  📄 copied ${rel}`);
  }
}

function add(ticket, slug) {
  const root = repoRoot();
  const branch = slug ? `feature/${ticket}-${slug}` : `feature/${ticket}`;
  const wtPath = path.join(root, WORKTREE_ROOT, ticket);

  if (fs.existsSync(wtPath)) {
    console.log(`♻️  worktree 已存在：${wtPath}（直接沿用）`);
  } else {
    const base = baseRef();
    console.log(`🌱 git worktree add ${wtPath} -b ${branch}（base: ${base}）`);
    git('worktree', 'add', wtPath, '-b', branch, base);
    copyIncludes(root, wtPath);
  }

  console.log('✅ 完成。啟動 session：');
  console.log(`   cd "${wtPath}"; claude`);
  return wtPath;
}

function list() {
  console.log(git('worktree', 'list'));
}

function remove(ticket) {
  const root = repoRoot();
  const wtPath = path.join(root, WORKTREE_ROOT, ticket);
  if (!fs.existsSync(wtPath)) {
    console.error(`❌ 找不到 worktree：${wtPath}`);
    process.exit(1);
  }
  // 找出該 worktree 目前的分支，移除後一併刪掉
  const branch = git('-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  git('worktree', 'remove', wtPath, '--force');
  try {
    git('branch', '-D', branch);
    console.log(`🗑️  removed worktree + branch ${branch}`);
  } catch {
    console.log(`🗑️  removed worktree（分支 ${branch} 刪除失敗，可能已不存在）`);
  }
}

const [cmd, ticket, slug] = process.argv.slice(2);
switch (cmd) {
  case 'add':
    if (!ticket) { console.error('用法：node worktree.js add PROJ-123 [slug]'); process.exit(1); }
    add(ticket, slug);
    break;
  case 'list':
    list();
    break;
  case 'remove':
    if (!ticket) { console.error('用法：node worktree.js remove PROJ-123'); process.exit(1); }
    remove(ticket);
    break;
  default:
    console.log('用法：node worktree.js <add|list|remove> [TICKET] [slug]');
    process.exit(1);
}
