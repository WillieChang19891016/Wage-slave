// GitLabClient — 開 Draft MR 用（REST API v4，PRIVATE-TOKEN）。零依賴（node 18+ fetch）。
// host / project 從 git remote URL 解析，不用另外設定；假設 GitLab API 走 https 標準 port。

// git@host:group/proj.git | ssh://git@host:2222/group/proj.git | https://host/group/proj.git
function parseRemote(url) {
  const u = url.trim();
  let m = u.match(/^(?:ssh:\/\/)?git@([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/);
  if (!m) m = u.match(/^https?:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`解析不了 remote URL：${u}`);
  return { host: m[1], project: m[2] };
}

class GitLabClient {
  constructor({ host, token }) {
    this.host = host;
    this.token = token;
  }

  async api(method, apiPath, body) {
    const res = await fetch(`https://${this.host}/api/v4${apiPath}`, {
      method,
      headers: { 'PRIVATE-TOKEN': this.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitLab API ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  project(projectPath) {
    return this.api('GET', `/projects/${encodeURIComponent(projectPath)}`);
  }

  // 同 source branch 已有 open MR → 直接回它（冪等，按兩次不會開兩張）
  async ensureDraftMr({ project, sourceBranch, targetBranch, title, description }) {
    const pid = encodeURIComponent(project);
    const open = await this.api(
      'GET',
      `/projects/${pid}/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}`
    );
    if (open.length) return { ...open[0], existed: true };
    const mr = await this.api('POST', `/projects/${pid}/merge_requests`, {
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title,
      description,
      remove_source_branch: true,
    });
    return { ...mr, existed: false };
  }
}

module.exports = { GitLabClient, parseRemote };
