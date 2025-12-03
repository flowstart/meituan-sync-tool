/**
 * 牵牛花 API - 商品管理模块（门店级别）
 * 负责：商品查询、商品导出、商品映射、商品详情
 */

class ProductModule {
    /**
     * 构造函数
     * @param {QNHBaseClient} baseClient - 基础客户端实例
     */
    constructor(baseClient) {
        this.base = baseClient;
        this._productsCache = {};
    }

    /**
     * 获取门店商品列表（分页）
     * @param {string} storeId - 门店ID
     * @param {number} page - 页码
     * @param {number} pageSize - 每页数量
     * @param {Array<string>} upcList - 条形码列表（可选）
     * @returns {Promise<Object>} 商品列表数据
     */
    async getList(storeId, page = 1, pageSize = 20, upcList = null) {
        const url = 'https://qnh.meituan.com/qnh-gw3/api/product/store/page-query-spu';
        const params = new URLSearchParams({
            yodaReady: 'h5',
            csecplatform: '4',
            csecversion: '4.0.4'
        });

        const fullUrl = `${url}?${params.toString()}`;

        const storeIdNum = parseInt(storeId);
        console.log(`[QNH Product] 分页查询: storeId=${storeId}, page=${page}, pageSize=${pageSize}`);

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

        const result = await this.base.request('POST', fullUrl, data);
        
        if (upcList) {
            console.log(`[QNH Product] 获取门店 ${storeId} 的商品，条形码过滤: ${upcList.join(',')}`);
        } else {
            console.log(`[QNH Product] 获取门店 ${storeId} 的商品，页码: ${page}`);
        }

        return result.data || {};
    }

