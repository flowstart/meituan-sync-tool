#!/usr/bin/env node
/*
 独立进程的 mtgsig 生成器：
 - 从 stdin 读取 JSON: { method, url, oriUrl, data, cookie, referrerUrl, traceId, contentType }
 - 在进程启动后，先注入全局 Cookie/Referrer，再 require('./mtgsig')，确保 H5guard 初始化读取到当前指纹
 - 输出签名字符串
*/

const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

(async () => {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw || '{}');
    const { method, url, oriUrl, data, cookie, referrerUrl, traceId, contentType } = payload;

    // 在 require mtgsig 之前注入全局
    globalThis.__QNH_COOKIE__ = cookie || '';
    globalThis.__QNH_REFERRER__ = referrerUrl || 'https://qnh.meituan.com/goods/edit';

    const mtgsigLib = require(path.join(__dirname, 'mtgsig.js'));

    const opts = {
      cookie: cookie || '',
      referrerUrl: referrerUrl || 'https://qnh.meituan.com/goods/edit',
      referrerPath: (() => {
        try { return new URL(referrerUrl).pathname; } catch { return '/goods/edit'; }
      })(),
      traceId: (traceId && String(traceId)) || '5678042275886624881',
      contentType: contentType || 'application/json;charset=UTF-8',
    };

    const sign = mtgsigLib.getSign(method || 'POST', url, oriUrl || (new URL(url)).origin + (new URL(url)).pathname, data || '', opts);
    process.stdout.write(String(sign || ''));
  } catch (e) {
    // 失败时输出空字符串，便于调用方回退
    process.stdout.write('');
    process.stderr.write(`[mtgsig_signer] error: ${e && e.stack || e}\n`);
    process.exitCode = 1;
  }
})();




