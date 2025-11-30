/**
 * 牵牛花 API 基础客户端
 * 负责：签名生成、HTTP请求、Cookie管理
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const vm = require('vm');

// 保存Node.js原生对象（mtgsig.js会删除/覆盖它们）
const _Buffer = Buffer;
const _process = process;
const _global = globalThis.global;
const _setTimeout = setTimeout;
const _setInterval = setInterval;
const _clearTimeout = clearTimeout;
const _clearInterval = clearInterval;

// 恢复Node.js原生对象与计时器，避免影响主进程事件循环
globalThis.Buffer = _Buffer;
globalThis.process = _process;
globalThis.global = _global;
globalThis.setTimeout = _setTimeout;
globalThis.setInterval = _setInterval;
globalThis.clearTimeout = _clearTimeout;
globalThis.clearInterval = _clearInterval;

/**
 * 基础客户端类
 * 提供签名、请求等核心功能
 */
class QNHBaseClient {
    /**
     * 构造函数
     * @param {Object|string} config - 配置对象或Cookie字符串
     */
    constructor(config) {
        if (typeof config === 'string') {
            this.rawCookies = config;
            this.cookies = this.parseCookies(config);
        } else {
            this.rawCookies = config.cookies;
            this.cookies = this.parseCookies(config.cookies);
        }
        
        this.apiDomain = 'https://qnh.meituan.com';
        this.timeout = 30000; // 30秒超时
        
        // 初始化签名环境
        this._initSigner();
    }

    /**
     * 初始化签名沙箱
     * 为本实例创建独立的 VM 沙箱上下文
     * @private
     */
    _initSigner() {
        try {
            const signerCodePath = path.join(__dirname, '../../lib/mtgsig.js');
            const signerCode = fs.readFileSync(signerCodePath, 'utf8');
            
            // 为沙箱提供必要的内置对象与计时器
            this._signerContext = vm.createContext({
                console,
                setTimeout,
                setInterval,
                clearTimeout,
                clearInterval
            });
            
            // 注入 CommonJS 模块对象与 globalThis
            this._signerContext.globalThis = this._signerContext;
            this._signerContext.module = { exports: {} };
            this._signerContext.exports = this._signerContext.module.exports;
            
            // 在加载前用本实例的 Cookie 覆盖源码中的硬编码 cookie
            const runtimeCookie = (this.rawCookies || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const signerCodePatched = signerCode.replace(/cookie:\s*'[^']*'/, `cookie: '${runtimeCookie}'`);

            // 运行签名库代码
            vm.runInContext(signerCodePatched, this._signerContext, { filename: 'mtgsig.js' });
            
            // 绑定 getSign 引用
            this._getSign = (this._signerContext.module && this._signerContext.module.exports && this._signerContext.module.exports.getSign)
                ? this._signerContext.module.exports.getSign
                : this._signerContext.getSign;
        } catch (e) {
            console.error('[QNH-V2 Base] 初始化签名沙箱失败:', e);
            this._signerContext = null;
        }
    }

    /**
     * 解析Cookie字符串为对象
     */
    parseCookies(cookieStr) {
        const cookies = {};
        if (!cookieStr) return cookies;

        cookieStr.split(';').forEach(cookie => {
            const parts = cookie.trim().split('=');
            if (parts.length >= 2) {
                cookies[parts[0]] = parts.slice(1).join('=');
            }
        });
        return cookies;
    }

    /**
     * 生成mtgsig签名
     * @param {string} url - 完整URL
     * @param {Object} body - 请求体
     * @returns {string} 签名字符串
     */
    generateMtgsig(url, body) {
        const urlObj = new URL(url);
        
        try {
            const oriUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
            const method = 'POST';
            const dataStr = JSON.stringify(body);

            if (!this._signerContext || typeof this._getSign !== 'function') {
                throw new Error('签名环境未就绪');
            }

            // 为本实例沙箱注入当前 Cookies（动态注入，支持并发）
            if (this._signerContext.document) {
                this._signerContext.document.cookie = this.getCookieString();
            } else {
                this._signerContext.document = { cookie: this.getCookieString() };
            }

            const mtgsig = this._getSign(method, url, oriUrl, dataStr);
            return mtgsig;
        } catch (error) {
            console.error('[QNH-V2 Base] 生成签名失败:', error);
            // 回退到简化版（虽然可能不工作）
            const signStr = urlObj.pathname + JSON.stringify(body) + (this.cookies['token'] || '');
            const fallbackSign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex');
            console.warn('[QNH-V2 Base] 使用回退签名（可能无效）:', fallbackSign.substring(0, 32));
            return fallbackSign;
        }
    }

    /**
     * 获取请求头
     * @param {string} mtgsig - 签名（可选）
     * @returns {Object} 请求头对象
     */
    getHeaders(mtgsig = null) {
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Content-Type': 'application/json;charset=UTF-8',
            'M-APPKEY': 'fe_recofesaascrm',
            'M-TRACEID': '5678042275886624881',
            'Origin': 'https://qnh.meituan.com',
            'Pragma': 'no-cache',
            'Referer': 'https://qnh.meituan.com/home.html',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"'
        };

        if (mtgsig) {
            headers['mtgsig'] = mtgsig;
        }

        return headers;
    }

