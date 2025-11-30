/**
 * 牵牛花 API - 商品搬运模块
 * 负责：商品从A后台搬运到B后台（完整流程）
 */

class TransferModule {
    /**
     * 构造函数
     * @param {QNHBaseClient} sourceClient - 源后台客户端
     * @param {QNHBaseClient} targetClient - 目标后台客户端（可选，如果与源相同则传null）
     */
    constructor(sourceClient, targetClient = null) {
        this.sourceClient = sourceClient;
        this.targetClient = targetClient || sourceClient;
        
        // 初始化各模块（源和目标）
        const ProductModule = require('./product');
        const TenantModule = require('./tenant');
        const StockModule = require('./stock');
        
        this.sourceProduct = new ProductModule(sourceClient);
        this.sourceTenant = new TenantModule(sourceClient);
        
        this.targetProduct = new ProductModule(this.targetClient);
        this.targetTenant = new TenantModule(this.targetClient);
        this.targetStock = new StockModule(this.targetClient);
    }

    /**
     * 搬运单个商品（完整流程）
     * @param {string} sourcePoiId - 源门店POI ID
     * @param {string} sourceSpuId - 源商品SPU ID
     * @param {Object} options - 选项
     *   - categoryMapping: 分类映射 {旧分类名: 新分类ID}
     *   - copyStock: 是否同时搬运库存（默认false）
     *   - targetStoreIds: 目标门店ID列表（如果copyStock为true）
     * @returns {Promise<Object>} 搬运结果
     */
    async transferProduct(sourcePoiId, sourceSpuId, options = {}) {
        const result = {
            success: false,
            sourcePoiId,
            sourceSpuId,
            error: null,
            data: null
        };

        try {
            console.log(`[QNH Transfer] 开始搬运商品: poiId=${sourcePoiId}, spuId=${sourceSpuId}`);

            // 1. 获取源商品详情
            console.log('[QNH Transfer] 步骤1: 获取源商品详情...');
            const sourceDetail = await this.sourceProduct.getDetail(sourcePoiId, sourceSpuId);
            
            if (!sourceDetail || !sourceDetail.spuName) {
                throw new Error('获取源商品详情失败或数据为空');
            }

            const productName = sourceDetail.spuName;
            console.log(`[QNH Transfer] 商品名称: ${productName}`);

            // 2. 构建创建数据
            console.log('[QNH Transfer] 步骤2: 构建商品创建数据...');
            const createData = this.targetTenant.buildCreateData(sourceDetail, {
                categoryMapping: options.categoryMapping || {}
            });

            // 3. 创建商品到目标后台
            console.log('[QNH Transfer] 步骤3: 创建商品到目标后台...');
            const createResult = await this.targetTenant.createProduct(createData);

            if (!createResult.success) {
                throw new Error(`创建商品失败: ${createResult.error}`);
            }

            console.log('[QNH Transfer] 商品创建成功');

            result.success = true;
            result.data = {
                productName: productName,
                sourceDetail: sourceDetail,
                createData: createData,
                createResult: createResult,
                fixed: createResult.fixed
            };

            // 4. 如果需要搬运库存
            if (options.copyStock && options.targetStoreIds && options.targetStoreIds.length > 0) {
                console.log('[QNH Transfer] 步骤4: 搬运库存...');
                const stockResult = await this._transferStock(sourceDetail, options.targetStoreIds);
                result.data.stockResult = stockResult;
            }

            console.log(`[QNH Transfer] 商品搬运完成: ${productName}`);
            return result;

        } catch (error) {
            console.error(`[QNH Transfer] 商品搬运失败: ${error.message}`);
            result.error = error.message;
            return result;
        }
    }

    /**
     * 批量搬运商品
     * @param {Array<Object>} products - 商品列表
     *   格式: [{ poiId: 'xxx', spuId: 'xxx' }, ...]
     * @param {Object} options - 选项（同transferProduct）
     * @param {number} concurrency - 并发数（默认5）
     * @returns {Promise<Object>} 搬运结果统计
     */
    async batchTransfer(products, options = {}, concurrency = 5) {
        console.log(`[QNH Transfer] 开始批量搬运，共 ${products.length} 个商品，并发数: ${concurrency}`);

        const results = {
            total: products.length,
            success: 0,
            failed: 0,
            details: []
        };

        // 分批处理（控制并发）
        for (let i = 0; i < products.length; i += concurrency) {
            const batch = products.slice(i, i + concurrency);
            console.log(`[QNH Transfer] 处理批次 ${Math.floor(i / concurrency) + 1}，${batch.length} 个商品`);

            const batchPromises = batch.map(product =>
                this.transferProduct(product.poiId, product.spuId, options)
            );

            const batchResults = await Promise.all(batchPromises);

            for (const result of batchResults) {
                if (result.success) {
                    results.success++;
                } else {
                    results.failed++;
                }
                results.details.push(result);
            }

            // 批次间延迟
            if (i + concurrency < products.length) {
                await this.sourceClient.sleep(1000);
            }
        }

        console.log(`[QNH Transfer] 批量搬运完成: 总计=${results.total}, 成功=${results.success}, 失败=${results.failed}`);
        return results;
    }

