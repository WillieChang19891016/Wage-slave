# Spike 1：node-pty + xterm.js 跑互動式 claude

**驗證風險**：Windows ConPTY + xterm.js 渲染 claude TUI 的相容性（這是整個專案最大的技術風險）。

## 跑法

```powershell
npm install
npm run test:headless   # 第一關：node-pty 能 spawn claude 並拿到輸出（無 UI）
npm start               # 第二關：Electron 視窗內互動操作 claude
```

## 通過標準

- [x] `test:headless` 印出 claude 版本號 + `PASS ✅`
- [x] Electron 視窗內 claude TUI 正常渲染、可打字、Enter / 方向鍵 / Ctrl+C 可用
- [x] 中文輸入與顯示正常
- [x] 拉伸視窗後 TUI 重繪不破版
- [x] permission prompt（y/n 選單）可正常互動

## 驗證紀錄（2026-07-21，node v24.11.1 / Windows 11）

- ❌ 第一次選 `@homebridge/node-pty-prebuilt-multiarch`：沒有 node 24（ABI v137）的 prebuilt，
  原始碼編譯 fallback 也掛（spawn EINVAL）→ **換掉**
- ✅ 改用 `@lydell/node-pty`（esbuild 式 per-platform 預編譯 + N-API）：
  - `test:headless` 在 node 24 下 PASS
  - 用 `ELECTRON_RUN_AS_NODE=1` 跑同一測試（Electron runtime ABI）也 PASS
  - 不需要 VS Build Tools、不需要 electron-rebuild
- ✅ `npm start` GUI 人工驗證通過（中文 / resize / permission prompt）
- ⚠️ 第一輪 GUI 測試出現「畫面凍住」，兩個修正後不再復現（**正式版必帶**）：
  1. xterm 失去鍵盤焦點看起來就像凍住 → 啟動自動 `term.focus()` + 點擊終端機區域回焦
  2. 連續 resize 事件直灌 ConPTY 是 node-pty win32 已知死鎖來源 → resize 防抖 200ms
  3. 狀態列改成診斷儀表（pid / 最後輸出 / 最後按鍵 / focus），凍住時可一眼分辨死因

## 正式版注意

- spike 用 `nodeIntegration: true` 圖方便，正式版要改 preload + contextBridge。
