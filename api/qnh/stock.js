/**
 * 牵牛花 API - 库存管理模块
 * 负责：库存更新（单个、批量）
 */

class StockModule {
    /**
     * 构造函数
     * @param {QNHBaseClient} baseClient - 基础客户端实例
     */
    constructor(baseClient) {
        this.base = baseClient;
    }

    /**
     * 更新单个商品库存
     * @param {string} storeId - 门店ID
     * @param {string} skuId - 商品SKU ID
     * @param {number} newQuantity - 新库存数量
     * @param {string} comment - 备注
     * @returns {Promise<boolean>} 是否成功
     */
    async update(storeId, skuId, newQuantity, comment = '库存同步') {
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
                            oldQuantity: 0,
                            originLocationType: 15,
                            originLocationId: '',
                            originLocationCode: ''
                        }
                    ]
                }
            ]
        };

        try {
            await this.base.request('POST', url, data);
            console.log(`[QNH Stock] 更新库存成功: 门店=${storeId}, SKU=${skuId}, 新库存=${newQuantity}`);
            return true;
        } catch (error) {
            console.error(`[QNH Stock] 更新库存失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 批量更新多个SKU的库存（高效版：一次请求更新多个SKU）
     * @param {string} storeId - 门店ID
     * @param {Array<Object>} skuUpdates - SKU更新列表
     *   格式: [{ skuId: 'xxx', newQuantity: 100, comment: '备注' }, ...]
     * @param {string} comment - 整体备注
     * @returns {Promise<boolean>} 是否成功
     */
    async batchUpdate(storeId, skuUpdates, comment = '批量库存同步') {
        const url = 'https://qnh.meituan.com/api/v1/storeempower/operate/batchContainer/stockadjustment?yodaReady=h5&csecplatform=4&csecversion=4.0.4';

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
            skuList: skuList
        };

        try {
            await this.base.request('POST', url, data);
            console.log(`[QNH Stock] 批量更新成功: 门店=${storeId}, SKU数量=${skuList.length}`);
            return true;
        } catch (error) {
            // 不吞错：把具体错误向上抛出，便于同步引擎记录失败原因
            console.error(`[QNH Stock] 批量更新失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 根据条形码更新库存（单门店多个商品）
     * @param {string} storeId - 门店ID
     * @param {Array<Object>} barcodeQuantities - 条形码和数量列表
     *   格式: [{ barcode: 'xxx', quantity: 100, comment: '备注' }, ...]
     * @param {number} batchSize - 每批处理的SKU数量（默认10）
     * @returns {Promise<Object>} 更新结果统计
     */
    async updateByBarcodes(storeId, barcodeQuantities, batchSize = 10) {
        console.log(`[QNH Stock] 更新门店 ${storeId} 的 ${barcodeQuantities.length} 个商品`);

        // 获取商品映射（需要 ProductModule）
        // 这里通过 base client 访问其他模块
        const ProductModule = require('./product');
        const productModule = new ProductModule(this.base);
        const mapping = await productModule.getMapping(storeId);

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
            console.warn(`[QNH Stock] 以下条形码未找到: ${notFound.join(', ')}`);
        }

        // 分批更新
        const batches = [];
        for (let i = 0; i < skuUpdates.length; i += batchSize) {
            batches.push(skuUpdates.slice(i, i + batchSize));
        }

        console.log(`[QNH Stock] 分为 ${batches.length} 批，每批最多 ${batchSize} 个SKU`);

        let successCount = 0;
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            console.log(`[QNH Stock] 处理第 ${i + 1}/${batches.length} 批，${batch.length} 个SKU`);

            const success = await this.batchUpdate(storeId, batch);
            if (success) {
                successCount += batch.length;
            }

            // 避免请求过快
            if (i < batches.length - 1) {
                await this.base.sleep(500);
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
     * 批量更新多个门店的多个商品库存（并发处理）
     * 注意：此方法会调用商品导出，可能耗时较长
     * 
     * @param {Array<Object>} updates - 更新列表
     *   格式: [{ storeId: 'xxx', barcode: 'xxx', newQuantity: 100, comment: '' }, ...]
     * @param {number} batchSize - 每批处理的SKU数量（默认10）
     * @param {string} comment - 备注
     * @returns {Promise<Object>} 更新结果统计
     */
    async batchUpdateMultiStore(updates, batchSize = 10, comment = '批量库存同步') {
        console.log(`[QNH Stock] 开始批量更新，共 ${updates.length} 个任务`);

        // 按门店分组
        const updatesByStore = {};
        for (const update of updates) {
            if (!updatesByStore[update.storeId]) {
                updatesByStore[update.storeId] = [];
            }
            updatesByStore[update.storeId].push({
                barcode: update.barcode,
                quantity: update.newQuantity,
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
        const ProductModule = require('./product');
        const storePromises = Object.entries(updatesByStore).map(async ([storeId, storeUpdates]) => {
            try {
                const productModule = new ProductModule(this.base);
                const mapping = await productModule.getMapping(storeId);

                const skuUpdatesWithIds = [];
                for (const update of storeUpdates) {
                    const skuId = mapping[update.barcode];
                    if (skuId) {
                        skuUpdatesWithIds.push({
                            skuId: skuId,
                            newQuantity: update.quantity,
                            comment: update.comment || ''
                        });
                    } else {
                        console.warn(`[QNH Stock] 门店 ${storeId} 未找到条形码 ${update.barcode}`);
                        results.failed++;
                    }
                }

                // 分批更新
                const batches = [];
                for (let i = 0; i < skuUpdatesWithIds.length; i += batchSize) {
                    batches.push(skuUpdatesWithIds.slice(i, i + batchSize));
                }

                console.log(`[QNH Stock] 门店 ${storeId}: ${skuUpdatesWithIds.length} 个SKU，分为 ${batches.length} 批`);

                let storeSuccessCount = 0;
                for (const batch of batches) {
                    const success = await this.batchUpdate(storeId, batch, comment);
                    if (success) {
                        storeSuccessCount += batch.length;
                    } else {
                        results.failed += batch.length;
                    }
                    await this.base.sleep(500);
                }

                results.success += storeSuccessCount;
                results.details[storeId] = {
                    total: skuUpdatesWithIds.length,
                    success: storeSuccessCount,
                    failed: skuUpdatesWithIds.length - storeSuccessCount
                };

            } catch (error) {
                console.error(`[QNH Stock] 门店 ${storeId} 处理失败:`, error);
                results.failed += storeUpdates.length;
                results.details[storeId] = {
                    total: storeUpdates.length,
                    success: 0,
                    failed: storeUpdates.length,
                    error: error.message
                };
            }
        });

        await Promise.all(storePromises);

        console.log(`[QNH Stock] 批量更新完成: 总计=${results.total}, 成功=${results.success}, 失败=${results.failed}`);

        return results;
    }
}

module.exports = StockModule;

