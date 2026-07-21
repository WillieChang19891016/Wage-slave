// 極簡 JSON 持久化：settings.json（Jira 設定 / repo 路徑）與 state.json（session ↔ ticket 對照）
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, defaults = {}) {
    this.file = file;
    let saved = {};
    try {
      // 去 BOM：手動編輯/PowerShell 寫的檔案常帶 BOM，JSON.parse 會炸掉導致設定「消失」
      saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch {
      /* 首次啟動沒檔案 */
    }
    this.data = { ...defaults, ...saved };
  }

  get() {
    return this.data;
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

module.exports = { Store };
