# Wage-slave

Jira-Driven 多 Agent 並行 IDE — 點一張 Jira ticket，自動開 git worktree + 分支 + 啟動一個 Claude Code session，多個 session 並行處理。

## Phase 0：技術驗證 Spikes

三個 spike 各自獨立，目的是在搭 Electron UI 之前，先把三個最大的技術風險打穿。
**任一個打不穿，就回頭重新選型，不要開始搭 UI。**

| Spike | 驗證什麼 | 通過標準 |
|---|---|---|
| [spike1-pty-terminal](./spike1-pty-terminal/) | node-pty(ConPTY) + xterm.js 在 Windows 跑互動式 `claude` TUI | Electron 視窗內能正常操作 claude（含中文、permission prompt、TUI 重繪） |
| [spike2-worktree](./spike2-worktree/) | git worktree 建立/清理 + 分支命名 + gitignored 檔案複製 | `add/list/remove` 三個指令跑通，`.worktreeinclude` 檔案有被複製 |
| [spike3-jira](./spike3-jira/) | Jira REST API v3 + API token 拿 ticket、ADF 描述轉純文字 | `me/list/show` 三個指令拿得到自己的 ticket 清單與完整描述 |

## 快速開始

```powershell
# Spike 1（需要 npm install，electron 較大）
cd spike1-pty-terminal
npm install
npm run test:headless   # 先跑無 UI 驗證：node-pty 能不能 spawn claude
npm start               # 開 Electron 視窗跑互動式 claude

# Spike 2（零依賴，在任何 git repo 根目錄跑）
node spike2-worktree/worktree.js add PROJ-123 login-fix
node spike2-worktree/worktree.js list
node spike2-worktree/worktree.js remove PROJ-123

# Spike 3（零依賴，需先設定 Jira API token）
cd spike3-jira
copy .env.example .env  # 填入 domain / email / token
node jira.js me
node jira.js list
node jira.js show PROJ-123
```

## 下一步（Phase 1）

三個 spike 都綠了之後：Electron 專案骨架 + 多 tab terminal grid + Jira 側欄，把三個 spike 的邏輯抽成 `JiraClient` / `WorktreeManager` / `SessionManager` 三個純 Node 模組。
