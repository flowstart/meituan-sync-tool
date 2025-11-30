/**
 * 牵牛花（美团外卖） API 客户端 V2 - 模块化版本
 * 
 * 与 V1 的区别：
 * - 模块化架构（base, store, product, stock, tenant, transfer）
 * - 新增商品创建功能（tenant 模块）
 * - 新增商品搬运功能（transfer 模块）
 * - 支持跨后台商品搬运
 * - 保持与 V1 的 API 兼容性
 * 
 * 使用方式：
 * const QianniuhuaClient = require('./api/qnh-client-v2');
 * 
 * 或在主程序中切换：
 * const QianniuhuaClient = USE_V2_CLIENT 
 *   ? require('./api/qnh-client-v2')
 *   : require('./api/qnh-client');
 */

const QNHBaseClient = require('./qnh/base');
const StoreModule = require('./qnh/store');
const ProductModule = require('./qnh/product');
const StockModule = require('./qnh/stock');
const TenantModule = require('./qnh/tenant');
const TransferModule = require('./qnh/transfer');

class QianniuhuaClientV2 {
    /**
     * 构造函数
     * @param {Object|string} config - 配置对象或Cookie字符串
     */
    constructor(config) {
        // 初始化基础客户端
        this._base = new QNHBaseClient(config);
        
        // 初始化各功能模块
        this.stores = new StoreModule(this._base);
        this.products = new ProductModule(this._base);
        this.stock = new StockModule(this._base);
        this.tenant = new TenantModule(this._base);
        
        // 商品搬运模块（懒加载）
        this._transferModule = null;
        
        // 向后兼容：保留缓存引用
        this._storesCache = this.stores._storesCache;
        this._productsCache = this.products._productsCache;
    }

    /**
     * 创建商品搬运模块（支持跨后台搬运）
     * @param {QianniuhuaClientV2} targetClient - 目标后台客户端（可选）
     * @returns {TransferModule}
     */
    createTransfer(targetClient = null) {
        const targetBase = targetClient ? targetClient._base : null;
        return new TransferModule(this._base, targetBase);
    }

    /**
     * 获取商品搬运模块（源和目标相同）
     */
    get transfer() {
        if (!this._transferModule) {
            this._transferModule = new TransferModule(this._base, this._base);
        }
        return this._transferModule;
    }

    // ==================== V1 兼容方法 ====================

    parseCookies(cookieStr) {
        return this._base.parseCookies(cookieStr);
    }

    generateMtgsig(url, body) {
        return this._base.generateMtgsig(url, body);
    }

    getHeaders(mtgsig = null) {
        return this._base.getHeaders(mtgsig);
    }

    getCookieString() {
        return this._base.getCookieString();
    }

    _request(method, url, data = null, needSign = true) {
        return this._base.request(method, url, data, needSign);
    }

    async getStores(forceRefresh = false) {
        return await this.stores.getAll(forceRefresh);
    }

    async getProducts(storeId, page = 1, pageSize = 20, upcList = null) {
        return await this.products.getList(storeId, page, pageSize, upcList);
    }

    async getProductsMapping(storeId, useExport = true) {
        return await this.products.getMapping(storeId, useExport);
    }

    async getSkuIdsByBarcodes(storeId, barcodes) {
        return await this.products.getSkuIdsByBarcodes(storeId, barcodes);
    }

    async exportProducts(storeId, exportPath = null, maxRetries = 2, options = {}) {
        return await this.products.export(storeId, exportPath, maxRetries, options);
    }

    async updateStock(storeId, skuId, newQuantity, comment = '库存同步') {
        return await this.stock.update(storeId, skuId, newQuantity, comment);
    }

    async batchUpdateStock(storeIds, barcode, newQuantity) {
        const updates = [];
        for (const storeId of storeIds) {
            updates.push({
                storeId: storeId,
                barcode: barcode,
                newQuantity: newQuantity
            });
        }
        
        const result = await this.stock.batchUpdateMultiStore(updates, 10);
        
        const results = {};
        for (const [storeId, detail] of Object.entries(result.details)) {
            results[storeId] = detail.success > 0;
        }
        
        return results;
    }

    async batchUpdateMultipleSkus(storeId, skuUpdates, comment = '批量库存同步') {
        return await this.stock.batchUpdate(storeId, skuUpdates, comment);
    }

    async batchUpdateStockOptimized(updates, batchSize = 10, comment = '批量库存同步') {
        return await this.stock.batchUpdateMultiStore(updates, batchSize, comment);
    }

    async updateStockByBarcodes(storeId, barcodeQuantities, batchSize = 10) {
        return await this.stock.updateByBarcodes(storeId, barcodeQuantities, batchSize);
    }

    _sleep(ms) {
        return this._base.sleep(ms);
    }

    // ==================== V2 新功能 ====================

    /**
     * 获取租户商品列表
     */
    async getTenantProducts(page = 1, pageSize = 20, filters = {}) {
        return await this.tenant.getProducts(page, pageSize, filters);
    }

    /**
     * 获取租户商品详情
     */
    async getTenantProductInfo(spuId) {
        return await this.tenant.getProductInfo(spuId);
    }

    /**
     * 创建商品（入档到租户）
     */
    async createProduct(productData) {
        return await this.tenant.createProduct(productData);
    }

    /**
     * 构建商品创建数据
     */
    buildProductCreateData(storeProductDetail, options = {}) {
        return this.tenant.buildCreateData(storeProductDetail, options);
    }

    /**
     * 搬运单个商品
     */
    async transferProduct(sourcePoiId, sourceSpuId, options = {}) {
        return await this.transfer.transferProduct(sourcePoiId, sourceSpuId, options);
    }

    /**
     * 批量搬运商品
     */
    async batchTransferProducts(products, options = {}, concurrency = 5) {
        return await this.transfer.batchTransfer(products, options, concurrency);
    }

    /**
     * 搬运整个门店的商品
     */
    async transferAllProducts(sourceStoreId, targetStoreId, options = {}) {
        return await this.transfer.transferAllProducts(sourceStoreId, targetStoreId, options);
    }

    /**
     * 获取商品详情（门店级别）
     */
    async getProductDetail(poiId, spuId) {
        return await this.products.getDetail(poiId, spuId);
    }

    // ==================== 静态方法 ====================

    static async getStores(cookieStr) {
        return await StoreModule.validateCookie(cookieStr);
    }

    static createCrossAccountTransfer(sourceCookies, targetCookies) {
        const sourceClient = new QianniuhuaClientV2(sourceCookies);
        const targetClient = new QianniuhuaClientV2(targetCookies);
        return new TransferModule(sourceClient._base, targetClient._base);
    }
}

// 导出
module.exports = QianniuhuaClientV2;

// 同时导出各模块
module.exports.QNHBaseClient = QNHBaseClient;
module.exports.StoreModule = StoreModule;
module.exports.ProductModule = ProductModule;
module.exports.StockModule = StockModule;
module.exports.TenantModule = TenantModule;
module.exports.TransferModule = TransferModule;

