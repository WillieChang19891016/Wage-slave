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
src/jira-client.js      Jira Cloud REST v3 + ADF→text + composeTaskBrief（跟關聯單）+ addComment
src/gitlab-client.js    GitLab REST v4：remote URL 解析 + ensureDraftMr（冪等開 Draft MR）
src/worktree-manager.js git worktree add/remove + .worktreeinclude + info/exclude
src/session-manager.js  @lydell/node-pty spawn claude.exe（直接 spawn，不經 cmd，避免 quoting）
src/store.js            settings.json / state.json（%APPDATA%\wage-slave\）
renderer/               vanilla JS + xterm.js（無 bundler）
assets/                 icon.ico + make-icon.js（零依賴產生器，node assets/make-icon.js 重生成）
```

設計筆記：

- 初始 prompt 不直接塞 ticket 內容（換行/引號 quoting 地雷），改寫進 `.wage-slave-task.md` 再叫 claude 去讀
- resize 防抖 200ms + 自動 focus（spike1 的 ConPTY 死鎖教訓）
- token 明文存 `%APPDATA%\wage-slave\settings.json`（等同 .env 的信任等級）；正式分發前應改 safeStorage
- `nodeIntegration: true` 是 Phase 1 便宜行事，分發前改 preload + contextBridge

## Phase 1 驗收清單（2026-07-22 全過）

- [x] 模組冒煙測試：JiraClient（list + composeTaskBrief 跟主單）、WorktreeManager（add/exclude/remove）、SessionManager（spawn claude）
- [x] GUI：點 ticket 一路開到 claude session，初始 prompt 有任務內容
- [x] 同時 2+ session 並行互不干擾（split pane grid）
- [x] 關 app 重開 → 接回既有 session（--continue）
- [x] 清除流程：worktree + 分支乾淨移除

驗收抓到並修掉的 bug：settings BOM、jira domain 帶 https://、
巢狀 CLAUDE* env 汙染導致對話不存檔、關窗時對已銷毀 webContents send 崩潰。

## Phase 2（hook 狀態 + 多 repo，2026-07-22）

- [x] HookServer：per-session `--settings` 注入，Stop / Notification / UserPromptSubmit
  事件 curl 回 localhost（E2E 驗證：送 prompt → 🟢 → 回完話 → 🟡）
- [x] 狀態燈三態：🟢 工作中 / 🟡 等輸入 / 🔴 要權限（pulse）
- [x] 視窗不在前景時桌面通知，點通知聚焦視窗
- [x] 多 repo：設定填 repo 清單，側欄下拉選目標 repo，session 綁定建立當時的 repo
- [x] git 變更摘要顯示在 pane header（`⇡N` 領先 base 的 commit 數 / `±N` 未 commit 檔案數；
  5 秒輪詢 + claude 回完話（Stop hook）立即刷新）
- [x] 一鍵 push + 開 GitLab Draft MR + 回填 Jira comment（2026-08-03 實作，待實機驗收）
  - pane header「MR」鈕：push 分支 → 開 Draft MR → Jira ticket 留 MR 連結
  - GitLab host/project 從 `git remote get-url origin` 解析，只需在 ⚙ 補一個 GitLab token（scope: api）
  - 冪等：同分支已有 open MR 就沿用，不會開第二張；Jira 回填失敗不擋流程
  - 側欄工作區清單有「MR ↗」鈕可隨時再開瀏覽器
  - 防呆：分支無新 commit 直接擋下；有未 commit 檔案先 confirm

- [x] 工作區比對 Jira 狀態（2026-08-03）：已 Done 的單顯示「已 Done」徽章並淡化，
  一眼看出可清的殭屍工作區（60 秒快取，⟳ 強制刷新）；worktree/分支仍由人手動「清除」，
  app 永不自動刪本地工作
- [x] 清除 confirm 升級：顯示 Jira 是否已 Done + 未 commit 檔數 + 未 push commit 數，
  都推乾淨會明說「可安全清除」

### 一鍵 MR 實機驗收清單（待跑）

- [ ] 對真 GitLab repo 按 MR：push 成功、Draft MR 開出、Jira comment 出現連結
- [ ] 再按一次 MR：不會開第二張，沿用同一張
- [ ] 分支沒 commit 時按 MR：被擋下並提示
- [ ] repo 沒設 origin/HEAD 時：target branch 正確 fallback 到 GitLab default branch
