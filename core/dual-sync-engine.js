/**
 * 双向同步引擎 - 实现A/B两个门店的库存双向同步
 * 
 * 核心逻辑：
 * 1. 从A饿了么操作记录提取销售变化量
 * 2. 从B饿了么操作记录提取销售变化量
 * 3. 查询B牵牛花当前库存，应用A的变化量
 * 4. 查询A牵牛花当前库存，应用B的变化量
 * 5. 过滤掉工具同步导致的变化（通过opUser识别）
 */

const ElemeClient = require('../api/eleme-client');
const createQnhClient = require('../api/qnh-client-factory');
const { ElemeParser } = require('../utils/parsers');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

class DualSyncEngine {
    /**
     * @param {Object} config - 配置
     * @param {Object} config.elemeA - A饿了么配置 {cookies, seller_id, store_id}
     * @param {Object} config.qnhA - A牵牛花配置 {cookies, store_id}
     * @param {Object} config.elemeB - B饿了么配置 {cookies, seller_id, store_id}
     * @param {Object} config.qnhB - B牵牛花配置 {cookies, store_id}
     * @param {Object} db - 数据库实例
     * @param {number} groupId - 双向同步组ID
     * @param {Function} logCallback - 日志回调 (groupId, level, message)
     * @param {Function} progressCallback - 进度回调 (groupId, progress, message)
     * @param {boolean} debugMode - 调试模式（不执行实际更新）
     */
    constructor(config, db, groupId, logCallback = null, progressCallback = null, debugMode = false) {
        this.config = config;
        this.db = db;
        this.groupId = groupId;
        this.logCallback = logCallback;
        this.progressCallback = progressCallback;
        this.debugMode = debugMode;
        this._cancelled = false;

        // 初始化A方客户端（传入完整配置对象，包含 cookies, seller_id, store_id）
        this.elemeA = new ElemeClient({
            cookies: config.elemeA.cookies,
            seller_id: config.elemeA.seller_id,
            store_id: config.elemeA.store_id
        });
        this.qnhA = createQnhClient(null, { cookies: config.qnhA.cookies });
        this.qnhAStoreId = config.qnhA.store_id;

        // 初始化B方客户端（传入完整配置对象，包含 cookies, seller_id, store_id）
        this.elemeB = new ElemeClient({
            cookies: config.elemeB.cookies,
            seller_id: config.elemeB.seller_id,
            store_id: config.elemeB.store_id
        });
        this.qnhB = createQnhClient(null, { cookies: config.qnhB.cookies });
        this.qnhBStoreId = config.qnhB.store_id;

        if (this.debugMode) {
            this._log('warn', '⚠️ 调试模式已开启：将跳过实际库存更新');
        }
    }

    /**
     * 取消同步
     */
    cancel() {
        this._cancelled = true;
        this._log('warn', '收到取消指令，正在安全中止...');
    }

    /**
     * 检查是否已取消
     * @private
     */
    _checkCancelled() {
        if (this._cancelled) {
            const error = new Error('sync_cancelled');
            error.code = 'SYNC_CANCELLED';
            throw error;
        }
    }

    /**
     * 日志输出
     * @private
     */
    _log(level, message) {
        console.log(`[DualSyncEngine][组${this.groupId}] ${message}`);
        if (this.logCallback) {
            this.logCallback(this.groupId, level, message);
        }
    }

    /**
     * 进度更新
     * @private
     */
    _progress(percent, message) {
        if (this.progressCallback) {
            this.progressCallback(this.groupId, percent, message);
        }
    }

