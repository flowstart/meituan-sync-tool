/**
 * 牵牛花（美团外卖） API 客户端
 * 完整实现：门店管理、商品查询、库存更新、导出功能
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

// 不再直接 require mtgsig.js，以避免其污染全局；改为在 VM 沙箱中按实例隔离加载

// 恢复Node.js原生对象与计时器，避免影响主进程事件循环
globalThis.Buffer = _Buffer;
globalThis.process = _process;
globalThis.global = _global;
globalThis.setTimeout = _setTimeout;
globalThis.setInterval = _setInterval;
globalThis.clearTimeout = _clearTimeout;
globalThis.clearInterval = _clearInterval;

class QianniuhuaClient {
    /**
     * 构造函数
     * @param {Object|string} config - 配置对象或Cookie字符串
     *   - 如果是字符串：仅用于静态方法（Cookie验证）
     *   - 如果是对象：{ cookies }
     */
    constructor(config) {
        if (typeof config === 'string') {
            // 兼容旧版：直接传入cookie字符串
            this.rawCookies = config;
            this.cookies = this.parseCookies(config);
        } else {
            // 新版：传入配置对象
            this.rawCookies = config.cookies;
            this.cookies = this.parseCookies(config.cookies);
        }
        
        this.apiDomain = 'https://qnh.meituan.com';
        this.timeout = 30000; // 30秒超时
        
        // 缓存
        this._storesCache = null;
        this._productsCache = {};

        // 为本实例创建独立的签名沙箱上下文
        try {
            const signerCodePath = path.join(__dirname, '../lib/mtgsig.js');
            const signerCode = fs.readFileSync(signerCodePath, 'utf8');
            // 为沙箱提供必要的内置对象与计时器
            this._signerContext = vm.createContext({
                console,
                setTimeout,
                setInterval,
                clearTimeout,
                clearInterval
            });
            // 注入 CommonJS 模块对象与 globalThis，供 mtgsig.js 使用
            this._signerContext.globalThis = this._signerContext;
            this._signerContext.module = { exports: {} };
            this._signerContext.exports = this._signerContext.module.exports;
            // 在加载前用本实例的 Cookie 覆盖源码中的硬编码 cookie，避免初始化阶段被缓存
            const runtimeCookie = (this.rawCookies || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const signerCodePatched = signerCode.replace(/cookie:\s*'[^']*'/, `cookie: '${runtimeCookie}'`);

            // 运行签名库代码
            vm.runInContext(signerCodePatched, this._signerContext, { filename: 'mtgsig.js' });
            // 绑定 getSign 引用（优先取 module.exports.getSign）
            this._getSign = (this._signerContext.module && this._signerContext.module.exports && this._signerContext.module.exports.getSign)
                ? this._signerContext.module.exports.getSign
                : this._signerContext.getSign;
        } catch (e) {
            console.error('[QNH] 初始化签名沙箱失败:', e);
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
     * 使用完整的mtgsig.js库（7900行，已破解算法）
     */
    generateMtgsig(url, body) {
        const urlObj = new URL(url);
        
        try {
            // 提取原始URL（不含query参数）
            const oriUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
            
            // 调用完整签名库
            // getSign(method, url, oriUrl, data)
            const method = 'POST';
            const dataStr = JSON.stringify(body);

            if (!this._signerContext || typeof this._getSign !== 'function') {
                throw new Error('签名环境未就绪');
            }

            // 为本实例沙箱注入当前 Cookies（隔离且并发安全）
            if (this._signerContext.document) {
                this._signerContext.document.cookie = this.getCookieString();
            } else {
                // 若未定义 document，则创建最小对象
                this._signerContext.document = { cookie: this.getCookieString() };
            }

            const mtgsig = this._getSign(method, url, oriUrl, dataStr);
            return mtgsig;
        } catch (error) {
            console.error('[QNH] 生成签名失败:', error);
            console.error('  错误详情:', error.message);
            // 回退到简化版（虽然可能不工作）
            const signStr = urlObj.pathname + JSON.stringify(body) + (this.cookies['token'] || '');
            const fallbackSign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex');
            console.warn('[QNH] 使用回退签名（可能无效）:', fallbackSign.substring(0, 32));
            return fallbackSign;
        }
    }

    /**
     * 获取请求头
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
     * @private
     */
    _request(method, url, data = null, needSign = true) {
        return new Promise((resolve, reject) => {
            try {
                const urlObj = new URL(url);
                
                let mtgsig = null;
                if (needSign && data && method === 'POST') {
                    // 使用完整URL生成签名
                    mtgsig = this.generateMtgsig(url, data);
                    console.log(`[QNH] 生成签名: ${mtgsig ? mtgsig.substring(0, 50) + '...' : 'null'}`);
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

                console.log(`[QNH] 请求接口: ${method} ${url}`);
                if (data) {
                    const dataStr = JSON.stringify(data);
                    console.log(`[QNH] 请求数据: ${dataStr.substring(0, 200)}${dataStr.length > 200 ? '...' : ''}`);
                }

                const req = https.request(options, (res) => {
                    let body = '';

                    res.on('data', (chunk) => {
                        body += chunk;
                    });

                    res.on('end', () => {
                        try {
                            const result = JSON.parse(body);
                            
                            // 检查响应状态
                            if (result.code === 0) {
                                console.log(`[QNH] 接口调用成功`);
                                resolve(result);
                            } else {
                                // 尝试从多个可能的字段中提取错误信息
                                const errorMsg = result.msg || result.message || result.error || result.errMsg || result.errorMessage;
                                
                                // 如果仍然没有错误信息，打印完整响应以便调试
                                if (!errorMsg) {
                                    console.error(`[QNH] 接口返回错误，但未找到错误信息。完整响应:`, JSON.stringify(result, null, 2));
                                    const errorDetail = `接口返回错误 (code: ${result.code})，但响应中未包含错误描述。请检查Cookie是否有效或联系技术支持`;
                                    console.error(`[QNH] ${errorDetail}`);
                                    reject(new Error(errorDetail));
                                } else {
                                    console.error(`[QNH] 接口返回错误 (code: ${result.code}): ${errorMsg}`);
                                    // 如果有额外的data字段，也打印出来
                                    if (result.data) {
                                        console.error(`[QNH] 错误详情:`, JSON.stringify(result.data, null, 2));
                                    }
                                    reject(new Error(`牵牛花API错误 (code: ${result.code}): ${errorMsg}`));
                                }
                            }
                        } catch (error) {
                            console.error('[QNH] 解析响应失败:', error);
                            console.error('[QNH] 原始响应内容:', body.substring(0, 500));
                            reject(new Error('解析响应失败: ' + error.message));
                        }
                    });
                });

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('请求超时'));
                });

                req.on('error', (error) => {
                    console.error('[QNH] 请求失败:', error);
                    reject(new Error('网络请求失败: ' + error.message));
                });

                if (postData) {
                    req.write(postData);
                }
                req.end();

            } catch (error) {
                console.error('[QNH] 请求异常:', error);
                reject(error);
            }
        });
    }

    /**
     * 获取所有门店信息（实例方法）
     * @param {boolean} forceRefresh - 是否强制刷新缓存
     * @returns {Promise<Object>} {门店名称: 门店ID}
     */
    async getStores(forceRefresh = false) {
        console.log(`[QNH] getStores called, forceRefresh=${forceRefresh}`);

        if (this._storesCache && !forceRefresh) {
            console.log('[QNH] 返回缓存的门店数据');
            return this._storesCache;
        }

        const url = 'https://qnh.meituan.com/goldengateway/poi/queryPoiTree';
        const params = new URLSearchParams({
            showType: '1',
            yodaReady: 'h5',
            csecplatform: '4',
            csecversion: '4.0.4'
        });

        const fullUrl = `${url}?${params.toString()}`;

        const data = {
            careErp: 'y',
            showType: 1,
            entityType: [3, 5, 6]
        };

        const result = await this._request('POST', fullUrl, data);

        const stores = {};
        const dataField = result.data;

        if (!dataField) {
            console.warn('[QNH] API返回的data字段为空');
            return stores;
        }

        if (!Array.isArray(dataField)) {
            console.error(`[QNH] data字段类型错误，期望list，实际: ${typeof dataField}`);
            throw new Error('获取门店列表失败：数据格式错误');
        }

        // 递归提取所有 itemType=3 的门店节点（兼容嵌套结构）
        const extractStores = (node) => {
            if (!node) return;
            
            // itemType=3 表示门店
            if (node.itemType === 3 && node.itemCode && node.itemName) {
                stores[node.itemCode] = node.itemName;
            }
            
            // 递归处理子节点
            if (Array.isArray(node.children)) {
                node.children.forEach(child => extractStores(child));
            }
        };

        // 从根节点开始递归提取
        dataField.forEach(rootNode => extractStores(rootNode));

        this._storesCache = stores;
        console.log(`[QNH] 获取到 ${Object.keys(stores).length} 个门店`);

        return stores;
    }

    /**
     * 获取门店商品列表
     * @param {string} storeId - 门店ID
     * @param {number} page - 页码
     * @param {number} pageSize - 每页数量
     * @param {Array<string>} upcList - 条形码列表（可选）
     * @returns {Promise<Object>} 商品列表数据
     */
    async getProducts(storeId, page = 1, pageSize = 20, upcList = null) {
        const url = 'https://qnh.meituan.com/qnh-gw3/api/product/store/page-query-spu';
        const params = new URLSearchParams({
            yodaReady: 'h5',
            csecplatform: '4',
            csecversion: '4.0.4'
        });

        const fullUrl = `${url}?${params.toString()}`;

        // 确保storeId是整数
        const storeIdNum = parseInt(storeId);
        console.log(`[QNH] 分页查询: storeId=${storeId} (原始) -> ${storeIdNum} (转换), 类型=${typeof storeIdNum}, page=${page}, pageSize=${pageSize}`);

        const data = {
            onlineStatus: 0,
            backendCategoryIdList: [],
            frontCategoryIdList: [],
            tabType: 1,
            spuIdList: [],
            skuIdList: [],
            erpCodeList: [],
            upcList: upcList || [],
            erpUpcList: [],
            externalCodeList: [],
            childSkuIdList: [],
            poiId: null,
            saleStatusList: [],
            page: page,
            asyncQueryPromotion: true,
            storeIdList: [storeIdNum],
            activityChannelId: 0,
            priceSource: 0,
            mtAllowSaleStatus: 0,
            status: 1,
            pageSize: pageSize,
            _t: Date.now(),
            channelCategory: {
                channelId: 100,
                categoryIds: [],
                categoryProperty: {}
            },
            saleStockFlag: 0,
            customCodeList: [],
            channelStockStatusList: []
        };

        const result = await this._request('POST', fullUrl, data);
        
        if (upcList) {
            console.log(`[QNH] 获取门店 ${storeId} 的商品，条形码过滤: ${upcList.join(',')}`);
        } else {
            console.log(`[QNH] 获取门店 ${storeId} 的商品，页码: ${page}`);
        }

        return result.data || {};
    }

    /**
     * 获取商品条形码和skuId的映射（全量）
     * @param {string} storeId - 门店ID
     * @param {boolean} useExport - 是否使用导出接口（推荐）
     * @returns {Promise<Object>} {条形码: skuId}
     */
    async getProductsMapping(storeId, useExport = true) {
        // 检查缓存
        if (this._productsCache[storeId]) {
            return this._productsCache[storeId];
        }

        if (useExport) {
            // 使用导出接口
            console.log('[QNH] 使用导出接口获取商品映射...');
            const exportPath = `data/qnh_products_store_${storeId}_temp.xlsx`;

            const result = await this.exportProducts(storeId, exportPath);
            if (result) {
                // 需要解析Excel - 这部分在parser模块实现
                // 这里先返回空对象，等parser完成后再集成
                console.warn('[QNH] Excel解析功能待实现，回退到分页查询');
            }
        }

        // 回退到分页查询
        console.log('[QNH] 使用分页接口获取商品映射...');
        const mapping = {};
        let page = 1;
        const pageSize = 50; // API限制

        while (true) {
            const productsData = await this.getProducts(storeId, page, pageSize);
            const productList = productsData.list || [];

            if (productList.length === 0) {
                break;
            }

            for (const product of productList) {
                for (const sku of product.storeSkuList || []) {
                    const upcList = sku.upcList || [];
                    if (upcList.length > 0) {
                        const barcode = upcList[0]; // 使用第一个条形码
                        mapping[barcode] = String(sku.skuId);
                    }
                }
            }

            // 检查是否还有更多页
            if (productList.length < pageSize) {
                break;
            }

            page++;
        }

        this._productsCache[storeId] = mapping;
        console.log(`[QNH] 门店 ${storeId} 共获取 ${Object.keys(mapping).length} 个商品映射（通过分页）`);

        return mapping;
    }

    /**
     * 根据条形码列表批量查询SKU ID（用于增量同步）
     * @param {string} storeId - 门店ID
     * @param {Array<string>} barcodes - 条形码列表
     * @returns {Promise<Object>} {条形码: SKU ID}，找不到则值为null
     */
    async getSkuIdsByBarcodes(storeId, barcodes) {
        if (!barcodes || barcodes.length === 0) {
            return {};
        }

        console.log(`[QNH] 批量查询 ${barcodes.length} 个条形码对应的SKU ID`);

        // API每次最多查询50个条形码
        const batchSize = 50;
        const result = {};

        for (let i = 0; i < barcodes.length; i += batchSize) {
            const batchBarcodes = barcodes.slice(i, i + batchSize);

            // 使用条形码过滤查询
            const productsData = await this.getProducts(storeId, 1, 50, batchBarcodes);
            const productList = productsData.list || [];

            // 解析返回的商品
            const foundBarcodes = new Set();
            for (const product of productList) {
                for (const sku of product.storeSkuList || []) {
                    const upcList = sku.upcList || [];
                    const skuId = String(sku.skuId);

                    // 将该SKU的所有条形码都映射到SKU ID
                    for (const barcode of upcList) {
                        if (batchBarcodes.includes(barcode)) {
                            result[barcode] = skuId;
                            foundBarcodes.add(barcode);
                        }
                    }
                }
            }

            // 未找到的条形码设为null
            for (const barcode of batchBarcodes) {
                if (!foundBarcodes.has(barcode)) {
                    result[barcode] = null;
                }
            }
        }

        const foundCount = Object.values(result).filter(v => v !== null).length;
        console.log(`[QNH] 查询完成: 找到 ${foundCount}/${barcodes.length} 个商品`);

        return result;
    }

    /**
     * 根据条形码批量查询商品库存（用于双向同步）
     * @param {string} storeId - 门店ID
     * @param {Array<string>} barcodes - 条形码列表
     * @returns {Promise<Object>} {条形码: {skuId, stock}}，找不到则值为null
     */
    async getStockByBarcodes(storeId, barcodes) {
        if (!barcodes || barcodes.length === 0) {
            return {};
        }

        console.log(`[QNH] 批量查询 ${barcodes.length} 个条形码的库存`);

        const batchSize = 50;
        const result = {};

        for (let i = 0; i < barcodes.length; i += batchSize) {
            const batchBarcodes = barcodes.slice(i, i + batchSize);
            const productsData = await this.getProducts(storeId, 1, 50, batchBarcodes);
            const productList = productsData.list || [];

            const foundBarcodes = new Set();
            for (const product of productList) {
                for (const sku of product.storeSkuList || []) {
                    const upcList = sku.upcList || [];
                    const skuId = String(sku.skuId);
                    const stock = parseInt(sku.stock) || 0;

                    for (const barcode of upcList) {
                        if (batchBarcodes.includes(barcode)) {
                            result[barcode] = {
                                skuId: skuId,
                                stock: stock
                            };
                            foundBarcodes.add(barcode);
                        }
                    }
                }
            }

            // 未找到的条形码设为null
            for (const barcode of batchBarcodes) {
                if (!foundBarcodes.has(barcode)) {
                    result[barcode] = null;
                }
            }
        }

        const foundCount = Object.values(result).filter(v => v !== null).length;
        console.log(`[QNH] 库存查询完成: 找到 ${foundCount}/${barcodes.length} 个商品`);

        return result;
    }

    /**
     * 导出门店商品列表到Excel（支持重试）
     * @param {string} storeId - 门店ID
     * @param {string} exportPath - 导出文件路径（可选）
     * @param {number} maxRetries - 最大重试次数（默认3次）
     * @returns {Promise<string|null>} 导出文件路径，失败返回null
     */
    async exportProducts(storeId, exportPath = null, maxRetries = 2, options = {}) {
        if (!exportPath) {
            exportPath = `data/qnh_products_store_${storeId}.xlsx`;
        }

        // 重试逻辑
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const logFn = (level, message) => {
                try {
                    if (options && typeof options.log === 'function') {
                        options.log(level, message);
                    }
                } catch (_) {}
            };

            console.log(`[QNH] 导出商品 - 第${attempt}次尝试（共${maxRetries}次）`);
            logFn('info', `牵牛花导出：第${attempt}次尝试（共${maxRetries}次）`);
            
            if (options.shouldCancel && options.shouldCancel()) {
                console.warn('[QNH] 导出任务被取消（开始前）');
                logFn('warn', '牵牛花导出任务被取消（开始前）');
                return null;
            }

            const result = await this._exportProductsOnce(storeId, exportPath, options);
            
            if (result) {
                // 成功
                console.log(`[QNH] 导出成功（第${attempt}次尝试）`);
                logFn('info', `牵牛花导出成功（第${attempt}次尝试）`);
                return result;
            }
            
            // 失败，判断是否继续重试
            if (attempt < maxRetries) {
                console.warn(`[QNH] 导出失败，将重新尝试（${attempt}/${maxRetries}）`);
                logFn('warn', `牵牛花导出失败，将重新尝试（${attempt}/${maxRetries}）`);
                // 5秒等待期间响应取消
                for (let t = 0; t < 50; t++) {
                    if (options.shouldCancel && options.shouldCancel()) {
                        console.warn('[QNH] 导出任务被取消（等待重试期间）');
                        logFn('warn', '牵牛花导出任务被取消（等待重试期间）');
                        return null;
                    }
                    await this._sleep(100);
                }
            } else {
                console.error(`[QNH] 导出失败，已达最大重试次数（${maxRetries}次）`);
                logFn('error', `牵牛花导出失败，已达最大重试次数（${maxRetries}次）`);
            }
        }

        return null;
    }

    /**
     * 单次导出商品（内部方法）
     * @private
     */
    async _exportProductsOnce(storeId, exportPath, options = {}) {
        try {
            const logFn = (level, message) => {
                try {
                    if (options && typeof options.log === 'function') {
                        options.log(level, message);
                    }
                } catch (_) {}
            };
            // 1. 创建导出任务
            const url = 'https://qnh.meituan.com/qnh-gw3/api/product/store/export';
            const params = new URLSearchParams({
                yodaReady: 'h5',
                csecplatform: '4',
                csecversion: '4.0.4'
            });

            const fullUrl = `${url}?${params.toString()}`;

            // 确保storeId是整数
            const storeIdNum = parseInt(storeId);
            console.log(`[QNH] 创建导出任务: storeId=${storeId} (原始), ${storeIdNum} (转换后), 类型=${typeof storeIdNum}`);
            
            if (isNaN(storeIdNum)) {
                const errMsg = `门店ID必须是数字，当前值: ${storeId} (类型: ${typeof storeId})。请检查数据库中qnh_store_id字段，应该保存门店ID(如"1163301")，而不是门店名称(如"铁骑送酒（大洋店）")`;
                logFn('error', errMsg);
                throw new Error(errMsg);
            }
            
            const data = {
                onlineStatus: 0,
                backendCategoryIdList: [],
                frontCategoryIdList: [],
                tabType: 1,
                spuIdList: [],
                skuIdList: [],
                erpCodeList: [],
                upcList: [],
                erpUpcList: [],
                externalCodeList: [],
                childSkuIdList: [],
                poiId: null,
                saleStatusList: [],
                page: 1,
                asyncQueryPromotion: true,
                storeIdList: [storeIdNum],
                activityChannelId: 0,
                priceSource: 0,
                mtAllowSaleStatus: 0,
                status: 1,
                pageSize: 50,
                _t: Date.now(),
                channelCategory: {
                    channelId: 100,
                    categoryIds: [],
                    categoryProperty: {}
                },
                saleStockFlag: 0,
                exportType: 1,
                // 使用完整的dataList字段列表（与网页版一致）
                dataList: [
                    'storeId', 'storeName', 'spuId', 'spuName', 'skuId', 'skuSaleType',
                    'upc', 'onlineSpec', 'mtSaleAttr', 'elmSaleAttr', 'onlineStock',
                    'CHANNEL_SELL_OUT_FLAG', 'frontCategoryName', 'mtAfterSaleService',
                    'saleStatus', 'hasPicture', 'onlineWeight', 'weightUnit',
                    'mtFirstCategoryName', 'mtSecondCategoryName', 'mtThirdCategoryName',
                    'elemFirstCategoryName', 'elemSecondCategoryName', 'elemThirdCategoryName',
                    'minOrderCount', 'productionDate', 'expirationDate', 'expirationStatus',
                    'elemChannelSellPrice', 'mtChannelSellPrice', 'backendCategory',
                    'abnormalDesc', 'abnormalHandleMsg', 'childSku', 'purchasePrice',
                    'customSkuId', 'mtCustomSpuId', 'externalCode', 'basicUnit',
                    'sellPoint', 'isSpecialty', 'availableTime', 'description',
                    'properties', 'brand', 'monthSaleAmount', 'entityStock',
                    'mtAuditStatus', 'mtNormAuditStatus', 'mtAuditComment',
                    'cartonMeasure', 'customCode', 'spuProductLabel', 'skuProductLabel'
                ],
                customCodeList: [],
                channelStockStatusList: []
            };

            const result = await this._request('POST', fullUrl, data);
            console.log(`[QNH] 创建导出任务成功，门店: ${storeId}`);

            // 2. 获取任务ID
            let taskId = result.data;
            if (typeof taskId === 'object') {
                taskId = taskId.taskId;
            }

            if (!taskId) {
                console.error(`[QNH] 未获取到任务ID，响应: ${JSON.stringify(result)}`);
                return null;
            }

            console.log(`[QNH] 任务ID: ${taskId}，开始轮询任务状态...`);
            logFn('info', `牵牛花导出任务创建成功，任务ID: ${taskId}，开始轮询状态，(如果5分钟没有成功将触发超时处理机制）`);

            // 3. 轮询任务状态
            const pollInterval = 10; // 秒
            const maxWaitTime = 300; // 最多等待5分钟
            let elapsedTime = 0;

            while (elapsedTime < maxWaitTime) {
                // 可中断的sleep
                for (let t = 0; t < pollInterval * 10; t++) {
                    if (options.shouldCancel && options.shouldCancel()) {
                        console.warn('[QNH] 导出任务被取消（轮询等待中）');
                        logFn('warn', '牵牛花导出任务被取消（轮询等待中）');
                        return null;
                    }
                    await this._sleep(100);
                }
                elapsedTime += pollInterval;

                // 查询任务状态
                if (options.shouldCancel && options.shouldCancel()) {
                    console.warn('[QNH] 导出任务被取消（查询前）');
                    logFn('warn', '牵牛花导出任务被取消（查询前）');
                    return null;
                }
                const taskStatus = await this._queryExportTaskStatus(taskId);
                if (!taskStatus) {
                    console.warn(`[QNH] 第${elapsedTime / pollInterval}次查询未找到任务，继续轮询...`);
                    continue;
                }

                const status = taskStatus.executingState;
                console.log(`[QNH] 第${elapsedTime / pollInterval}次查询: 任务状态=${status}，已等待${elapsedTime}秒`);

                if (status === '已完成') {
                    // handleResult 是JSON字符串，需要解析
                    const handleResultStr = taskStatus.handleResult || '{}';
                    let downloadUrl;
                    try {
                        const handleResult = JSON.parse(handleResultStr);
                        downloadUrl = handleResult.fileUrl;
                    } catch (e) {
                        console.error(`[QNH] 解析handleResult失败: ${handleResultStr}`);
                        logFn('error', `牵牛花导出任务解析handleResult失败: ${handleResultStr}`);
                        return null;
                    }

                    if (!downloadUrl) {
                        console.error(`[QNH] 未获取到下载URL，handleResult: ${handleResultStr}`);
                        logFn('error', `牵牛花导出任务未获取到下载URL，handleResult: ${handleResultStr}`);
                        return null;
                    }

                    console.log(`[QNH] 任务完成，开始下载文件...`);
                    console.log(`[QNH] 下载URL: ${downloadUrl}`);

                    // 4. 下载文件
                    if (options.shouldCancel && options.shouldCancel()) {
                        console.warn('[QNH] 导出任务被取消（下载前）');
                        logFn('warn', '牵牛花导出任务被取消（下载前）');
                        return null;
                    }
                    await this._downloadExcel(downloadUrl, exportPath);
                    console.log(`[QNH] 文件下载成功: ${exportPath}`);
                    logFn('info', `牵牛花导出Excel下载成功: ${exportPath}`);

                    return exportPath;

                } else if (status === '处理失败' || status === '执行失败' || status === '已取消') {
                    const errorMsg = taskStatus.handleResult || '未知错误';
                    console.error(`[QNH] 导出任务${status}: ${errorMsg}`);
                    console.error(`[QNH] 任务ID ${taskId} 失败，停止轮询`);
                    logFn('error', `牵牛花导出任务${status}：${errorMsg}`);
                    return null; // 立即返回失败，不再继续轮询
                }

                // 其他状态（处理中等）继续轮询
            }

            console.error(`[QNH] 任务超时（${maxWaitTime}秒）`);
            logFn('error', `牵牛花导出任务超时（${maxWaitTime}秒）`);
            return null;

        } catch (error) {
            console.error('[QNH] 导出商品失败:', error);
            try {
                if (options && typeof options.log === 'function') {
                    options.log('error', `牵牛花导出商品失败：${error.message}`);
                }
            } catch (_) {}
            return null;
        }
    }

    /**
     * 查询导出任务状态
     * @private
     */
    async _queryExportTaskStatus(taskId = null) {
        const url = 'https://qnh.meituan.com/api/v1/task/queryTasks';
        const params = new URLSearchParams({
            yodaReady: 'h5',
            csecplatform: '4',
            csecversion: '4.0.4'
        });

        const fullUrl = `${url}?${params.toString()}`;

        // 查询当天的任务
        const endDate = new Date();
        // const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        const startDate = endDate;

        const formatDate = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}.${month}.${day}`;
        };

        const formatDateCompact = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}${month}${day}`;
        };

        const data = {
            queryType: 'STORE_SPU_EXPORT_V2',
            date: [formatDate(startDate), formatDate(endDate)],
            pageSize: 20,
            _t: Date.now(),
            startTime: formatDateCompact(startDate),
            endTime: formatDateCompact(endDate),
            page: 1,
            taskMode: ''
        };

        try {
            const result = await this._request('POST', fullUrl, data);

            // 数据结构: data.list 包含任务列表
            const dataField = result.data || {};
            const taskList = dataField.list || [];

            if (taskList.length === 0) {
                console.warn(`[QNH] 未查询到任务`);
                return null;
            }

            console.log(`[QNH] 查询到 ${taskList.length} 个任务`);

            // 如果指定了taskId，查找对应的任务
            if (taskId) {
                for (const task of taskList) {
                    if (String(task.taskId) === String(taskId)) {
                        console.log(`[QNH] 找到任务ID ${taskId}: 状态=${task.executingState}`);
                        return task;
                    }
                }
                console.warn(`[QNH] 未找到任务ID: ${taskId}`);
                return null;
            }

            // 否则返回最新的任务
            return taskList[0];

        } catch (error) {
            console.error('[QNH] 查询任务状态失败:', error);
            return null;
        }
    }

    /**
     * 下载Excel文件
     * @private
     */
    async _downloadExcel(url, savePath) {
        return new Promise((resolve, reject) => {
            console.log(`[QNH] 开始下载Excel: ${savePath}`);

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
                timeout: 60000 // 60秒超时
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
                    console.log(`[QNH] Excel下载成功: ${savePath}`);
                    resolve();
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
     * 更新商品库存
     * @param {string} storeId - 门店ID
     * @param {string} skuId - 商品SKU ID
     * @param {number} newQuantity - 新库存数量
     * @param {string} comment - 备注
     * @returns {Promise<boolean>} 是否成功
     */
    async updateStock(storeId, skuId, newQuantity, comment = '库存同步') {
        const url = 'https://qnh.meituan.com/api/v1/storeempower/operate/batchContainer/stockadjustment?yodaReady=h5&csecplatform=4&csecversion=4.0.4';

        const data = {
            comment: `WEB-${comment}`,
            entityId: storeId,
            entityType: 3,
            skuList: [
                {
                    skuId: skuId,
                    comment: '',
                    enableExpiredCheck: false,
                    customizeStockFlag: 1,
                    batchContainerInfoList: [
                        {
                            newQuantity: newQuantity,
                            oldQuantity: 0, // 这个参数似乎不影响实际结果
                            originLocationType: 15,
                            originLocationId: '',
                            originLocationCode: ''
                        }
                    ]
                }
            ]
        };

        try {
            await this._request('POST', url, data);
            console.log(`[QNH] 更新库存成功: 门店=${storeId}, SKU=${skuId}, 新库存=${newQuantity}`);
            return true;
        } catch (error) {
            console.error(`[QNH] 更新库存失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 批量更新多个门店的商品库存（旧版：顺序执行，效率低）
     * @deprecated 建议使用 batchUpdateStockOptimized
     * @param {Array<string>} storeIds - 门店ID列表
     * @param {string} barcode - 商品条形码
     * @param {number} newQuantity - 新库存数量
     * @returns {Promise<Object>} {门店ID: 是否成功}
     */
    async batchUpdateStock(storeIds, barcode, newQuantity) {
        const results = {};

        for (const storeId of storeIds) {
            // 获取商品映射
            const mapping = await this.getProductsMapping(storeId);

            // 查找SKU ID
            const skuId = mapping[barcode];
            if (!skuId) {
                console.warn(`[QNH] 门店 ${storeId} 未找到条形码 ${barcode} 对应的商品`);
                results[storeId] = false;
                continue;
            }

            // 更新库存
            const success = await this.updateStock(storeId, skuId, newQuantity);
            results[storeId] = success;
        }

        const successCount = Object.values(results).filter(v => v).length;
        console.log(`[QNH] 批量更新完成: 成功 ${successCount}/${storeIds.length} 个门店`);

        return results;
    }

    /**
     * 批量更新多个SKU的库存（高效版：一次请求更新多个SKU）
     * 参考Python代码：qianniuhualib/库存修改/根据条形码更改库存.py
     * 
     * @param {string} storeId - 门店ID
     * @param {Array<Object>} skuUpdates - SKU更新列表
     *   格式: [{ skuId: 'xxx', newQuantity: 100, comment: '备注' }, ...]
     * @param {string} comment - 整体备注
     * @returns {Promise<boolean>} 是否成功
     */
    async batchUpdateMultipleSkus(storeId, skuUpdates, comment = '批量库存同步') {
        const url = 'https://qnh.meituan.com/api/v1/storeempower/operate/batchContainer/stockadjustment?yodaReady=h5&csecplatform=4&csecversion=4.0.4';

        // 构建skuList数组（关键：一次请求更新多个SKU）
        const skuList = skuUpdates.map(update => ({
            skuId: update.skuId,
            comment: update.comment || '',
            enableExpiredCheck: false,
            customizeStockFlag: 1,
            batchContainerInfoList: [
                {
                    newQuantity: update.newQuantity,
                    oldQuantity: 0,
                    originLocationType: 15,
                    originLocationId: '',
                    originLocationCode: ''
                }
            ]
        }));

        const data = {
            comment: `WEB-${comment}`,
            entityId: storeId,
            entityType: 3,
            skuList: skuList  // 关键：批量更新多个SKU
        };

        try {
            await this._request('POST', url, data);
            console.log(`[QNH] 批量更新成功: 门店=${storeId}, SKU数量=${skuList.length}`);
            return true;
        } catch (error) {
            // 不吞错：把具体 API 错误向上抛出，方便同步引擎记录到失败原因/失败日志
            console.error(`[QNH] 批量更新失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 有 BUG，暂时不要用，里面调用this.getProductsMapping又会多余触发一次商品导出任务。
     * 批量更新多个门店的多个商品库存（高效版：支持分组批量）
     * 优化点：
     * 1. 一次请求更新多个SKU（减少HTTP请求次数）
     * 2. 支持分组批量（比如10个SKU一组）
     * 3. 并发处理多个门店
     * 
     * @param {Array<Object>} updates - 更新列表
     *   格式: [{ storeId: 'xxx', barcode: 'xxx', newQuantity: 100 }, ...]
     * @param {number} batchSize - 每批处理的SKU数量（默认10）
     * @param {string} comment - 备注
     * @returns {Promise<Object>} 更新结果统计
     */
    async batchUpdateStockOptimized(updates, batchSize = 10, comment = '批量库存同步') {
        console.log(`[QNH] 开始高效批量更新，共 ${updates.length} 个任务，分组大小: ${batchSize}`);

        // 按门店分组
        const updatesByStore = {};
        for (const update of updates) {
            if (!updatesByStore[update.storeId]) {
                updatesByStore[update.storeId] = [];
            }
            updatesByStore[update.storeId].push({
                barcode: update.barcode,
                newQuantity: update.newQuantity,
                comment: update.comment
            });
        }

        const results = {
            total: updates.length,
            success: 0,
            failed: 0,
            details: {}
        };

        // 并发处理所有门店
        const storePromises = Object.entries(updatesByStore).map(async ([storeId, storeUpdates]) => {
            try {
                // 获取该门店的商品映射
                const mapping = await this.getProductsMapping(storeId);

                // 准备SKU更新数据（带条形码查询）
                const skuUpdatesWithIds = [];
                for (const update of storeUpdates) {
                    const skuId = mapping[update.barcode];
                    if (skuId) {
                        skuUpdatesWithIds.push({
                            skuId: skuId,
                            newQuantity: update.newQuantity,
                            comment: update.comment || ''
                        });
                    } else {
                        console.warn(`[QNH] 门店 ${storeId} 未找到条形码 ${update.barcode}`);
                        results.failed++;
                    }
                }

                // 按batchSize分组（10个SKU一组）
                const batches = [];
                for (let i = 0; i < skuUpdatesWithIds.length; i += batchSize) {
                    batches.push(skuUpdatesWithIds.slice(i, i + batchSize));
                }

                console.log(`[QNH] 门店 ${storeId}: ${skuUpdatesWithIds.length} 个SKU，分为 ${batches.length} 批`);

                // 批量更新（每批10个SKU）
                let storeSuccessCount = 0;
                for (const batch of batches) {
                    const success = await this.batchUpdateMultipleSkus(storeId, batch, comment);
                    if (success) {
                        storeSuccessCount += batch.length;
                    } else {
                        results.failed += batch.length;
                    }

                    // 避免请求过快，稍微延迟
                    await this._sleep(500);
                }

                results.success += storeSuccessCount;
                results.details[storeId] = {
                    total: skuUpdatesWithIds.length,
                    success: storeSuccessCount,
                    failed: skuUpdatesWithIds.length - storeSuccessCount
                };

            } catch (error) {
                console.error(`[QNH] 门店 ${storeId} 处理失败:`, error);
                results.failed += storeUpdates.length;
                results.details[storeId] = {
                    total: storeUpdates.length,
                    success: 0,
                    failed: storeUpdates.length,
                    error: error.message
                };
            }
        });

        // 等待所有门店处理完成
        await Promise.all(storePromises);

        console.log(`[QNH] 批量更新完成: 总计=${results.total}, 成功=${results.success}, 失败=${results.failed}`);

        return results;
    }

    /**
     * 简化版批量更新（单门店多个商品）
     * 适用场景：同一门店更新多个商品
     * 
     * @param {string} storeId - 门店ID
     * @param {Array<Object>} barcodeQuantities - 条形码和数量列表
     *   格式: [{ barcode: 'xxx', quantity: 100 }, ...]
     * @param {number} batchSize - 每批处理的SKU数量（默认10）
     * @returns {Promise<Object>} 更新结果
     */
    async updateStockByBarcodes(storeId, barcodeQuantities, batchSize = 10) {
        console.log(`[QNH] 更新门店 ${storeId} 的 ${barcodeQuantities.length} 个商品`);

        // 获取商品映射
        const mapping = await this.getProductsMapping(storeId);

        // 准备SKU更新数据
        const skuUpdates = [];
        const notFound = [];

        for (const item of barcodeQuantities) {
            const skuId = mapping[item.barcode];
            if (skuId) {
                skuUpdates.push({
                    skuId: skuId,
                    newQuantity: item.quantity,
                    comment: item.comment || ''
                });
            } else {
                notFound.push(item.barcode);
            }
        }

        if (notFound.length > 0) {
            console.warn(`[QNH] 以下条形码未找到: ${notFound.join(', ')}`);
        }

        // 分批更新（10个SKU一组）
        const batches = [];
        for (let i = 0; i < skuUpdates.length; i += batchSize) {
            batches.push(skuUpdates.slice(i, i + batchSize));
        }

        console.log(`[QNH] 分为 ${batches.length} 批，每批最多 ${batchSize} 个SKU`);

        let successCount = 0;
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            console.log(`[QNH] 处理第 ${i + 1}/${batches.length} 批，${batch.length} 个SKU`);

            const success = await this.batchUpdateMultipleSkus(storeId, batch);
            if (success) {
                successCount += batch.length;
            }

            // 避免请求过快
            if (i < batches.length - 1) {
                await this._sleep(500);
            }
        }

        return {
            total: barcodeQuantities.length,
            found: skuUpdates.length,
            notFound: notFound.length,
            success: successCount,
            failed: skuUpdates.length - successCount,
            notFoundBarcodes: notFound
        };
    }

    /**
     * 工具方法：延时
     * @private
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 获取所有门店信息（静态方法）
     * 用于Cookie验证
     */
    static async getStores(cookieStr) {
        try {
            const client = new QianniuhuaClient(cookieStr);

            const url = 'https://qnh.meituan.com/goldengateway/poi/queryPoiTree';
            const params = new URLSearchParams({
                showType: '1',
                yodaReady: 'h5',
                csecplatform: '4',
                csecversion: '4.0.4'
            });

            const fullUrl = `${url}?${params.toString()}`;

            const data = {
                careErp: 'y',
                showType: 1,
                entityType: [3, 5, 6]
            };

            const result = await client._request('POST', fullUrl, data);

            // 解析门店列表（递归提取所有 itemType=3 的门店节点）
            const stores = {};
            const dataField = result.data;

            if (Array.isArray(dataField)) {
                const extractStores = (node) => {
                    if (!node) return;
                    
                    // itemType=3 表示门店
                    if (node.itemType === 3 && node.itemCode && node.itemName) {
                        stores[node.itemCode] = node.itemName;
                    }
                    
                    // 递归处理子节点
                    if (Array.isArray(node.children)) {
                        node.children.forEach(child => extractStores(child));
                    }
                };
                
                dataField.forEach(rootNode => extractStores(rootNode));
            }

            if (Object.keys(stores).length > 0) {
                return {
                    success: true,
                    stores: stores,
                    storeList: Object.entries(stores).map(([id, name]) => ({
                        id: id,
                        name: name
                    }))
                };
            } else {
                return {
                    success: false,
                    error: 'Cookie无效或无门店权限'
                };
            }
        } catch (error) {
            console.error('获取牵牛花门店列表失败:', error);
            return {
                success: false,
                error: error.message || '网络请求失败'
            };
        }
    }

    // ========================================
    // 盘点单相关 API
    // ========================================

    /**
     * 查询盘点单列表
     * @param {string|number} poiId - 门店ID
     * @param {number} startTime - 开始时间戳（毫秒）- 创建时间范围
     * @param {number} endTime - 结束时间戳（毫秒）- 创建时间范围
     * @param {number} page - 页码
     * @param {number} pageSize - 每页数量
     * @param {number} status - 盘点单状态（5=已完成）
     * @returns {Promise<Object>} 盘点单列表
     */
    async getInventoryTaskList(poiId, startTime, endTime, page = 1, pageSize = 10, status = 5) {
        const url = 'https://qnh.meituan.com/api/v1/stockTask/tasklist?yodaReady=h5&csecplatform=4&csecversion=4.0.4';
        const poiIdNum = typeof poiId === 'string' ? parseInt(poiId) : poiId;
        
        const data = {
            poiIdList: [poiIdNum],
            status: status,  // 只查已完成的盘点单
            page: page,
            pageSize: pageSize,
            sorter: {},
            startTime: startTime,
            endTime: endTime
        };

        const result = await this._request('POST', url, data);
        return result;
    }

    /**
     * 获取所有盘点单（自动分页）
     * @param {string|number} poiId - 门店ID
     * @param {number} startTime - 开始时间戳（毫秒）
     * @param {number} endTime - 结束时间戳（毫秒）
     * @returns {Promise<Array>} 所有盘点单
     */
    async getAllInventoryTasks(poiId, startTime, endTime) {
        const allTasks = [];
        let page = 1;
        const pageSize = 50;

        while (true) {
            const result = await this.getInventoryTaskList(poiId, startTime, endTime, page, pageSize);
            const tasks = result.data?.list || [];
            allTasks.push(...tasks);

            const total = result.data?.total || 0;
            if (allTasks.length >= total || tasks.length === 0) {
                break;
            }
            page++;
        }

        console.log(`[QNH] 盘点单查询完成: 共 ${allTasks.length} 条`);
        return allTasks;
    }

    /**
     * 查询盘点单商品明细
     * @param {string|number} poiId - 门店ID
     * @param {string} taskNo - 盘点单号
     * @param {string|number} entityType - 实体类型（从盘点单列表返回获取）
     * @param {number} page - 页码
     * @param {number} pageSize - 每页数量
     * @returns {Promise<Object>} 商品明细
     */
    async getInventoryTaskGoods(poiId, taskNo, entityType = 3, page = 1, pageSize = 50) {
        const url = 'https://qnh.meituan.com/api/v1/stockTask/taskGoodsList?yodaReady=h5&csecplatform=4&csecversion=4.0.4';
        const poiIdStr = String(poiId);
        
        const data = {
            page: page,
            pageSize: pageSize,
            sorter: {},
            poiId: poiIdStr,
            taskNo: taskNo,
            entityId: poiIdStr,
            entityType: String(entityType),  // 使用动态 entityType
            poiName: ''
        };

        const result = await this._request('POST', url, data);
        return result;
    }

    /**
     * 获取盘点单的所有商品明细（自动分页）
     * @param {string|number} poiId - 门店ID
     * @param {string} taskNo - 盘点单号
     * @param {string|number} entityType - 实体类型（从盘点单列表返回获取）
     * @returns {Promise<Array>} 所有商品明细
     */
    async getAllInventoryTaskGoods(poiId, taskNo, entityType = 3) {
        const allGoods = [];
        let page = 1;
        const pageSize = 50;

        while (true) {
            const result = await this.getInventoryTaskGoods(poiId, taskNo, entityType, page, pageSize);
            const goods = result.data?.list || [];
            allGoods.push(...goods);

            const total = result.data?.total || 0;
            if (allGoods.length >= total || goods.length === 0) {
                break;
            }
            page++;
        }

        console.log(`[QNH] 盘点单 ${taskNo} 商品明细查询完成: 共 ${allGoods.length} 个商品`);
        return allGoods;
    }

    /**
     * 获取指定完结时间范围内的所有盘点库存变化
     * 返回格式: { barcode: { totalChange: number, logs: [...] } }
     * @param {string|number} poiId - 门店ID
     * @param {number} finishStartTime - 完结时间起始（毫秒）
     * @param {number} finishEndTime - 完结时间结束（毫秒）
     * @param {number} createStartTime - 创建时间起始（毫秒），默认30天前
     * @returns {Promise<Object>} 按条形码汇总的库存变化
     */
    async getInventoryChanges(poiId, finishStartTime, finishEndTime, createStartTime = null) {
        console.log(`[QNH] 查询门店 ${poiId} 盘点变化(完结时间): ${new Date(finishStartTime).toLocaleString()} ~ ${new Date(finishEndTime).toLocaleString()}`);
        
        // 创建时间范围：默认查30天内创建的盘点单
        const now = Date.now();
        const createStart = createStartTime || (now - 30 * 24 * 60 * 60 * 1000);
        const createEnd = now;
        
        const allChanges = {};
        let page = 1;
        const pageSize = 50;
        let processedCount = 0;
        let shouldContinue = true;

        while (shouldContinue) {
            const result = await this.getInventoryTaskList(poiId, createStart, createEnd, page, pageSize);
            const tasks = result.data?.list || [];
            
            if (tasks.length === 0) break;

            for (const task of tasks) {
                // 获取完结时间（operationProgressInfo.operateTime）
                const finishTime = task.operationProgressInfo?.operateTime;
                
                // 列表按时间倒序，完结时间早于起始时间时可提前终止
                if (finishTime && finishTime < finishStartTime) {
                    console.log(`[QNH] 盘点单 ${task.taskNo} 完结时间 ${new Date(finishTime).toLocaleString()} 早于查询起始时间，停止遍历`);
                    shouldContinue = false;
                    break;
                }

                // 只处理完结时间在范围内的盘点单
                if (task.taskNo && finishTime && finishTime >= finishStartTime && finishTime <= finishEndTime) {
                    console.log(`[QNH] 处理盘点单 ${task.taskNo} (完结时间: ${new Date(finishTime).toLocaleString()})`);
                    const goodsList = await this.getAllInventoryTaskGoods(poiId, task.taskNo, task.entityType);
                    processedCount++;
                    
                    for (const goods of goodsList) {
                        // 条形码在 upcList 数组中，只取第一个（避免多条形码重复计算）
                        const upcList = goods.upcList || [];
                        const barcode = upcList[0]; // 只用第一个条形码
                        // stockNo: 原库存, checkStockNo: 盘点后库存
                        const oldStock = parseInt(goods.stockNo) || 0;
                        const newStock = parseInt(goods.checkStockNo) || 0;
                        
                        if (barcode) {
                            const change = newStock - oldStock;
                            if (change !== 0) { // 只记录有变化的
                                if (!allChanges[barcode]) {
                                    allChanges[barcode] = { totalChange: 0, logs: [] };
                                }
                                allChanges[barcode].totalChange += change;
                                allChanges[barcode].logs.push({
                                    taskNo: task.taskNo,
                                    taskName: task.taskName,
                                    skuName: goods.skuName,
                                    barcode: barcode,
                                    beforeStock: oldStock,
                                    afterStock: newStock,
                                    change: change,
                                    finishTime: finishTime
                                });
                            }
                        }
                    }
                }
            }

            // 检查是否需要继续分页
            const total = result.data?.total || 0;
            if (page * pageSize >= total) break;
            page++;
        }

        console.log(`[QNH] 门店 ${poiId} 处理了 ${processedCount} 个盘点单，共汇总 ${Object.keys(allChanges).length} 个商品的盘点变化`);
        return allChanges;
    }

    // ========================================
    // 收货单相关 API
    // ========================================

    /**
     * 查询收货单列表
     * @param {string|number} warehouseId - 仓库ID
     * @param {number} createStartTime - 创建时间起始（毫秒）
     * @param {number} createEndTime - 创建时间结束（毫秒）
     * @param {number} finishStartTime - 完结时间起始（毫秒），可选
     * @param {number} finishEndTime - 完结时间结束（毫秒），可选
     * @param {number} page - 页码
     * @param {number} pageSize - 每页数量
     * @returns {Promise<Object>} 收货单列表
     */
    async getReceiptOrderList(warehouseId, createStartTime, createEndTime, finishStartTime = null, finishEndTime = null, page = 1, pageSize = 10) {
        const url = 'https://qnh.meituan.com/qnh-gw2/wms/inbound/receipt/front/order/list?yodaReady=h5&csecplatform=4&csecversion=4.0.4';
        const warehouseIdNum = typeof warehouseId === 'string' ? parseInt(warehouseId) : warehouseId;
        
        const query = {
            warehouseIds: [warehouseIdNum],
            inboundOrderNos: [],
            scOrderNoList: [],
            transportTrackingNoOrBookingOrderNoListKeyword: [],
            createTimeRange: {
                startTimeInMillis: createStartTime,
                endTimeInMillis: createEndTime
            }
        };
        
        // 添加完结时间范围过滤（如果提供）
        if (finishStartTime && finishEndTime) {
            query.finishTimeRange = {
                startTimeInMillis: finishStartTime,
                endTimeInMillis: finishEndTime
            };
        }
        
        const data = {
            page: page,
            pageSize: pageSize,
            query: query
        };

        const result = await this._request('POST', url, data);
        return result;
    }

    /**
     * 获取所有收货单（自动分页）
     * @param {string|number} warehouseId - 仓库ID
     * @param {number} createStartTime - 创建时间起始（毫秒）
     * @param {number} createEndTime - 创建时间结束（毫秒）
     * @param {number} finishStartTime - 完结时间起始（毫秒），可选
     * @param {number} finishEndTime - 完结时间结束（毫秒），可选
     * @returns {Promise<Array>} 所有收货单
     */
    async getAllReceiptOrders(warehouseId, createStartTime, createEndTime, finishStartTime = null, finishEndTime = null) {
        const allOrders = [];
        let page = 1;
        const pageSize = 50;

        while (true) {
            const result = await this.getReceiptOrderList(warehouseId, createStartTime, createEndTime, finishStartTime, finishEndTime, page, pageSize);
            const orders = result.data?.list || [];
            allOrders.push(...orders);

            const total = result.data?.total || 0;
            if (allOrders.length >= total || orders.length === 0) {
                break;
            }
            page++;
        }

        console.log(`[QNH] 收货单查询完成: 共 ${allOrders.length} 条`);
        return allOrders;
    }

    /**
     * 查询收货单商品明细
     * @param {string|number} warehouseId - 仓库ID
     * @param {string} inboundOrderNo - 收货单号
     * @param {number} page - 页码
     * @param {number} pageSize - 每页数量
     * @returns {Promise<Object>} 商品明细
     */
    async getReceiptOrderItems(warehouseId, inboundOrderNo, page = 1, pageSize = 50) {
        const url = 'https://qnh.meituan.com/qnh-gw2/wms/inbound/receipt/order/items?yodaReady=h5&csecplatform=4&csecversion=4.0.4';
        const warehouseIdNum = typeof warehouseId === 'string' ? parseInt(warehouseId) : warehouseId;
        
        const data = {
            warehouseId: warehouseIdNum,
            inboundOrderNo: inboundOrderNo,
            queryCmd: {
                page: page,
                pageSize: pageSize,
                query: {}
            }
        };

        const result = await this._request('POST', url, data);
        return result;
    }

    /**
     * 获取收货单的所有商品明细（自动分页）
     * @param {string|number} warehouseId - 仓库ID
     * @param {string} inboundOrderNo - 收货单号
     * @returns {Promise<Array>} 所有商品明细
     */
    async getAllReceiptOrderItems(warehouseId, inboundOrderNo) {
        const allItems = [];
        let page = 1;
        const pageSize = 50;

        while (true) {
            const result = await this.getReceiptOrderItems(warehouseId, inboundOrderNo, page, pageSize);
            const items = result.data?.list || [];
            allItems.push(...items);

            const total = result.data?.total || 0;
            if (allItems.length >= total || items.length === 0) {
                break;
            }
            page++;
        }

        console.log(`[QNH] 收货单 ${inboundOrderNo} 商品明细查询完成: 共 ${allItems.length} 个商品`);
        return allItems;
    }

    /**
     * 获取指定完结时间范围内的所有收货库存变化
     * 返回格式: { barcode: { totalChange: number, logs: [...] } }
     * @param {string|number} warehouseId - 仓库ID
     * @param {number} finishStartTime - 完结时间起始（毫秒）
     * @param {number} finishEndTime - 完结时间结束（毫秒）
     * @returns {Promise<Object>} 按条形码汇总的库存变化
     */
    async getReceiptChanges(warehouseId, finishStartTime, finishEndTime) {
        console.log(`[QNH] 查询仓库 ${warehouseId} 收货变化(完结时间): ${new Date(finishStartTime).toLocaleString()} ~ ${new Date(finishEndTime).toLocaleString()}`);
        
        // 创建时间范围：固定查30天
        const now = Date.now();
        const createStartTime = now - 30 * 24 * 60 * 60 * 1000;
        const createEndTime = now;
        
        // 通过 finishTimeRange 过滤后获取所有符合条件的收货单
        const allOrders = await this.getAllReceiptOrders(
            warehouseId, 
            createStartTime, 
            createEndTime, 
            finishStartTime, 
            finishEndTime
        );
        
        const allChanges = {};
        let processedCount = 0;

        for (const order of allOrders) {
            const orderNo = order.inboundOrderNo;
            const finishTime = order.timeInfo?.finishTimeInMillis;

            // 接口已通过 finishTimeRange 过滤，直接处理
            if (orderNo) {
                console.log(`[QNH] 处理收货单 ${orderNo} (完结时间: ${finishTime ? new Date(finishTime).toLocaleString() : '未知'})`);
                const itemsList = await this.getAllReceiptOrderItems(warehouseId, orderNo);
                processedCount++;
                
                for (const item of itemsList) {
                    // 条形码在 goodsInfo.upcList 中，只取第一个（避免多条形码重复计算）
                    const upcList = item.goodsInfo?.upcList || [];
                    const barcode = upcList[0]; // 只用第一个条形码
                    // 收货数量在 quantityInfo.receivedQuantityOfBaseUnit
                    const receivedQty = parseInt(item.quantityInfo?.receivedQuantityOfBaseUnit) || 0;
                    const goodsName = item.goodsInfo?.goodsName || '';
                    
                    if (barcode && receivedQty > 0) {
                        if (!allChanges[barcode]) {
                            allChanges[barcode] = { totalChange: 0, logs: [] };
                        }
                        allChanges[barcode].totalChange += receivedQty;
                        allChanges[barcode].logs.push({
                            orderNo: orderNo,
                            goodsName: goodsName,
                            barcode: barcode,
                            receivedQty: receivedQty,
                            finishTime: finishTime
                        });
                    }
                }
            }
        }

        console.log(`[QNH] 仓库 ${warehouseId} 处理了 ${processedCount} 个收货单，共汇总 ${Object.keys(allChanges).length} 个商品的收货变化`);
        return allChanges;
    }
}

module.exports = QianniuhuaClient;
