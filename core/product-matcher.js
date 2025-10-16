/**
 * 商品匹配器模块
 * 基于条形码匹配饿了么和牵牛花的商品
 */

class ProductMatcher {
    constructor() {
        // 缓存已匹配的结果 {eleme_barcode: qnh_sku_id}
        this._matchCache = {};
        // 未匹配的商品列表
        this._unmatched = [];
        
        console.log('[ProductMatcher] 初始化完成');
    }

    /**
     * 根据条形码匹配商品
     * @param {string} elemeBarcode - 饿了么商品条形码
     * @param {Object} qnhMapping - 牵牛花商品映射 {条形码: SKU ID}
     * @returns {string|null} 牵牛花SKU ID，未匹配返回null
     */
    matchByBarcode(elemeBarcode, qnhMapping) {
        // 检查缓存
        if (this._matchCache[elemeBarcode]) {
            return this._matchCache[elemeBarcode];
        }

        // 精确匹配
        if (qnhMapping[elemeBarcode]) {
            const skuId = qnhMapping[elemeBarcode];
            this._matchCache[elemeBarcode] = skuId;
            console.log(`[ProductMatcher] 精确匹配: ${elemeBarcode} -> ${skuId}`);
            return skuId;
        }

        // 未匹配
        if (!this._unmatched.includes(elemeBarcode)) {
            this._unmatched.push(elemeBarcode);
            console.warn(`[ProductMatcher] 未找到匹配: ${elemeBarcode}`);
        }

        return null;
    }

    /**
     * 批量匹配商品
     * @param {Array<Object>} elemeProducts - 饿了么商品列表 [{barcode, name, stock, ...}]
     * @param {Object} qnhMapping - 牵牛花商品映射 {条形码: SKU ID}
     * @returns {Object} 匹配结果 {饿了么条形码: 牵牛花SKU ID}
     */
    batchMatch(elemeProducts, qnhMapping) {
        const results = {};

        for (const product of elemeProducts) {
            const barcode = product.barcode;
            if (!barcode) {
                continue;
            }

            const skuId = this.matchByBarcode(barcode, qnhMapping);
            results[barcode] = skuId;
        }

        const matchedCount = Object.values(results).filter(v => v !== null).length;
        const totalCount = Object.keys(results).length;

        console.log(`[ProductMatcher] 批量匹配完成: ${matchedCount}/${totalCount} 个商品`);

        return results;
    }

    /**
     * 比对Excel找出库存不一致的商品（全量同步专用）
     * @param {Array<Object>} elemeProducts - 饿了么商品列表
     * @param {Array<Object>} qnhProducts - 牵牛花商品列表
     * @returns {Array<Object>} 库存差异列表
     * 
     * 返回格式: [
     *   {
     *     barcode: '条形码',
     *     name: '商品名',
     *     elemeStock: 10,
     *     qnhStock: 8,
     *     skuId: 'xxx',
     *     difference: 2
     *   },
     *   ...
     * ]
     */
    compareStocks(elemeProducts, qnhProducts) {
        const differences = [];
        const qnhMap = {};

        // 建立牵牛花商品索引 {barcode: {stock, skuId, name}}
        for (const qnh of qnhProducts) {
            if (qnh.barcode) {
                qnhMap[qnh.barcode] = {
                    stock: qnh.stock || 0,
                    skuId: qnh.skuId || qnh.sku_id,
                    name: qnh.name || qnh.product_name
                };
            }
        }

        console.log(`[ProductMatcher] 牵牛花商品索引建立完成: ${Object.keys(qnhMap).length} 个商品`);

        // 比对库存
        for (const eleme of elemeProducts) {
            const barcode = eleme.barcode;
            if (!barcode) {
                continue;
            }

            const qnh = qnhMap[barcode];
            
            // 只有当商品同时存在于两个平台，且库存不一致时，才需要同步
            if (qnh) {
                const elemeStock = eleme.stock || 0;
                const qnhStock = qnh.stock || 0;
                
                if (elemeStock !== qnhStock) {
                    differences.push({
                        barcode: barcode,
                        name: eleme.name || qnh.name,
                        elemeStock: elemeStock,
                        qnhStock: qnhStock,
                        skuId: qnh.skuId,
                        difference: elemeStock - qnhStock
                    });
                    
                    // 缓存匹配结果
                    this._matchCache[barcode] = qnh.skuId;
                }
            } else {
                // 记录未匹配
                if (!this._unmatched.includes(barcode)) {
                    this._unmatched.push(barcode);
                }
            }
        }

        console.log(`[ProductMatcher] 库存比对完成:`);
        console.log(`  - 饿了么商品: ${elemeProducts.length} 个`);
        console.log(`  - 牵牛花商品: ${qnhProducts.length} 个`);
        console.log(`  - 库存不一致: ${differences.length} 个`);
        console.log(`  - 未匹配: ${this._unmatched.length} 个`);

        return differences;
    }

    /**
     * 获取未匹配的条形码列表
     * @returns {Array<string>} 未匹配的条形码
     */
    getUnmatched() {
        return this._unmatched.slice(); // 返回副本
    }

    /**
     * 获取匹配缓存
     * @returns {Object} 匹配缓存
     */
    getMatchCache() {
        return { ...this._matchCache }; // 返回副本
    }

    /**
     * 清空缓存
     */
    clearCache() {
        this._matchCache = {};
        this._unmatched = [];
        console.log('[ProductMatcher] 缓存已清空');
    }

    /**
     * 获取匹配统计信息
     * @returns {Object} 统计信息
     */
    getMatchStats() {
        const matchedCount = Object.keys(this._matchCache).length;
        const unmatchedCount = this._unmatched.length;
        const totalCount = matchedCount + unmatchedCount;
        const matchRate = totalCount > 0 ? matchedCount / totalCount : 0;

        return {
            matched_count: matchedCount,
            unmatched_count: unmatchedCount,
            total_count: totalCount,
            match_rate: matchRate
        };
    }
}

module.exports = ProductMatcher;

