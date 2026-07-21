# Wage-slave app（Phase 1）

點一張 Jira ticket → 自動抓 ticket + 關聯單內容 → 建 worktree + 分支 → 啟動 claude session（初始 prompt 就是任務簡報）→ 多 session 並行。

```powershell
cd app
npm install
npm start
```

## 使用流程

1. 首次啟動填設定（⚙）：Jira domain / email / API token、**目標 repo 根目錄**（你要開發的專案）
2. 側欄「我的 Jira tickets」點一張 → 自動：
   - `composeTaskBrief`：抓 ticket 描述 + parent 主單 + issue links 內容組成 markdown 簡報
   - `WorktreeManager.add`：`.claude/worktrees/<ticket>` + 分支 `feature/<ticket>`（`.worktreeinclude` 檔案會複製進去）
   - 簡報寫進 worktree 的 `.wage-slave-task.md`（已加 `.git/info/exclude`，不會污染 git status）
   - 啟動 `claude "請先閱讀 .wage-slave-task.md…"` 互動 session
3. 多開幾張就是多個並行 session，tab 切換，狀態燈 🟢 執行中 / ⚪ 已結束
4. tab 上的 × = 結束 process（worktree 保留），側欄「工作區」的 **接回** = `claude --continue` 恢復對話；**清除** = kill + 移除 worktree + 分支
5. App 重啟後「工作區」清單還在，可直接接回

## 架構

```
main.js                 Electron main：IPC 路由
src/jira-client.js      Jira Cloud REST v3 + ADF→text + composeTaskBrief（跟關聯單）
src/worktree-manager.js git worktree add/remove + .worktreeinclude + info/exclude
src/session-manager.js  @lydell/node-pty spawn claude.exe（直接 spawn，不經 cmd，避免 quoting）
src/store.js            settings.json / state.json（%APPDATA%\wage-slave\）
renderer/               vanilla JS + xterm.js（無 bundler）
```

設計筆記：

- 初始 prompt 不直接塞 ticket 內容（換行/引號 quoting 地雷），改寫進 `.wage-slave-task.md` 再叫 claude 去讀
- resize 防抖 200ms + 自動 focus（spike1 的 ConPTY 死鎖教訓）
- token 明文存 `%APPDATA%\wage-slave\settings.json`（等同 .env 的信任等級）；正式分發前應改 safeStorage
- `nodeIntegration: true` 是 Phase 1 便宜行事，分發前改 preload + contextBridge

## Phase 1 驗收清單

- [x] 模組冒煙測試：JiraClient（list + composeTaskBrief 跟主單）、WorktreeManager（add/exclude/remove）、SessionManager（spawn claude）
- [ ] GUI：點 ticket 一路開到 claude session，初始 prompt 有任務內容
- [ ] 同時 2+ session 並行互不干擾
- [ ] 關 app 重開 → 接回既有 session（--continue）
- [ ] 清除流程：worktree + 分支乾淨移除

## Phase 2 預告

hooks 狀態偵測（🟡 等輸入 + 桌面通知）、git status 摘要、一鍵 push + 開 GitLab Draft MR + 回填 Jira。
