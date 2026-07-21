#!/usr/bin/env node
// Spike 3：Jira REST API v3 + API token — 未來 JiraClient 模組的雛形。
// 零依賴（node 18+ 內建 fetch）。設定放 .env（見 .env.example）。
//
// 用法：
//   node jira.js me              驗證登入（顯示自己是誰）
//   node jira.js list            列出 assign 給我的未完成 ticket
//   node jira.js show PROJ-123   顯示單張 ticket（含 ADF 描述轉純文字）
const fs = require('fs');
const path = require('path');

// ---- 讀 .env（不用 dotenv，spike 保持零依賴）----
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  const { JIRA_DOMAIN, JIRA_EMAIL, JIRA_TOKEN } = process.env;
  if (!JIRA_DOMAIN || !JIRA_EMAIL || !JIRA_TOKEN) {
    console.error('❌ 缺少設定。請 copy .env.example .env 並填入 JIRA_DOMAIN / JIRA_EMAIL / JIRA_TOKEN');
    console.error('   API token 申請：https://id.atlassian.com/manage-profile/security/api-tokens');
    process.exit(1);
  }
  return { domain: JIRA_DOMAIN, email: JIRA_EMAIL, token: JIRA_TOKEN };
}

async function api(cfg, method, apiPath, body) {
  const res = await fetch(`https://${cfg.domain}/rest/api/3${apiPath}`, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64'),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
  }
  return res.json();
}

// ---- ADF (Atlassian Document Format) → 純文字 ----
// spike 版：只求可讀，正式版再換 adf-to-md 套件
function adfToText(node, depth = 0) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return node.attrs?.text || '@?';
  if (node.type === 'inlineCard') return node.attrs?.url || '';

  const children = (node.content || []).map((c) => adfToText(c, depth + 1)).join('');
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return children + '\n';
    case 'listItem':
      return '- ' + children;
    case 'codeBlock':
      return '```\n' + children + '\n```\n';
    case 'rule':
      return '---\n';
    default:
      return children;
  }
}

function fmtIssue(i) {
  const f = i.fields;
  return `${i.key}  [${f.status?.name}]  ${f.summary}`;
}

async function main() {
  const cfg = loadEnv();
  const [cmd, arg] = process.argv.slice(2);

  switch (cmd) {
    case 'me': {
      const me = await api(cfg, 'GET', '/myself');
      console.log(`✅ 登入成功：${me.displayName} <${me.emailAddress}> (accountId: ${me.accountId})`);
      break;
    }
    case 'list': {
      const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
      const data = await api(cfg, 'POST', '/search/jql', {
        jql,
        maxResults: 30,
        fields: ['summary', 'status', 'issuetype', 'priority', 'updated'],
      });
      const issues = data.issues || [];
      console.log(`📋 我的未完成 ticket（${issues.length} 張）：\n`);
      for (const i of issues) console.log('  ' + fmtIssue(i));
      if (!issues.length) console.log('  （沒有 — JQL: ' + jql + '）');
      break;
    }
    case 'show': {
      if (!arg) { console.error('用法：node jira.js show PROJ-123'); process.exit(1); }
      const i = await api(cfg, 'GET', `/issue/${arg}?fields=summary,status,issuetype,priority,description,assignee`);
      const f = i.fields;
      console.log(`# ${i.key}: ${f.summary}`);
      console.log(`狀態: ${f.status?.name} | 類型: ${f.issuetype?.name} | 優先級: ${f.priority?.name || '-'}`);
      console.log(`\n--- 描述（ADF → 純文字，未來直接當 claude 初始 prompt 用）---\n`);
      console.log(f.description ? adfToText(f.description).trim() : '（無描述）');
      break;
    }
    default:
      console.log('用法：node jira.js <me|list|show> [PROJ-123]');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
