# Spike 1：node-pty + xterm.js 跑互動式 claude

**驗證風險**：Windows ConPTY + xterm.js 渲染 claude TUI 的相容性（這是整個專案最大的技術風險）。

## 跑法

```powershell
npm install
npm run test:headless   # 第一關：node-pty 能 spawn claude 並拿到輸出（無 UI）
npm start               # 第二關：Electron 視窗內互動操作 claude
```

## 通過標準

- [ ] `test:headless` 印出 claude 版本號 + `PASS ✅`
- [ ] Electron 視窗內 claude TUI 正常渲染、可打字、Enter / 方向鍵 / Ctrl+C 可用
- [ ] 中文輸入與顯示正常
- [ ] 拉伸視窗後 TUI 重繪不破版
- [ ] permission prompt（y/n 選單）可正常互動

## 已知風險與備案

- **node-pty 原生模組**：用的是 `@homebridge/node-pty-prebuilt-multiarch`（有預編譯 binary，node 和 electron ABI 都有），避免要求本機裝 VS Build Tools。
  - 如果 `npm start` 時報 ABI/NODE_MODULE_VERSION 錯誤 → 跑 `npm run rebuild`
  - 如果 prebuilt 對不上新版 node → 換 `node-pty` 正版並安裝 VS Build Tools，或降 node 版本
- **正式版注意**：spike 用 `nodeIntegration: true` 圖方便，正式版要改 preload + contextBridge。