    /**
     * 获取商品条形码和skuId的映射（全量）
     * @param {string} storeId - 门店ID
     * @param {boolean} useExport - 是否使用导出接口（推荐）
     * @returns {Promise<Object>} {条形码: skuId}
     */
    async getMapping(storeId, useExport = true) {
        // 检查缓存
        if (this._productsCache[storeId]) {
            return this._productsCache[storeId];
        }

        if (useExport) {
            console.log('[QNH Product] 使用导出接口获取商品映射...');
            console.warn('[QNH Product] Excel解析功能待实现，回退到分页查询');
        }

        // 使用分页接口
        console.log('[QNH Product] 使用分页接口获取商品映射...');
        const mapping = {};
        let page = 1;
        const pageSize = 50;

        while (true) {
            const productsData = await this.getList(storeId, page, pageSize);
            const productList = productsData.list || [];

            if (productList.length === 0) {
                break;
            }

            for (const product of productList) {
                for (const sku of product.storeSkuList || []) {
                    const upcList = sku.upcList || [];
                    if (upcList.length > 0) {
                        const barcode = upcList[0];
                        mapping[barcode] = String(sku.skuId);
                    }
                }
            }

            if (productList.length < pageSize) {
                break;
            }

            page++;
        }

        this._productsCache[storeId] = mapping;
        console.log(`[QNH Product] 门店 ${storeId} 共获取 ${Object.keys(mapping).length} 个商品映射`);

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

        console.log(`[QNH Product] 批量查询 ${barcodes.length} 个条形码对应的SKU ID`);

        const batchSize = 50;
        const result = {};

        for (let i = 0; i < barcodes.length; i += batchSize) {
            const batchBarcodes = barcodes.slice(i, i + batchSize);
            const productsData = await this.getList(storeId, 1, 50, batchBarcodes);
            const productList = productsData.list || [];

            const foundBarcodes = new Set();
            for (const product of productList) {
                for (const sku of product.storeSkuList || []) {
                    const upcList = sku.upcList || [];
                    const skuId = String(sku.skuId);

                    for (const barcode of upcList) {
                        if (batchBarcodes.includes(barcode)) {
                            result[barcode] = skuId;
                            foundBarcodes.add(barcode);
                        }
                    }
                }
            }

            for (const barcode of batchBarcodes) {
                if (!foundBarcodes.has(barcode)) {
                    result[barcode] = null;
                }
            }
        }

        const foundCount = Object.values(result).filter(v => v !== null).length;
        console.log(`[QNH Product] 查询完成: 找到 ${foundCount}/${barcodes.length} 个商品`);

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

        console.log(`[QNH Product] 批量查询 ${barcodes.length} 个条形码的库存`);

        const batchSize = 50;
        const result = {};

        for (let i = 0; i < barcodes.length; i += batchSize) {
            const batchBarcodes = barcodes.slice(i, i + batchSize);
            const productsData = await this.getList(storeId, 1, 50, batchBarcodes);
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
        console.log(`[QNH Product] 库存查询完成: 找到 ${foundCount}/${barcodes.length} 个商品`);

        return result;
    }

    /**
     * 导出门店商品列表到Excel（支持重试）
     * @param {string} storeId - 门店ID
     * @param {string} exportPath - 导出文件路径（可选）
     * @param {number} maxRetries - 最大重试次数（默认2次）
     * @param {Object} options - 选项 {shouldCancel, log}
     * @returns {Promise<string|null>} 导出文件路径，失败返回null
     */
    async export(storeId, exportPath = null, maxRetries = 2, options = {}) {
        if (!exportPath) {
            exportPath = `data/qnh_products_store_${storeId}.xlsx`;
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const logFn = (level, message) => {
                try {
                    if (options && typeof options.log === 'function') {
                        options.log(level, message);
                    }
                } catch (_) {}
            };

            console.log(`[QNH Product] 导出商品 - 第${attempt}次尝试（共${maxRetries}次）`);
            logFn('info', `牵牛花导出：第${attempt}次尝试（共${maxRetries}次）`);
            
            if (options.shouldCancel && options.shouldCancel()) {
                console.warn('[QNH Product] 导出任务被取消（开始前）');
                logFn('warn', '牵牛花导出任务被取消（开始前）');
                return null;
            }

            const result = await this._exportOnce(storeId, exportPath, options);
            
            if (result) {
                console.log(`[QNH Product] 导出成功（第${attempt}次尝试）`);
                logFn('info', `牵牛花导出成功（第${attempt}次尝试）`);
                return result;
            }
            
            if (attempt < maxRetries) {
                console.warn(`[QNH Product] 导出失败，将重新尝试（${attempt}/${maxRetries}）`);
                logFn('warn', `牵牛花导出失败，将重新尝试（${attempt}/${maxRetries}）`);
                
                for (let t = 0; t < 50; t++) {
                    if (options.shouldCancel && options.shouldCancel()) {
                        console.warn('[QNH Product] 导出任务被取消（等待重试期间）');
                        logFn('warn', '牵牛花导出任务被取消（等待重试期间）');
                        return null;
                    }
                    await this.base.sleep(100);
                }
            } else {
                console.error(`[QNH Product] 导出失败，已达最大重试次数（${maxRetries}次）`);
                logFn('error', `牵牛花导出失败，已达最大重试次数（${maxRetries}次）`);
            }
        }

        return null;
    }

    /**
     * 单次导出商品（内部方法）
     * @private
     */
    async _exportOnce(storeId, exportPath, options = {}) {
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
            const storeIdNum = parseInt(storeId);
            
            console.log(`[QNH Product] 创建导出任务: storeId=${storeId}`);
            
            if (isNaN(storeIdNum)) {
                const errMsg = `门店ID必须是数字，当前值: ${storeId}`;
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

            const result = await this.base.request('POST', fullUrl, data);
            console.log(`[QNH Product] 创建导出任务成功，门店: ${storeId}`);

            // 2. 获取任务ID
            let taskId = result.data;
            if (typeof taskId === 'object') {
                taskId = taskId.taskId;
            }

            if (!taskId) {
                console.error(`[QNH Product] 未获取到任务ID`);
                return null;
            }

            console.log(`[QNH Product] 任务ID: ${taskId}，开始轮询任务状态...`);
            logFn('info', `牵牛花导出任务创建成功，任务ID: ${taskId}，（如果5分钟没有成功将触发超时处理机制）`);

            // 3. 轮询任务状态
            const pollInterval = 10;
            const maxWaitTime = 300;
            let elapsedTime = 0;

            while (elapsedTime < maxWaitTime) {
                for (let t = 0; t < pollInterval * 10; t++) {
                    if (options.shouldCancel && options.shouldCancel()) {
                        console.warn('[QNH Product] 导出任务被取消（轮询等待中）');
                        logFn('warn', '牵牛花导出任务被取消（轮询等待中）');
                        return null;
                    }
                    await this.base.sleep(100);
                }
                elapsedTime += pollInterval;

                if (options.shouldCancel && options.shouldCancel()) {
                    console.warn('[QNH Product] 导出任务被取消（查询前）');
                    logFn('warn', '牵牛花导出任务被取消（查询前）');
                    return null;
                }

                const taskStatus = await this._queryExportTaskStatus(taskId);
                if (!taskStatus) {
                    console.warn(`[QNH Product] 第${elapsedTime / pollInterval}次查询未找到任务`);
                    continue;
                }

                const status = taskStatus.executingState;
                console.log(`[QNH Product] 任务状态=${status}，已等待${elapsedTime}秒`);

                if (status === '已完成') {
                    const handleResultStr = taskStatus.handleResult || '{}';
                    let downloadUrl;
                    try {
                        const handleResult = JSON.parse(handleResultStr);
                        downloadUrl = handleResult.fileUrl;
                    } catch (e) {
                        console.error(`[QNH Product] 解析handleResult失败`);
                        logFn('error', `解析handleResult失败`);
                        return null;
                    }

                    if (!downloadUrl) {
                        console.error(`[QNH Product] 未获取到下载URL`);
                        logFn('error', `未获取到下载URL`);
                        return null;
                    }

                    console.log(`[QNH Product] 任务完成，开始下载文件...`);

                    if (options.shouldCancel && options.shouldCancel()) {
                        console.warn('[QNH Product] 导出任务被取消（下载前）');
                        logFn('warn', '牵牛花导出任务被取消（下载前）');
                        return null;
                    }

                    await this.base.downloadFile(downloadUrl, exportPath);
                    console.log(`[QNH Product] 文件下载成功: ${exportPath}`);
                    logFn('info', `牵牛花导出Excel下载成功: ${exportPath}`);

                    return exportPath;

                } else if (status === '处理失败' || status === '执行失败' || status === '已取消') {
                    const errorMsg = taskStatus.handleResult || '未知错误';
                    console.error(`[QNH Product] 导出任务${status}: ${errorMsg}`);
                    logFn('error', `牵牛花导出任务${status}：${errorMsg}`);
                    return null;
                }
            }

            console.error(`[QNH Product] 任务超时（${maxWaitTime}秒）`);
            logFn('error', `牵牛花导出任务超时（${maxWaitTime}秒）`);
            return null;

        } catch (error) {
            console.error('[QNH Product] 导出商品失败:', error);
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

        const endDate = new Date();
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
            const result = await this.base.request('POST', fullUrl, data);
            const dataField = result.data || {};
            const taskList = dataField.list || [];

            if (taskList.length === 0) {
                console.warn(`[QNH Product] 未查询到任务`);
                return null;
            }

            if (taskId) {
                for (const task of taskList) {
                    if (String(task.taskId) === String(taskId)) {
                        return task;
                    }
                }
                console.warn(`[QNH Product] 未找到任务ID: ${taskId}`);
                return null;
            }

            return taskList[0];

        } catch (error) {
            console.error('[QNH Product] 查询任务状态失败:', error);
            return null;
        }
    }

    /**
     * 获取商品详情（门店级别）
     * @param {string} poiId - 门店POI ID
     * @param {string} spuId - 商品SPU ID
     * @returns {Promise<Object>} 商品详情
     */
    async getDetail(poiId, spuId) {
        const url = 'https://qnh.meituan.com/api/v1/store/spu/productDetail';
        const params = new URLSearchParams({
            yodaReady: 'h5',
            csecplatform: '4',
            csecversion: '4.0.4'
        });

        const fullUrl = `${url}?${params.toString()}`;

        const data = {
            poiId: poiId,
            spuId: spuId
        };

        console.log(`[QNH Product] 获取商品详情: poiId=${poiId}, spuId=${spuId}`);

        const result = await this.base.request('POST', fullUrl, data);
        return result.data || {};
    }

    /**
     * 清除缓存
     * @param {string} storeId - 门店ID（可选，不传则清除所有）
     */
    clearCache(storeId = null) {
        if (storeId) {
            delete this._productsCache[storeId];
            console.log(`[QNH Product] 已清除门店 ${storeId} 的缓存`);
        } else {
            this._productsCache = {};
            console.log('[QNH Product] 已清除所有缓存');
        }
    }
}

module.exports = ProductModule;

