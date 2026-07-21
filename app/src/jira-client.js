// JiraClient — Jira Cloud REST API v3（API token / Basic auth）
// 從 spike3 抽出。零依賴（node 18+ 內建 fetch）。
const MAX_LINKED_ISSUES = 5;

// ADF (Atlassian Document Format) → 純文字
function adfToText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return node.attrs?.text || '@?';
  if (node.type === 'inlineCard') return node.attrs?.url || '';

  const children = (node.content || []).map((c) => adfToText(c)).join('');
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

class JiraClient {
  constructor({ domain, email, token } = {}) {
    // 容錯：使用者常把 domain 連 https:// 或結尾斜線一起貼進來
    this.domain = (domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.email = email;
    this.token = token;
  }

  configured() {
    return Boolean(this.domain && this.email && this.token);
  }

  async api(method, apiPath, body) {
    const res = await fetch(`https://${this.domain}/rest/api/3${apiPath}`, {
      method,
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${this.email}:${this.token}`).toString('base64'),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Jira API ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  myself() {
    return this.api('GET', '/myself');
  }

  async myOpenIssues() {
    const data = await this.api('POST', '/search/jql', {
      jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
      maxResults: 50,
      fields: ['summary', 'status', 'issuetype', 'priority', 'updated'],
    });
    return data.issues || [];
  }

  issue(key, fields) {
    return this.api('GET', `/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`);
  }

  // 組任務簡報（markdown）：主 ticket + parent + issue links 的內容。
  // 背景：公司的子單描述常只寫「請查看主單」，不跟關聯單抓內容 prompt 會是空的。
  async composeTaskBrief(key) {
    const detailFields = ['summary', 'status', 'issuetype', 'priority', 'description', 'issuelinks', 'parent'];
    const main = await this.issue(key, detailFields);
    const f = main.fields;

    const lines = [
      `# ${main.key}: ${f.summary}`,
      '',
      `- 狀態: ${f.status?.name} | 類型: ${f.issuetype?.name} | 優先級: ${f.priority?.name || '-'}`,
      `- Jira: https://${this.domain}/browse/${main.key}`,
      '',
      '## 描述',
      '',
      f.description ? adfToText(f.description).trim() : '（無描述）',
    ];

    // 收集關聯單：parent 優先，再來 issuelinks
    const related = [];
    if (f.parent?.key) related.push({ key: f.parent.key, rel: 'parent（主單）' });
    for (const link of f.issuelinks || []) {
      const other = link.inwardIssue || link.outwardIssue;
      const rel = link.inwardIssue ? link.type?.inward : link.type?.outward;
      if (other?.key) related.push({ key: other.key, rel: rel || link.type?.name || 'linked' });
    }

    for (const { key: rKey, rel } of related.slice(0, MAX_LINKED_ISSUES)) {
      try {
        const r = await this.issue(rKey, ['summary', 'status', 'description']);
        lines.push(
          '',
          `## 關聯單 ${r.key}（${rel}）: ${r.fields.summary}`,
          '',
          r.fields.description ? adfToText(r.fields.description).trim() : '（無描述）'
        );
      } catch {
        lines.push('', `## 關聯單 ${rKey}（${rel}）`, '', '（讀取失敗，可能無權限）');
      }
    }
    if (related.length > MAX_LINKED_ISSUES) {
      lines.push('', `（另有 ${related.length - MAX_LINKED_ISSUES} 張關聯單未展開）`);
    }

    return { summary: f.summary, brief: lines.join('\n') + '\n' };
  }
}

module.exports = { JiraClient, adfToText };
