# Spike 3：Jira REST API v3（API token）

**驗證風險**：API token 認證可行性、JQL 查詢、ADF 描述格式轉純文字（未來要直接餵給 claude 當初始 prompt）。

零依賴（node 18+ 內建 fetch）。

## 跑法

```powershell
copy .env.example .env   # 填 JIRA_DOMAIN / JIRA_EMAIL / JIRA_TOKEN
node jira.js me          # 驗證登入
node jira.js list        # assignee = currentUser() AND statusCategory != Done
node jira.js show PROJ-123
```

API token 申請：https://id.atlassian.com/manage-profile/security/api-tokens

## 設計決策

- 用 **API token（Basic auth）** 不用 OAuth 3LO — 單人工具不需要，省掉 app 註冊和 token rotation
- 搜尋走新版 `POST /rest/api/3/search/jql`（舊版 `/search` 已被 Atlassian 淘汰）
- ADF → 純文字是自己寫的簡易遞迴（夠 spike 用），正式版換 `adf-to-md` 拿完整 markdown

## 通過標準

- [ ] `me` 顯示自己的 displayName
- [ ] `list` 列出自己的未完成 ticket
- [ ] `show` 的描述輸出可讀（段落、清單、code block 都有基本處理）
