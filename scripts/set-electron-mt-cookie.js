#!/usr/bin/env node
/*
 将 electron-app/lib/mtgsig.js 内的 document.cookie 行重写为指定 Cookies。
 用法：
   node scripts/set-electron-mt-cookie.js --cookie 'xxx=1; y=2; ...'
*/

const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cookie') {
      out.cookie = args[++i] || '';
    }
  }
  return out;
}

function main() {
  const { cookie } = parseArgs();
  if (!cookie) {
    console.error('请通过 --cookie 传入 Cookie 字符串');
    process.exit(1);
  }

  const file = path.join(__dirname, '..', 'lib', 'mtgsig.js');
  const raw = fs.readFileSync(file, 'utf8');

  const lines = raw.split(/\r?\n/);
  let replaced = false;
  const newLines = lines.map((line) => {
    const idx = line.indexOf('cookie:');
    if (idx >= 0) {
      // 仅替换以 cookie: 开头的该行（忽略其它上下文出现的单词）
      const head = line.slice(0, idx);
      const tail = line.slice(idx);
      // 保留缩进
      if (/^cookie:\s*/.test(tail.trimStart())) {
        const indent = head;
        const newLine = `${indent}cookie: '${cookie.replace(/'/g, "\\'")}'`;
        replaced = true;
        return newLine;
      }
    }
    return line;
  });

  if (!replaced) {
    console.error('未找到 cookie 行，文件结构可能变化，请手动检查。');
    process.exit(2);
  }

  fs.writeFileSync(file, newLines.join('\n'), 'utf8');
  console.log('✅ 已写入 Cookies 到 electron-app/lib/mtgsig.js');
}

main();