    /**
     * 获取Cookie字符串
     */
    getCookieString() {
        return this.rawCookies;
    }

    /**
     * 通用请求方法
     * @param {string} method - HTTP方法
     * @param {string} url - 完整URL
     * @param {Object} data - 请求数据（POST）
     * @param {boolean} needSign - 是否需要签名
     * @returns {Promise<Object>} 响应数据
     */
    request(method, url, data = null, needSign = true) {
        return new Promise((resolve, reject) => {
            try {
                const urlObj = new URL(url);
                
                let mtgsig = null;
                if (needSign && data && method === 'POST') {
                    mtgsig = this.generateMtgsig(url, data);
                    console.log(`[QNH-V2 Base] 生成签名: ${mtgsig ? mtgsig.substring(0, 50) + '...' : 'null'}`);
                }

                const headers = this.getHeaders(mtgsig);
                headers['Cookie'] = this.getCookieString();
                headers['Host'] = urlObj.host;

                let postData = '';
                if (data && method === 'POST') {
                    postData = JSON.stringify(data);
                    headers['Content-Length'] = Buffer.byteLength(postData);
                }

                const options = {
                    hostname: urlObj.hostname,
                    port: 443,
                    path: urlObj.pathname + urlObj.search,
                    method: method,
                    headers: headers,
                    timeout: this.timeout
                };

                console.log(`[QNH-V2 Base] 请求接口: ${method} ${url}`);
                if (data) {
                    const dataStr = JSON.stringify(data);
                    console.log(`[QNH-V2 Base] 请求数据: ${dataStr.substring(0, 200)}${dataStr.length > 200 ? '...' : ''}`);
                }

                const req = https.request(options, (res) => {
                    let body = '';

                    res.on('data', (chunk) => {
                        body += chunk;
                    });

                    res.on('end', () => {
                        try {
                            const result = JSON.parse(body);
                            
                            if (result.code === 0) {
                                console.log(`[QNH-V2 Base] 接口调用成功`);
                                resolve(result);
                            } else {
                                const errorMsg = result.msg || result.message || result.error || result.errMsg || result.errorMessage;
                                
                                if (!errorMsg) {
                                    console.error(`[QNH-V2 Base] 接口返回错误，但未找到错误信息。完整响应:`, JSON.stringify(result, null, 2));
                                    const errorDetail = `接口返回错误 (code: ${result.code})，但响应中未包含错误描述。请检查Cookie是否有效或联系技术支持`;
                                    console.error(`[QNH-V2 Base] ${errorDetail}`);
                                    reject(new Error(errorDetail));
                                } else {
                                    console.error(`[QNH-V2 Base] 接口返回错误 (code: ${result.code}): ${errorMsg}`);
                                    if (result.data) {
                                        console.error(`[QNH-V2 Base] 错误详情:`, JSON.stringify(result.data, null, 2));
                                    }
                                    reject(new Error(`牵牛花API错误 (code: ${result.code}): ${errorMsg}`));
                                }
                            }
                        } catch (error) {
                            console.error('[QNH-V2 Base] 解析响应失败:', error);
                            console.error('[QNH-V2 Base] 原始响应内容:', body.substring(0, 500));
                            reject(new Error('解析响应失败: ' + error.message));
                        }
                    });
                });

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('请求超时'));
                });

                req.on('error', (error) => {
                    console.error('[QNH-V2 Base] 请求失败:', error);
                    reject(new Error('网络请求失败: ' + error.message));
                });

                if (postData) {
                    req.write(postData);
                }
                req.end();

            } catch (error) {
                console.error('[QNH-V2 Base] 请求异常:', error);
                reject(error);
            }
        });
    }

    /**
     * 工具方法：延时
     * @param {number} ms - 毫秒数
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 下载文件
     * @param {string} url - 文件URL
     * @param {string} savePath - 保存路径
     * @returns {Promise<void>}
     */
    downloadFile(url, savePath) {
        return new Promise((resolve, reject) => {
            console.log(`[QNH-V2 Base] 开始下载文件: ${savePath}`);

            // 确保目录存在
            const dir = path.dirname(savePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const urlObj = new URL(url);
            const protocol = urlObj.protocol === 'https:' ? https : http;

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                timeout: 60000
            };

            const req = protocol.request(options, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`下载失败，状态码: ${res.statusCode}`));
                    return;
                }

                const fileStream = fs.createWriteStream(savePath);
                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    console.log(`[QNH-V2 Base] 文件下载成功: ${savePath}`);
                    resolve();
                });

                fileStream.on('error', (error) => {
                    fs.unlink(savePath, () => {});
                    reject(error);
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('下载超时'));
            });

            req.on('error', (error) => {
                reject(error);
            });

            req.end();
        });
    }
}

module.exports = QNHBaseClient;

