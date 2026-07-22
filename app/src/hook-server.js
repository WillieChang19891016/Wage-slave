// HookServer — 接收 claude hooks 的回報，session 狀態的真實來源。
// 每個 session 注入 --settings，讓 claude 在關鍵事件時 curl 回來：
//   Stop             → 回完話，等使用者輸入（🟡）
//   Notification     → 要權限 / 需要注意（🔴）
//   UserPromptSubmit → 收到新 prompt，開始工作（🟢）
const http = require('http');
const { EventEmitter } = require('events');

class HookServer extends EventEmitter {
  start() {
    this.server = http.createServer((req, res) => {
      const m = req.url.match(/^\/hook\/(\w+)\/([^/?]+)/);
      if (m) this.emit('hook', m[1], decodeURIComponent(m[2]));
      res.end('ok');
    });
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  // 產生單一 session 的 hooks 設定物件（寫成 JSON 檔後用 --settings 傳給 claude）
  settingsFor(ticket) {
    const hook = (event) => [
      {
        hooks: [
          {
            type: 'command',
            command: `curl -s --max-time 3 http://127.0.0.1:${this.port}/hook/${event}/${encodeURIComponent(ticket)}`,
          },
        ],
      },
    ];
    return {
      hooks: {
        Stop: hook('stop'),
        Notification: hook('notification'),
        UserPromptSubmit: hook('prompt'),
      },
    };
  }

  close() {
    this.server?.close();
  }
}

module.exports = { HookServer };
