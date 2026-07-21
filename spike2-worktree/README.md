# Spike 2：git worktree 管理

**驗證風險**：worktree 建立/清理流程、分支命名、gitignored 檔案（`.env` 等）複製進 worktree。

零依賴，在目標 git repo 根目錄執行：

```powershell
node <path>\worktree.js add PROJ-123 login-fix   # 建 .claude/worktrees/PROJ-123 + 分支 feature/PROJ-123-login-fix
node <path>\worktree.js list
node <path>\worktree.js remove PROJ-123          # 移除 worktree + 刪分支
```

## 設計決策（會帶進正式版）

- worktree 放 `.claude/worktrees/<ticket>`，和 `claude --worktree` 同位置，`.gitignore` 一條規則就能蓋掉
- base 分支對齊 `claude --worktree` 的 `fresh` 行為：從 `origin/HEAD`（遠端預設分支）開新分支，沒有遠端才 fallback 到本地 HEAD
- `.worktreeinclude`（repo 根目錄，一行一個路徑）裡的檔案會複製進新 worktree —— **注意**：官方的 `.worktreeinclude` 只有 `claude --worktree` 會處理，自己 `git worktree add` 必須自己複製，這正是本 spike 要驗證的點
- `add` 對已存在的 worktree 是冪等的（直接沿用）

## 通過標準

- [ ] `add` 建出 worktree 和正確命名的分支
- [ ] repo 根目錄放一個 gitignored 的 `.env` + `.worktreeinclude` 寫 `.env`，`add` 後 worktree 內有 `.env`
- [ ] `remove` 乾淨移除 worktree 和分支
- [ ] 在公司大 repo 上實測 `add` 的耗時可接受（worktree 共享 .git，理論上只有 checkout 成本）