    /**
     * 搬运库存（内部方法）
     * @private
     */
    async _transferStock(sourceDetail, targetStoreIds) {
        const stockUpdates = [];

        // 提取源商品的SKU和库存信息
        const skus = sourceDetail.storeSkuList || [];
        for (const sku of skus) {
            const barcode = (sku.upcList && sku.upcList[0]) || null;
            const stock = sku.onlineStock || 0;

            if (!barcode) {
                console.warn(`[QNH Transfer] SKU ${sku.skuId} 无条形码，跳过库存搬运`);
                continue;
            }

            // 为每个目标门店创建更新任务
            for (const storeId of targetStoreIds) {
                stockUpdates.push({
                    storeId: storeId,
                    barcode: barcode,
                    newQuantity: stock
                });
            }
        }

        if (stockUpdates.length === 0) {
            console.warn('[QNH Transfer] 无库存需要搬运');
            return { success: true, message: '无库存需要搬运' };
        }

        console.log(`[QNH Transfer] 准备更新 ${stockUpdates.length} 个库存记录`);

        // 批量更新库存
        const result = await this.targetStock.batchUpdateMultiStore(stockUpdates, 10, '商品搬运-库存同步');
        return result;
    }

    /**
     * 从一个门店搬运所有商品到另一个门店
     * @param {string} sourceStoreId - 源门店ID
     * @param {string} targetStoreId - 目标门店ID
     * @param {Object} options - 选项
     *   - categoryMapping: 分类映射
     *   - copyStock: 是否搬运库存
     *   - pageSize: 每页查询数量（默认20）
     *   - maxProducts: 最大商品数量（默认无限制）
     * @returns {Promise<Object>} 搬运结果
     */
    async transferAllProducts(sourceStoreId, targetStoreId, options = {}) {
        console.log(`[QNH Transfer] 开始搬运门店所有商品: ${sourceStoreId} -> ${targetStoreId}`);

        const pageSize = options.pageSize || 20;
        const maxProducts = options.maxProducts || Infinity;
        
        const products = [];
        let page = 1;

        // 1. 获取所有商品列表
        console.log('[QNH Transfer] 步骤1: 获取源门店商品列表...');
        while (products.length < maxProducts) {
            const productsData = await this.sourceProduct.getList(sourceStoreId, page, pageSize);
            const productList = productsData.list || [];

            if (productList.length === 0) {
                break;
            }

            for (const product of productList) {
                if (products.length >= maxProducts) break;
                
                products.push({
                    poiId: product.store?.poiId,
                    spuId: product.spuId,
                    name: product.name
                });
            }

            if (productList.length < pageSize) {
                break;
            }

            page++;
        }

        console.log(`[QNH Transfer] 找到 ${products.length} 个商品`);

        // 2. 批量搬运
        const transferOptions = {
            ...options,
            targetStoreIds: options.copyStock ? [targetStoreId] : []
        };

        const result = await this.batchTransfer(products, transferOptions);

        return result;
    }

    /**
     * 检查商品是否已存在（根据商品名称）
     * @param {string} productName - 商品名称
     * @returns {Promise<boolean>} 是否存在
     */
    async checkProductExists(productName) {
        try {
            const result = await this.targetTenant.getProducts(1, 20);
            const list = result.list || [];
            
            return list.some(p => p.name === productName);
        } catch (error) {
            console.error('[QNH Transfer] 检查商品是否存在失败:', error);
            return false;
        }
    }

    /**
     * 获取搬运进度报告
     * @param {Object} batchResult - batchTransfer的返回结果
     * @returns {Object} 进度报告
     */
    getProgressReport(batchResult) {
        const report = {
            total: batchResult.total,
            success: batchResult.success,
            failed: batchResult.failed,
            successRate: ((batchResult.success / batchResult.total) * 100).toFixed(2) + '%',
            failedProducts: [],
            successProducts: []
        };

        for (const detail of batchResult.details) {
            if (detail.success) {
                report.successProducts.push({
                    spuId: detail.sourceSpuId,
                    name: detail.data?.productName || '未知',
                    fixed: detail.data?.fixed || false
                });
            } else {
                report.failedProducts.push({
                    spuId: detail.sourceSpuId,
                    poiId: detail.sourcePoiId,
                    error: detail.error
                });
            }
        }

        return report;
    }

    /**
     * 导出失败商品列表
     * @param {Object} batchResult - batchTransfer的返回结果
     * @param {string} filePath - 导出文件路径
     */
    exportFailedProducts(batchResult, filePath = 'data/failed_products.json') {
        const fs = require('fs');
        const path = require('path');

        const failedProducts = batchResult.details
            .filter(d => !d.success)
            .map(d => ({
                poiId: d.sourcePoiId,
                spuId: d.sourceSpuId,
                error: d.error,
                timestamp: new Date().toISOString()
            }));

        // 确保目录存在
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, JSON.stringify(failedProducts, null, 2), 'utf8');
        console.log(`[QNH Transfer] 失败商品列表已导出到: ${filePath}`);

        return filePath;
    }
}

module.exports = TransferModule;