    /**
     * 延时
     * @private
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 全量同步
     * 以A饿了么的库存为基准，同步到B牵牛花
     * @param {string} exportDir - 导出目录（可选，默认使用 data 子目录）
     */
    async fullSync(exportDir) {
        this._cancelled = false;
        const startTime = new Date();
        
        // 保存 exportDir 供其他方法使用
        this._exportDir = exportDir;
        
        try {
            this._log('info', '==================== 开始双向全量同步 ====================');
            this._progress(0, '开始全量同步...');

            // 步骤1: 从A饿了么导出商品
            this._log('info', '步骤1: 从A饿了么导出商品...');
            this._progress(10, '导出A饿了么商品...');
            
            // 确保导出目录存在（使用传入的目录或默认目录）
            const dataDir = exportDir || path.join(__dirname, '..', 'data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            
            const exportPath = path.join(dataDir, `dual_${this.groupId}_elemeA_${Date.now()}.xlsx`);
            await this.elemeA.exportProducts(exportPath, {
                shouldCancel: () => this._cancelled,
                log: (level, msg) => this._log(level, `[A饿了么导出] ${msg}`)
            });
            
            this._checkCancelled();

            // 步骤2: 解析A饿了么商品
            this._log('info', '步骤2: 解析A饿了么商品...');
            this._progress(30, '解析商品数据...');
            
            const elemeProducts = ElemeParser.parseExcel(exportPath);
            this._log('info', `解析到 ${elemeProducts.length} 个商品`);

            if (elemeProducts.length === 0) {
                throw new Error('A饿了么未导出任何商品');
            }

            this._checkCancelled();

            // 步骤3: 获取B牵牛花SKU映射
            this._log('info', '步骤3: 获取B牵牛花SKU映射...');
            this._progress(50, '获取B牵牛花映射...');
            
            const barcodes = elemeProducts.map(p => p.barcode).filter(b => b);
            const qnhBMapping = await this.qnhB.getSkuIdsByBarcodes(this.qnhBStoreId, barcodes);
            
            this._checkCancelled();

            // 步骤4: 准备更新数据
            this._log('info', '步骤4: 准备更新数据...');
            this._progress(60, '准备更新数据...');
            
            const updatesB = [];
            const updateDetailsB = []; // 调试模式用

            for (const product of elemeProducts) {
                const barcode = product.barcode;
                const stock = product.stock;
                const name = product.name || '';
                
                if (!barcode) continue;

                // 只同步到B牵牛花
                const skuIdB = qnhBMapping[barcode];
                if (skuIdB) {
                    updatesB.push({
                        skuId: skuIdB,
                        newQuantity: stock,
                        comment: `全量同步(A→B)`
                    });
                    updateDetailsB.push({ barcode, name, stock });
                }
            }

            this._log('info', `准备更新: B牵牛花 ${updatesB.length} 个`);
            
            this._checkCancelled();

            let successB = 0;

            // 调试模式：只打印日志，不执行实际更新
            if (this.debugMode) {
                this._log('warn', '⚠️ 调试模式：跳过实际库存更新');
                
                // 打印B牵牛花更新详情（最多显示20条）
                this._log('info', '--- 调试模式：B牵牛花将更新以下商品（实际未执行）---');
                const showCountB = Math.min(updateDetailsB.length, 20);
                for (let i = 0; i < showCountB; i++) {
                    const d = updateDetailsB[i];
                    this._log('info', `  ${d.barcode}: 库存设为 ${d.stock}`);
                }
                if (updateDetailsB.length > 20) {
                    this._log('info', `  ... 还有 ${updateDetailsB.length - 20} 个商品`);
                }
                this._log('info', '--- 调试模式结束 ---');
                
                successB = updatesB.length;
                this._progress(85, '调试模式：跳过更新');
            } else {
                // 步骤5: 更新B牵牛花
                this._log('info', '步骤5: 更新B牵牛花...');
                this._progress(80, '更新B牵牛花...');
                
                if (updatesB.length > 0) {
                    const resultB = await this.qnhB.batchUpdateMultipleSkus(this.qnhBStoreId, updatesB, '全量同步(A→B)');
                    successB = resultB ? updatesB.length : 0;
                }
            }

            // 步骤6: 记录同步时间
            const now = new Date();
            this.db.updateDualSyncGroup(this.groupId, {
                last_full_sync_time: now.toISOString(),
                last_a_query_time: now.toISOString(),
                last_b_query_time: now.toISOString()
            });

            const duration = ((now - startTime) / 1000).toFixed(1);
            this._progress(100, this.debugMode ? '调试模式：全量同步完成（未执行实际更新）' : '全量同步完成');
            this._log('info', '==================== 全量同步完成(A→B) ====================');
            this._log('info', `耗时: ${duration}秒`);
            this._log('info', `B牵牛花更新: ${successB}/${updatesB.length}`);
            if (this.debugMode) {
                this._log('warn', '⚠️ 调试模式：未执行实际库存更新');
            }

            return {
                status: 'success',
                duration: parseFloat(duration),
                updatesB: successB
            };

        } catch (error) {
            if (error.code === 'SYNC_CANCELLED') {
                this._log('warn', '全量同步已取消');
                return { status: 'cancelled' };
            }
            this._log('error', `全量同步失败: ${error.message}`);
            return { status: 'failed', error: error.message };
        }
    }

    /**
     * 增量同步
     * 1. 查询A/B饿了么操作记录，提取销售变化量
     * 2. 查询当前库存，应用变化量
     */
    async incrementalSync() {
        this._cancelled = false;
        const startTime = new Date();

        try {
            this._log('info', '==================== 开始双向增量同步 ====================');
            this._progress(0, '开始增量同步...');

            // 获取上次查询时间
            const group = this.db.getDualSyncGroup(this.groupId);
            if (!group) {
                throw new Error('双向同步组不存在');
            }

            const lastAQueryTime = group.last_a_query_time;
            const lastBQueryTime = group.last_b_query_time;

            if (!lastAQueryTime || !lastBQueryTime) {
                this._log('warn', '未检测到历史基线，请先执行全量同步');
                throw new Error('require_full_sync_first');
            }

            const aStartTime = Math.floor(new Date(lastAQueryTime).getTime() / 1000);
            const bStartTime = Math.floor(new Date(lastBQueryTime).getTime() / 1000);
            const now = Math.floor(Date.now() / 1000);

            // 检查时间范围（最多14天）
            const maxRange = 14 * 24 * 3600;
            if ((now - aStartTime) > maxRange || (now - bStartTime) > maxRange) {
                this._log('warn', '增量时间超过14天，已超出接口查询范围');
                throw new Error('time_range_exceeds_api_limit');
            }

            const rangeHours = Math.max(now - aStartTime, now - bStartTime) / 3600;
            if (rangeHours > 24) {
                this._log('info', `注意：本次增量同步将查询 ${rangeHours.toFixed(1)} 小时的数据`);
            }

            this._checkCancelled();

            // 步骤1: 查询A饿了么操作记录
            this._log('info', '步骤1: 查询A饿了么操作记录...');
            this._progress(10, '查询A饿了么变化...');
            
            const aChanges = await this._queryChanges(this.elemeA, aStartTime, now, 'A');
            this._log('info', `A饿了么提取到 ${Object.keys(aChanges).length} 个商品变化`);

            this._checkCancelled();

            // 步骤2: 查询B饿了么操作记录
            this._log('info', '步骤2: 查询B饿了么操作记录...');
            this._progress(25, '查询B饿了么变化...');
            
            const bChanges = await this._queryChanges(this.elemeB, bStartTime, now, 'B');
            this._log('info', `B饿了么提取到 ${Object.keys(bChanges).length} 个商品变化`);

            // 如果都没有变化，直接返回
            if (Object.keys(aChanges).length === 0 && Object.keys(bChanges).length === 0) {
                this._log('info', '没有销售变化，无需同步');
                
                // 更新查询时间和增量同步信息
                this.db.updateDualSyncGroup(this.groupId, {
                    last_a_query_time: new Date(now * 1000).toISOString(),
                    last_b_query_time: new Date(now * 1000).toISOString(),
                    last_incr_sync_time: new Date().toISOString(),
                    last_incr_sync_count: 0
                });

                this._progress(100, '无需同步');
                return { status: 'success', message: 'no_changes' };
            }

            this._checkCancelled();

            let totalSuccess = 0;
            let totalFailed = 0;
            let allFailedRecords = [];

            // 步骤3: 将A的变化应用到B牵牛花
            if (Object.keys(aChanges).length > 0) {
                this._log('info', '步骤3: 将A的变化应用到B牵牛花...');
                this._progress(40, '同步A变化到B...');
                
                const result = await this._applyChanges(
                    aChanges,
                    this.qnhB,
                    this.qnhBStoreId,
                    'A→B'
                );
                totalSuccess += result.success;
                totalFailed += result.failed;
                allFailedRecords = allFailedRecords.concat(result.failedRecords || []);
            }

            this._checkCancelled();

            // 步骤4: 将B的变化应用到A牵牛花
            if (Object.keys(bChanges).length > 0) {
                this._log('info', '步骤4: 将B的变化应用到A牵牛花...');
                this._progress(70, '同步B变化到A...');
                
                const result = await this._applyChanges(
                    bChanges,
                    this.qnhA,
                    this.qnhAStoreId,
                    'B→A'
                );
                totalSuccess += result.success;
                totalFailed += result.failed;
                allFailedRecords = allFailedRecords.concat(result.failedRecords || []);
            }

            // 步骤5: 导出失败记录（如果有）
            let failedExcelPath = null;
            if (allFailedRecords.length > 0) {
                this._log('warn', `有 ${allFailedRecords.length} 条记录同步失败，正在导出...`);
                failedExcelPath = this._exportFailedRecords(allFailedRecords);
            }

            // 步骤6: 更新查询时间和增量同步信息
            this.db.updateDualSyncGroup(this.groupId, {
                last_a_query_time: new Date(now * 1000).toISOString(),
                last_b_query_time: new Date(now * 1000).toISOString(),
                last_incr_sync_time: new Date().toISOString(),
                last_incr_sync_count: totalSuccess
            });

            const duration = ((new Date() - startTime) / 1000).toFixed(1);
            this._progress(100, this.debugMode ? '调试模式：增量同步完成（未执行实际更新）' : '增量同步完成');
            this._log('info', '==================== 双向增量同步完成 ====================');
            this._log('info', `耗时: ${duration}秒`);
            this._log('info', `成功: ${totalSuccess}, 失败: ${totalFailed}`);
            if (failedExcelPath) {
                this._log('info', `[!red]失败记录已导出: ${failedExcelPath}`);
            }
            if (this.debugMode) {
                this._log('warn', '⚠️ 调试模式：未执行实际库存更新');
            }

            return {
                status: totalFailed === 0 ? 'success' : 'partial',
                duration: parseFloat(duration),
                success: totalSuccess,
                failed: totalFailed,
                aChanges: Object.keys(aChanges).length,
                bChanges: Object.keys(bChanges).length,
                failedExcelPath
            };

        } catch (error) {
            if (error.code === 'SYNC_CANCELLED') {
                this._log('warn', '增量同步已取消');
                return { status: 'cancelled' };
            }
            this._log('error', `增量同步失败: ${error.message}`);
            return { status: 'failed', error: error.message };
        }
    }

    /**
     * 查询饿了么操作记录并提取销售变化
     * @private
     * @returns {Object} {barcode: {totalChange: number}}
     */
    async _queryChanges(elemeClient, startTime, endTime, side) {
        let allLogs = [];
        let pageNumber = 1;
        const pageSize = 100;

        // 分页查询所有记录
        while (true) {
            this._checkCancelled();
            
            const logsData = await elemeClient.queryOperationLog(
                startTime,
                endTime,
                pageNumber,
                pageSize
            );

            const total = logsData.total || 0;
            const logs = logsData.data || [];
            allLogs.push(...logs);

            this._log('info', `[${side}饿了么] 查询第${pageNumber}页: ${logs.length}条 (总${total}条)`);

            if (pageNumber * pageSize >= total || logs.length === 0) {
                break;
            }
            pageNumber++;
            await this._sleep(300);
        }

        // 解析操作记录
        const parsedLogs = ElemeParser.parseOperationLogs({ data: allLogs });

        // 过滤：只保留销售订单导致的变化，排除工具同步
        const salesLogs = parsedLogs.filter(log => {
            const opUser = log.op_user || '';
            // 销售订单：包含"订单"
            const isSales = opUser.includes('订单');
            // 工具同步：包含"API"
            const isToolSync = opUser.includes('API');
            
            if (isToolSync) {
                return false; // 排除工具同步
            }
            return isSales;
        });

        this._log('info', `[${side}饿了么] 过滤后: ${salesLogs.length}条销售变化`);

        // 按条形码汇总变化量
        const changes = {};
        for (const log of salesLogs) {
            const barcode = log.barcode;
            if (!barcode || !log.stock_change) continue;

            if (!changes[barcode]) {
                changes[barcode] = { totalChange: 0 };
            }
            changes[barcode].totalChange += log.stock_change.change;
        }

        return changes;
    }

    /**
     * 将变化应用到目标牵牛花
     * @private
     * @returns {Object} {success: number, failed: number, failedRecords: Array}
     */
    async _applyChanges(changes, qnhClient, storeId, direction) {
        const barcodes = Object.keys(changes);
        const failedRecords = [];
        
        if (barcodes.length === 0) {
            return { success: 0, failed: 0, failedRecords: [] };
        }

        // 查询目标牵牛花的当前库存
        this._log('info', `[${direction}] 查询目标库存...`);
        const stockData = await qnhClient.getStockByBarcodes(storeId, barcodes);

        // 准备更新数据
        const updates = [];
        const updateDetails = []; // 保存更新详情，用于失败时记录

        for (const barcode of barcodes) {
            const change = changes[barcode];
            const targetInfo = stockData[barcode];

            if (!targetInfo) {
                this._log('warn', `[${direction}] 未找到条形码 ${barcode} 的商品`);
                failedRecords.push({
                    direction,
                    barcode,
                    changeAmount: change.totalChange,
                    currentStock: '-',
                    targetStock: '-',
                    reason: '未找到商品'
                });
                continue;
            }

            // 计算新库存 = 当前库存 + 变化量
            const currentStock = targetInfo.stock;
            const newStock = Math.max(0, currentStock + change.totalChange);

            this._log('info', `[${direction}] ${barcode}: ${currentStock} + (${change.totalChange}) = ${newStock}`);

            updates.push({
                skuId: targetInfo.skuId,
                newQuantity: newStock,
                comment: `双向增量同步(${direction}): ${change.totalChange >= 0 ? '+' : ''}${change.totalChange}`
            });
            
            updateDetails.push({
                barcode,
                skuId: targetInfo.skuId,
                currentStock,
                changeAmount: change.totalChange,
                targetStock: newStock
            });
        }

        if (updates.length === 0) {
            return { success: 0, failed: failedRecords.length, failedRecords };
        }

        // 调试模式：只打印日志，不执行实际更新
        if (this.debugMode) {
            this._log('warn', `⚠️ 调试模式：跳过 ${updates.length} 个商品的实际更新`);
            this._log('info', '--- 调试模式：以下商品将被更新（实际未执行）---');
            for (const detail of updateDetails) {
                this._log('info', `  [${direction}] ${detail.barcode}: 库存 ${detail.currentStock} → ${detail.targetStock} (变化量: ${detail.changeAmount >= 0 ? '+' : ''}${detail.changeAmount})`);
            }
            this._log('info', '--- 调试模式结束 ---');
            
            return {
                success: updates.length, // 模拟全部成功
                failed: failedRecords.length,
                failedRecords
            };
        }

        // 批量更新
        this._log('info', `[${direction}] 更新 ${updates.length} 个商品...`);
        
        const batchSize = 10;
        let successCount = 0;

        for (let i = 0; i < updates.length; i += batchSize) {
            this._checkCancelled();
            
            const batch = updates.slice(i, i + batchSize);
            const batchDetails = updateDetails.slice(i, i + batchSize);
            
            try {
                const success = await qnhClient.batchUpdateMultipleSkus(storeId, batch, `双向增量同步(${direction})`);
                if (success) {
                    successCount += batch.length;
                } else {
                    // 整批失败
                    for (const detail of batchDetails) {
                        failedRecords.push({
                            direction,
                            barcode: detail.barcode,
                            changeAmount: detail.changeAmount,
                            currentStock: detail.currentStock,
                            targetStock: detail.targetStock,
                            reason: '更新失败'
                        });
                    }
                }
            } catch (error) {
                this._log('error', `[${direction}] 批次更新失败: ${error.message}`);
                // 记录失败
                for (const detail of batchDetails) {
                    failedRecords.push({
                        direction,
                        barcode: detail.barcode,
                        changeAmount: detail.changeAmount,
                        currentStock: detail.currentStock,
                        targetStock: detail.targetStock,
                        reason: error.message
                    });
                }
            }

            if (i + batchSize < updates.length) {
                await this._sleep(500);
            }
        }

        return {
            success: successCount,
            failed: failedRecords.length,
            failedRecords
        };
    }

    /**
     * 导出失败记录到 Excel
     * @private
     * @param {Array} failedRecords - 失败记录数组
     * @returns {string|null} 导出的文件路径
     */
    _exportFailedRecords(failedRecords) {
        if (!failedRecords || failedRecords.length === 0) {
            return null;
        }

        try {
            // 准备 Excel 数据
            const excelData = failedRecords.map(record => ({
                '同步方向': record.direction,
                '条形码': record.barcode,
                '变化量': record.changeAmount,
                '当前库存': record.currentStock,
                '目标库存': record.targetStock,
                '失败原因': record.reason
            }));

            // 创建工作簿
            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.json_to_sheet(excelData);
            
            // 设置列宽
            ws['!cols'] = [
                { wch: 10 },  // 同步方向
                { wch: 20 },  // 条形码
                { wch: 10 },  // 变化量
                { wch: 10 },  // 当前库存
                { wch: 10 },  // 目标库存
                { wch: 30 }   // 失败原因
            ];
            
            XLSX.utils.book_append_sheet(wb, ws, '失败记录');

            // 确保导出目录存在（使用之前保存的目录或默认目录）
            const dataDir = this._exportDir || path.join(__dirname, '..', 'data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            // 生成文件名
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = `dual_sync_failed_${this.groupId}_${timestamp}.xlsx`;
            const filePath = path.join(dataDir, filename);

            // 写入文件
            XLSX.writeFile(wb, filePath);
            
            this._log('warn', `失败记录已导出到: ${filePath}`);
            return filePath;
        } catch (error) {
            this._log('error', `导出失败记录时出错: ${error.message}`);
            return null;
        }
    }
}

module.exports = DualSyncEngine;

