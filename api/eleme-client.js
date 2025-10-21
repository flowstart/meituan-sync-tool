/**
 * 饿了么 API 客户端
 * 完整实现：Cookie验证、商品导出、操作日志查询
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

class ElemeClient {
    /**
     * 构造函数
     * @param {Object|string} config - 配置对象或Cookie字符串
     *   - 如果是字符串：仅用于静态方法（Cookie验证）
     *   - 如果是对象：{ cookies, seller_id, store_id }
     */
    constructor(config) {
        if (typeof config === 'string') {
            // 兼容旧版：直接传入cookie字符串
            this.rawCookies = config;
            this.cookies = this.parseCookies(config);
            this.sellerId = null;
            this.storeId = null;
        } else {
            // 新版：传入配置对象
            this.rawCookies = config.cookies;
            this.cookies = this.parseCookies(config.cookies);
            this.sellerId = config.seller_id;
            this.storeId = config.store_id;
        }
        
        this.appKey = '12574478';
        this.apiDomain = 'https://nrshop.ele.me/h5';
        this.timeout = 30000; // 30秒超时
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
     * 获取Token（从_m_h5_tk cookie中提取）
     */
    getToken() {
        return this.cookies['_m_h5_tk'] || '';
    }

    /**
     * 生成MD5签名
     */
    generateSign(timestamp, dataStr) {
        const token = this.getToken();

        // 提取token（_之前的部分）
        let secret;
        if (token.includes('_')) {
            secret = token.split('_')[0];
        } else {
            secret = token.length >= 32 ? token.substring(0, 32) : token;
        }

        // 拼接签名字符串：{secret}&{timestamp}&{appKey}&{data}
        const signStr = `${secret}&${timestamp}&${this.appKey}&${dataStr}`;

        // MD5加密
        const sign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex');
        return sign;
    }

    /**
     * 构建请求URL
     */
    buildUrl(apiPath, dataStr) {
        const timestamp = Date.now().toString();
        const sign = this.generateSign(timestamp, dataStr);

        // API路径转小写
        const apiPathLower = apiPath.toLowerCase();

        const params = new URLSearchParams({
            jsv: '2.7.2',
            appKey: this.appKey,
            t: timestamp,
            sign: sign,
            v: '1.0',
            api: apiPath,
            type: 'originaljson',
            dataType: 'json'
        });

        return `${this.apiDomain}/${apiPathLower}/1.0/?${params.toString()}`;
    }

    /**
     * 获取请求头
     */
    getHeaders() {
        const headers = {
            'accept': 'application/json',
            'accept-language': 'zh-CN,zh;q=0.9',
            'content-type': 'application/x-www-form-urlencoded',
            'origin': 'https://nr.ele.me',
            'referer': 'https://nr.ele.me/app/eleme-nr-bfe-newretail/common-next',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
            'x-ele-platform': 'eb'
        };

        // 添加 x-ele-eb-token
        if (this.cookies['WMSTOKEN']) {
            const token = this.cookies['WMSTOKEN'];
            headers['x-ele-eb-token'] = `${token};${token}`;
        }

        return headers;
    }

    /**
     * 获取Cookie字符串（直接返回原始字符串）
     */
    getCookieString() {
        return this.rawCookies;
    }

    /**
     * 通用请求方法
     * @private
     */
    _request(apiPath, data) {
        return new Promise((resolve, reject) => {
            try {
                const dataStr = JSON.stringify(data);
                const url = this.buildUrl(apiPath, dataStr);
                const urlObj = new URL(url);
                const headers = this.getHeaders();

                // 手动设置Cookie header
                headers['Cookie'] = this.getCookieString();
                headers['Host'] = urlObj.host;

                const postData = new URLSearchParams({ data: dataStr }).toString();
                headers['Content-Length'] = Buffer.byteLength(postData);

                const options = {
                    hostname: urlObj.hostname,
                    port: 443,
                    path: urlObj.pathname + urlObj.search,
                    method: 'POST',
                    headers: headers,
                    timeout: this.timeout
                };

                console.log(`[Eleme] 请求接口: ${apiPath}`);
                console.log(`[Eleme] 请求数据: ${dataStr.substring(0, 200)}${dataStr.length > 200 ? '...' : ''}`);

                const req = https.request(options, (res) => {
                    let body = '';

                    res.on('data', (chunk) => {
                        body += chunk;
                    });

                    res.on('end', () => {
                        try {
                            if (!body || body.trim() === '') {
                                reject(new Error('服务器返回空响应'));
                                return;
                            }

                            const result = JSON.parse(body);

                            // 检查响应状态
                            if (result.ret && result.ret[0].includes('SUCCESS')) {
                                if (result.data && result.data.errCode === '10000') {
                                    console.log(`[Eleme] 接口调用成功: ${apiPath}`);
                                    resolve(result);
                                } else {
                                    const errorMsg = result.data?.errMessage || '未知错误';
                                    console.error(`[Eleme] 接口返回错误: ${errorMsg}`);
                                    reject(new Error(`API错误: ${errorMsg}`));
                                }
                            } else {
                                const errorMsg = result.ret ? result.ret[0] : '未知错误';
                                console.error(`[Eleme] 接口调用失败: ${errorMsg}`);
                                reject(new Error(`API失败: ${errorMsg}`));
                            }
                        } catch (error) {
                            console.error('[Eleme] 解析响应失败:', error);
                            reject(new Error('解析响应失败: ' + error.message));
                        }
                    });
                });

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('请求超时'));
                });

                req.on('error', (error) => {
                    console.error('[Eleme] 请求失败:', error);
                    reject(new Error('网络请求失败: ' + error.message));
                });

                req.write(postData);
                req.end();

            } catch (error) {
                console.error('[Eleme] 请求异常:', error);
                reject(error);
            }
        });
    }

    /**
     * 创建商品导出任务
     * @returns {Promise<number>} 任务ID
     */
    async createExportJob() {
        const apiPath = 'mtop.ele.newretail.itemJob.create';
        const data = {
            jobType: 'ITEM_EXPORT',
            jobKey: `store_${this.storeId}`,
            ext: JSON.stringify({
                sellerId: this.sellerId,
                storeId: this.storeId
            })
        };

        const result = await this._request(apiPath, data);
        const jobId = result.data.data;
        console.log(`[Eleme] 创建导出任务成功，jobId: ${jobId}`);
        return jobId;
    }

    /**
     * 获取任务列表
     * @param {number} page - 页码
     * @param {number} pageSize - 每页数量
     * @returns {Promise<Object>} 任务列表数据
     */
    async getJobList(page = 1, pageSize = 10) {
        const apiPath = 'mtop.ele.newretail.itemJob.getJobList';
        const data = {
            page: page,
            pageSize: pageSize,
            jobKey: JSON.stringify([`store_${this.storeId}`])
        };

        const result = await this._request(apiPath, data);
        return result.data.data;
    }

    /**
     * 轮询查询任务状态，直到完成或超时
     * @param {number} jobId - 任务ID
     * @param {number} maxWait - 最长等待时间（秒）
     * @param {number} pollInterval - 轮询间隔（秒）
     * @returns {Promise<Object|null>} 任务详情，如果超时返回null
     */
    async getJobStatus(jobId, maxWait = 300, pollInterval = 5, options = {}) {
        const startTime = Date.now();
        console.log(`[Eleme] 开始轮询任务状态，jobId: ${jobId}, 最长等待: ${maxWait}秒, 轮询间隔: ${pollInterval}秒`);
        
        let pollCount = 0;  // 轮询计数器

        while ((Date.now() - startTime) / 1000 < maxWait) {
            if (options.shouldCancel && options.shouldCancel()) {
                console.warn('[Eleme] 导出任务被取消（轮询前）');
                try { if (typeof options.log === 'function') options.log('warn', '饿了么导出任务被取消（轮询前）'); } catch(_) {}
                return null;
            }
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            try {
                pollCount++;
                console.log(`[Eleme] 第 ${pollCount} 次轮询 (已用时: ${elapsed}秒)...`);
                try { if (typeof options.log === 'function') options.log('info', `饿了么导出轮询第${pollCount}次（已用时${elapsed}秒）`); } catch(_) {}
                
                const jobList = await this.getJobList();

                // 查找指定的任务
                let foundJob = false;
                for (const job of jobList.jobDetailDTOList || []) {
                    if (job.jobId === jobId) {
                        foundJob = true;
                        const status = job.jobStatus;
                        const progress = job.executeProgress;

                        console.log(`[Eleme] 任务状态: ${job.jobStatusText} (status=${status}), 进度: ${progress}%`);

                        // 状态3表示成功
                        if (status === 3 && progress === 100) {
                            console.log(`[Eleme] ✅ 任务完成: ${job.downloadFileKey}`);
                            try { if (typeof options.log === 'function') options.log('info', '饿了么导出任务完成'); } catch(_) {}
                            return job;
                        } else if (status < 0) {
                            // 失败状态
                            console.error(`[Eleme] ❌ 任务失败 (status=${status}): ${job.resultMsg || '未知错误'}`);
                            try { if (typeof options.log === 'function') options.log('error', `饿了么导出任务失败 (status=${status}): ${job.resultMsg || '未知错误'}`); } catch(_) {}
                            return null;
                        }

                        break;
                    }
                }
                
                if (!foundJob) {
                    console.warn(`[Eleme] 未在任务列表中找到 jobId: ${jobId}`);
                }

            } catch (error) {
                console.error(`[Eleme] 轮询任务状态出错 (第${pollCount}次): ${error.message}`);
                
                // 如果是网络错误，继续轮询；如果是其他致命错误，抛出
                if (error.message && (error.message.includes('ECONNREFUSED') || 
                                      error.message.includes('ETIMEDOUT') ||
                                      error.message.includes('网络请求失败'))) {
                    console.log(`[Eleme] 网络错误，继续轮询...`);
                } else {
                    // 其他错误也继续轮询
                    console.warn(`[Eleme] 异常，继续轮询...`);
                }
            }

            // 等待后继续轮询（细分为100ms片段以响应取消）
            const waitMs = pollInterval * 1000;
            const step = 100;
            let waited = 0;
            while (waited < waitMs) {
                if (options.shouldCancel && options.shouldCancel()) {
                    console.warn('[Eleme] 导出任务被取消（轮询等待中）');
                    try { if (typeof options.log === 'function') options.log('warn', '饿了么导出任务被取消（轮询等待中）'); } catch(_) {}
                    return null;
                }
                const remain = Math.min(step, waitMs - waited);
                await this._sleep(remain);
                waited += remain;
            }
        }

        const totalTime = Math.round((Date.now() - startTime) / 1000);
        console.warn(`[Eleme] 任务超时（已等待${totalTime}秒，共轮询${pollCount}次），jobId: ${jobId}`);
        try { if (typeof options.log === 'function') options.log('error', `饿了么导出任务超时（已等待${totalTime}秒，共轮询${pollCount}次）`); } catch(_) {}
        return null;
    }

    /**
     * 获取下载链接
     * @param {string} downloadFileKey - 下载文件的key
     * @returns {Promise<string>} OSS下载URL
     */
    async getDownloadUrl(downloadFileKey) {
        const apiPath = 'mtop.ele.newretail.itemJob.downloadFile';
        const data = {
            key: downloadFileKey
        };

        const result = await this._request(apiPath, data);
        const url = result.data.data.url;
        console.log(`[Eleme] 获取下载链接成功`);
        return url;
    }

    /**
     * 下载文件
     * @param {string} url - 下载URL
     * @param {string} savePath - 保存路径
     * @returns {Promise<boolean>} 是否成功
     */
    async downloadFile(url, savePath, options = {}) {
        return new Promise((resolve, reject) => {
            console.log(`[Eleme] 开始下载文件: ${savePath}`);
            try { if (typeof options.log === 'function') options.log('info', `饿了么导出开始下载: ${savePath}`); } catch(_) {}

            // 确保目录存在
            const dir = path.dirname(savePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const urlObj = new URL(url);
            const protocol = urlObj.protocol === 'https:' ? https : http;

            const optionsReq = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                timeout: 60000 // 60秒超时
            };

            if (options.shouldCancel && options.shouldCancel()) {
                console.warn('[Eleme] 导出任务被取消（下载前）');
                try { if (typeof options.log === 'function') options.log('warn', '饿了么导出任务被取消（下载前）'); } catch(_) {}
                return reject(new Error('cancelled'));
            }

            const req = protocol.request(optionsReq, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`下载失败，状态码: ${res.statusCode}`));
                    return;
                }

                const fileStream = fs.createWriteStream(savePath);

                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    console.log(`[Eleme] 文件下载成功: ${savePath}`);
                    try { if (typeof options.log === 'function') options.log('info', `饿了么导出下载成功: ${savePath}`); } catch(_) {}
                    resolve(true);
                });

                fileStream.on('error', (error) => {
                    fs.unlink(savePath, () => {}); // 删除部分下载的文件
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

    /**
     * 完整的导出商品流程
     * @param {string} savePath - 保存路径
     * @returns {Promise<Object|null>} 任务信息，失败返回null
     */
    async exportProducts(savePath, options = {}) {
        try {
            // 1. 创建导出任务
            const jobId = await this.createExportJob();

            // 2. 等待任务完成
            if (options.shouldCancel && options.shouldCancel()) {
                console.warn('[Eleme] 导出任务被取消（创建任务后）');
                try { if (typeof options.log === 'function') options.log('warn', '饿了么导出任务被取消（创建任务后）'); } catch(_) {}
                return null;
            }
            const job = await this.getJobStatus(jobId, 300, 5, options);
            if (!job) {
                console.error('[Eleme] 导出任务失败或超时');
                try { if (typeof options.log === 'function') options.log('error', '饿了么导出任务失败或超时'); } catch(_) {}
                return null;
            }

            // 3. 获取下载链接
            const downloadUrl = await this.getDownloadUrl(job.downloadFileKey);

            // 4. 下载文件
            if (options.shouldCancel && options.shouldCancel()) {
                console.warn('[Eleme] 导出任务被取消（下载前）');
                try { if (typeof options.log === 'function') options.log('warn', '饿了么导出任务被取消（下载前）'); } catch(_) {}
                return null;
            }
            const success = await this.downloadFile(downloadUrl, savePath, options);
            if (!success) {
                console.error('[Eleme] 文件下载失败');
                try { if (typeof options.log === 'function') options.log('error', '饿了么导出文件下载失败'); } catch(_) {}
                return null;
            }

            console.log('[Eleme] 商品导出完成');
            try { if (typeof options.log === 'function') options.log('info', '饿了么商品导出完成'); } catch(_) {}
            // 标准化返回（保留 gmtCreate 等服务端时间，便于作为基线）
            return {
                jobId: job.jobId,
                downloadFileKey: job.downloadFileKey,
                gmtCreate: job.gmtCreate, // 例如 "2025-10-03 17:53:38"
                startTime: job.startTime,
                endTime: job.endTime
            };

        } catch (error) {
            console.error('[Eleme] 导出商品失败:', error);
            try { if (typeof options.log === 'function') options.log('error', `饿了么导出商品失败：${error.message}`); } catch(_) {}
            return null;
        }
    }

    /**
     * 查询操作记录（用于增量同步）
     * @param {number} startTime - 开始时间（秒级时间戳）
     * @param {number} endTime - 结束时间（秒级时间戳）
     * @param {number} pageNumber - 页码
     * @param {number} pageSize - 每页数量
     * @param {number} opType - 操作类型，0表示全部
     * @returns {Promise<Object>} 操作记录数据
     */
    async queryOperationLog(startTime, endTime, pageNumber = 1, pageSize = 100, opType = 0) {
        const apiPath = 'mtop.ele.newretail.item.oplog.queryOpLog';

        const reqData = {
            opType: opType,
            pageNumber: pageNumber,
            pageSize: pageSize,
            sellerId: this.sellerId,
            storeId: this.storeId,
            opTimeStart: startTime,
            opTimeEnd: endTime
        };

        // 外层包装
        const data = {
            req: JSON.stringify(reqData)
        };

        const result = await this._request(apiPath, data);
        return result.data;
    }

    /**
     * 获取商户信息（实例方法）
     * @returns {Promise<Object|null>} 商户信息
     */
    async getShopUserInfo() {
        try {
            const apiPath = 'mtop.ele.newretail.ebai.accountreadmtopservice.getshopuserinfo';
            const data = {};

            const result = await this._request(apiPath, data);
            const shopData = result.data.data;
            const shopInfo = shopData.shopInfo;
            const supplierInfo = shopData.supplierInfo;

            return {
                seller_id: String(shopInfo.sellerId),
                seller_name: supplierInfo.supplierName,
                store_id: String(shopInfo.storeId),
                store_name: shopData.merchantName,
                phone: shopData.loginUserPhone
            };
        } catch (error) {
            console.error('[Eleme] 获取商户信息失败:', error);
            return null;
        }
    }

    /**
     * 工具方法：延时
     * @private
     */
    _sleep(ms) {
        return new Promise((resolve, reject) => {
            try {
                setTimeout(resolve, ms);
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 从Cookie获取商户信息（静态方法）
     */
    static async getShopInfoFromCookies(cookieStr) {
        return new Promise((resolve) => {
            try {
                const client = new ElemeClient(cookieStr);
                const apiPath = 'mtop.ele.newretail.ebai.accountreadmtopservice.getshopuserinfo';
                const data = {};
                const dataStr = JSON.stringify(data);

                const url = client.buildUrl(apiPath, dataStr);
                const urlObj = new URL(url);
                const headers = client.getHeaders();

                // 手动设置Cookie header
                headers['Cookie'] = client.getCookieString();
                headers['Host'] = urlObj.host;

                const postData = new URLSearchParams({ data: dataStr }).toString();
                headers['Content-Length'] = Buffer.byteLength(postData);

                const options = {
                    hostname: urlObj.hostname,
                    port: 443,
                    path: urlObj.pathname + urlObj.search,
                    method: 'POST',
                    headers: headers
                };

                const req = https.request(options, (res) => {
                    let body = '';

                    res.on('data', (chunk) => {
                        body += chunk;
                    });

                    res.on('end', () => {
                        try {
                            if (!body || body.trim() === '') {
                                resolve({
                                    success: false,
                                    error: '服务器返回空响应'
                                });
                                return;
                            }

                            const result = JSON.parse(body);

                            // 检查响应
                            if (result.ret && result.ret[0] === 'SUCCESS::调用成功') {
                                const shopData = result.data.data;
                                const shopInfo = shopData.shopInfo;
                                const supplierInfo = shopData.supplierInfo;

                                resolve({
                                    success: true,
                                    seller_id: String(shopInfo.sellerId),
                                    seller_name: supplierInfo.supplierName,
                                    store_id: String(shopInfo.storeId),
                                    store_name: shopData.merchantName,
                                    phone: shopData.loginUserPhone
                                });
                            } else {
                                resolve({
                                    success: false,
                                    error: result.ret ? result.ret[0] : '获取门店信息失败'
                                });
                            }
                        } catch (error) {
                            console.error('解析响应失败:', error);
                            resolve({
                                success: false,
                                error: '解析响应失败: ' + error.message
                            });
                        }
                    });
                });

                req.on('error', (error) => {
                    console.error('请求失败:', error);
                    resolve({
                        success: false,
                        error: '网络请求失败: ' + error.message
                    });
                });

                req.write(postData);
                req.end();

            } catch (error) {
                console.error('获取饿了么门店信息失败:', error);
                resolve({
                    success: false,
                    error: error.message || '网络请求失败'
                });
            }
        });
    }
}

module.exports = ElemeClient;
