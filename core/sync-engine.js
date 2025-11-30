/**
 * 同步引擎 - 实现饿了么到牵牛花的库存同步
 * 负责单个组的全量/增量同步逻辑
 */

const ElemeClient = require('../api/eleme-client');
const createQnhClient = require('../api/qnh-client-factory');
const ProductMatcher = require('./product-matcher');
const { ElemeParser, QianniuhuaParser } = require('../utils/parsers');
const path = require('path');
const fs = require('fs');

class SyncEngine {
    /**
     * 初始化同步引擎
     * @param {number} groupId - 组ID
     * @param {Object} elemeConfig - 饿了么配置
     * @param {Object} qnhConfig - 牵牛花配置
     * @param {Object} database - 数据库实例
     * @param {Function} logCallback - 日志回调函数
     * @param {Function} progressCallback - 进度回调函数
     * @param {boolean} debugMode - 调试模式（不执行实际更新）
     */
    constructor(groupId, elemeConfig, qnhConfig, database, logCallback = null, progressCallback = null, debugMode = false) {
        this.groupId = groupId;
        this.db = database;
        this.logCallback = logCallback;
        this.progressCallback = progressCallback;
        this.debugMode = debugMode;
        this._cancelRequested = false;

        // 初始化API客户端
        this.elemeClient = new ElemeClient(elemeConfig);
        this.qnhClient = createQnhClient(null, qnhConfig);
        
        // 初始化匹配器
        this.matcher = new ProductMatcher();
        
        // 牵牛花门店信息
        this.qnhStoreId = qnhConfig.store_id;
        this.qnhStores = null;
        
        this._log('info', `同步引擎初始化完成 (组ID: ${groupId})`);
    }

    /**
     * 请求取消当前同步
     */
    cancel() {
        this._cancelRequested = true;
        this._log('warn', '收到终止同步指令，正在安全中止...');
    }

    /**
     * 如果已取消则抛出异常以中断流程
     * @private
     */
    _checkCancelled() {
        if (this._cancelRequested) {
            const error = new Error('sync_cancelled');
            error.code = 'SYNC_CANCELLED';
            throw error;
        }
    }

    /**
     * 确保牵牛花门店ID为数字
     * 数据库历史数据可能将门店名称误存到 qnh_store_id，这里自动纠正
     * @private
     */
    async _ensureNumericQnhStoreId() {
        const idStr = this.qnhStoreId ? String(this.qnhStoreId).trim() : '';
        if (/^\d+$/.test(idStr)) {
            return; // 已是数字
        }

        // 加载门店映射（id->name）
        await this._loadQnhStores();

        // 从数据库读取当前组，尝试用名称反查ID
        const group = this.db.getGroup(this.groupId);
        const candidateName = (idStr || (group && group.qnh_store_name) || '').trim();

        if (!candidateName) {
            this._log('error', '未配置牵牛花门店，请先在UI中选择门店');
            throw new Error('未配置牵牛花门店');
        }

        let resolvedId = null;
        for (const [storeId, storeName] of Object.entries(this.qnhStores || {})) {
            if (storeName === candidateName) {
                resolvedId = storeId;
                break;
            }
        }

        if (!resolvedId) {
            this._log('error', `无法根据门店名称反查ID: ${candidateName}，请在UI中重新选择门店`);
            throw new Error(`牵牛花门店无效: ${candidateName}`);
        }

        // 写回数据库并更新内存中的ID
        this.db.updateGroup(this.groupId, {
            qnh_store_id: resolvedId,
            qnh_store_name: this.qnhStores[resolvedId]
        });
        this.qnhStoreId = resolvedId;
        this._log('info', `已自动纠正牵牛花门店ID: ${candidateName} -> ${resolvedId}`);
    }

    /**
     * 日志输出
     * @private
     */
    _log(level, message) {
        const logMessage = `[SyncEngine][组${this.groupId}] ${message}`;
        console.log(logMessage);
        
        if (this.logCallback) {
            this.logCallback(this.groupId, level, message);
        }
    }

    /**
     * 进度更新
     * @private
     */
    _updateProgress(progress, message = '') {
        if (this.progressCallback) {
            this.progressCallback(this.groupId, progress, message);
        }
    }

    /**
     * 将Date格式化为标准北京时间字符串 YYYY-MM-DD HH:mm:ss
     * 使用 Asia/Shanghai 时区，避免手动偏移计算误差
     * @private
     */
    _formatBeijing(date) {
        try {
            const parts = new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).formatToParts(date);

            const get = (type) => parts.find(p => p.type === type)?.value || '00';
            const year = get('year');
            const month = get('month');
            const day = get('day');
            const hour = get('hour');
            const minute = get('minute');
            const second = get('second');
            return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
        } catch (e) {
            // 回退：使用本地时间，尽力格式化
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            const hh = String(date.getHours()).padStart(2, '0');
            const mm = String(date.getMinutes()).padStart(2, '0');
            const ss = String(date.getSeconds()).padStart(2, '0');
            return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
        }
    }

    /**
     * 延时
     * @private
     */
    async _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 加载牵牛花门店信息
     * @private
     */
    async _loadQnhStores() {
        if (!this.qnhStores) {
            this._log('info', '加载牵牛花门店信息...');
            this.qnhStores = await this.qnhClient.getStores();
            this._log('info', `已加载 ${Object.keys(this.qnhStores).length} 个门店`);
        }
    }

    /**
     * 全量同步
     * 
     * 流程:
     * 1. 导出饿了么商品Excel
     * 2. 导出牵牛花商品Excel
     * 3. 比对两个Excel找出库存不一致的商品
     * 4. 批量更新牵牛花库存
     * 
     * @param {string} exportDir - 导出目录
     * @returns {Object} 同步结果
     */
    async fullSync(exportDir = 'data') {
        // 重置取消标记，允许新的同步正常开始
        this._cancelRequested = false;
        const startTime = new Date();
        const syncId = this.db.addSyncHistory(this.groupId, 'full', startTime, 'running');

        try {
            this._log('info', '==================== 开始全量同步 ====================');
            this._updateProgress(0, '开始全量同步...');

            // 纠正可能的门店ID错误
            await this._ensureNumericQnhStoreId();
            
            // 确保导出目录存在
            if (!fs.existsSync(exportDir)) {
                fs.mkdirSync(exportDir, { recursive: true });
            }

            this._checkCancelled();
            // 步骤1: 导出饿了么商品 (0% -> 20%)
            this._log('info', '步骤1: 从饿了么导出商品...');
            this._updateProgress(0, '导出饿了么商品...');
            const elemePath = path.join(exportDir, `group_${this.groupId}_eleme_${Date.now()}.xlsx`);
            const elemeExportJob = await this.elemeClient.exportProducts(elemePath, {
                shouldCancel: () => this._cancelRequested,
                log: (level, message) => this._log(level, message)
            });
            this._log('info', `饿了么商品导出完成: ${elemePath}`);
            this._updateProgress(20, '饿了么商品导出完成');

            // 记录导出任务创建时间（作为后续增量的起点候选）
            try {
                if (elemeExportJob && elemeExportJob.gmtCreate) {
                    const exportCreatedAt = new Date(elemeExportJob.gmtCreate.replace(/-/g, '/'));
                    if (!isNaN(exportCreatedAt.getTime())) {
                        this.db.updateGroup(this.groupId, {
                            last_full_export_time: exportCreatedAt.toISOString()
                        });
                        this._log('info', `记录全量导出创建时间: ${this._formatBeijing(exportCreatedAt)}`);
                    } else {
                        this._log('warn', `导出创建时间解析失败: ${elemeExportJob.gmtCreate}`);
                    }
                } else {
                    this._log('warn', '未获取到导出创建时间 gmtCreate，跳过记录');
                }
            } catch (e) {
                this._log('warn', `记录导出创建时间异常: ${e.message}`);
            }

            // 步骤2: 解析饿了么商品
            this._log('info', '步骤2: 解析饿了么商品...');
            const elemeProducts = ElemeParser.parseExcel(elemePath);
            this._log('info', `解析到 ${elemeProducts.length} 个饿了么商品`);

            this._checkCancelled();
            // 步骤3: 导出牵牛花商品 (20% -> 40%)
            this._log('info', '步骤3: 从牵牛花导出商品...');
            this._updateProgress(20, '导出牵牛花商品...');
            const qnhPath = path.join(exportDir, `group_${this.groupId}_qnh_${Date.now()}.xlsx`);
            const exportResult = await this.qnhClient.exportProducts(this.qnhStoreId, qnhPath, 2, {
                shouldCancel: () => this._cancelRequested,
                log: (level, message) => this._log(level, message)
            });
            
            let qnhProducts = [];
            
            if (exportResult) {
                // 导出成功，解析Excel
                this._log('info', `牵牛花商品导出完成: ${qnhPath}`);
                this._updateProgress(40, '牵牛花商品导出完成');
                
                this._checkCancelled();
                // 步骤4: 解析牵牛花商品
                this._log('info', '步骤4: 解析牵牛花商品...');
                const parsed = QianniuhuaParser.parseExportExcel(qnhPath);
                // 兼容两种返回：数组 或 映射对象
                if (Array.isArray(parsed)) {
                    qnhProducts = parsed;
                } else if (parsed && typeof parsed === 'object') {
                    qnhProducts = Object.entries(parsed).map(([barcode, skuId]) => ({
                        barcode,
                        skuId,
                        stock: 0
                    }));
                } else {
                    qnhProducts = [];
                }
                this._log('info', `解析到 ${qnhProducts.length} 个牵牛花商品`);
            } else {
                // 导出失败（达到重试上限），使用分页接口作为回退方案
                this._log('warn', '⚠️ 牵牛花导出失败（已达重试上限），切换到分页接口获取商品');
                this._updateProgress(30, '导出失败，使用分页接口...');
                
                // 使用分页接口获取商品映射
                this._log('info', '步骤4: 使用分页接口获取牵牛花商品映射...');
                const qnhMapping = await this.qnhClient.getProductsMapping(this.qnhStoreId, false); // false表示不使用导出
                
                // 将映射转换为products格式（与Excel解析结果一致）
                qnhProducts = Object.entries(qnhMapping).map(([barcode, skuId]) => ({
                    barcode: barcode,
                    skuId: skuId,
                    stock: 0 // 分页接口不返回库存，设为0（后续比对时只更新饿了么有变化的商品）
                }));
                
                this._log('info', `通过分页接口获取到 ${qnhProducts.length} 个牵牛花商品`);
                this._updateProgress(40, `分页获取完成（${qnhProducts.length}个商品）`);
            }

            this._checkCancelled();
            // 步骤5: 比对库存找出差异 (40% -> 50%)
            this._log('info', '步骤5: 比对库存找出差异...');
            this._updateProgress(40, '比对库存差异...');
            const differences = this.matcher.compareStocks(elemeProducts, qnhProducts);
            this._updateProgress(50, `发现${differences.length}个商品需要更新`);
            
            if (differences.length === 0) {
                this._log('info', '没有库存差异，无需同步');
                
                this.db.updateSyncHistory(syncId, {
                    endTime: new Date(),
                    status: 'success',
                    totalItems: 0,
                    successItems: 0,
                    failedItems: 0
                });

                return {
                    status: 'success',
                    message: 'no_differences',
                    totalProducts: elemeProducts.length,
                    totalDifferences: 0,
                    successItems: 0,
                    failedItems: 0
                };
            }

            this._log('info', `发现 ${differences.length} 个商品库存不一致，准备同步...`);

            // 调试模式：直接跳过批处理，快速完成
            if (this.debugMode) {
                this._log('warn', '⚠️ 调试模式：跳过库存更新批处理，直接完成');
                this._updateProgress(100, '调试模式：同步完成（未执行实际更新）');

                const endTime = new Date();
                const duration = ((endTime - startTime) / 1000).toFixed(1);

                this.db.updateSyncHistory(syncId, {
                    endTime: endTime,
                    status: 'success',
                    totalItems: differences.length,
                    successItems: differences.length,
                    failedItems: 0
                });

                const result = {
                    status: 'success',
                    startTime: startTime,
                    endTime: endTime,
                    duration: parseFloat(duration),
                    totalProducts: elemeProducts.length,
                    totalDifferences: differences.length,
                    successItems: differences.length,
                    failedItems: 0,
                    successRate: '100%'
                };

                this._log('info', '==================== 全量同步完成（调试模式） ====================');
                return result;
            }

            // 步骤6: 批量更新库存（10个SKU一组）(50% -> 100%)
            this._log('info', '步骤6: 批量更新牵牛花库存...');
            const batchSize = 10;
            let successCount = 0;
            let failedCount = 0;
            const totalBatches = Math.ceil(differences.length / batchSize);

            for (let i = 0; i < differences.length; i += batchSize) {
                this._checkCancelled();
                const batchIndex = Math.floor(i / batchSize) + 1;
                const batch = differences.slice(i, i + batchSize);
                
                // 更新进度 (50% + 当前批次进度)
                const currentProgress = 50 + (batchIndex / totalBatches) * 50;
                this._updateProgress(currentProgress, `批量更新 ${batchIndex}/${totalBatches}`);
                
                this._log('info', `处理批次 ${batchIndex}/${totalBatches} (${batch.length} 个商品)...`);

                const skuUpdates = batch.map(d => ({
                    skuId: d.skuId,
                    newQuantity: d.elemeStock,
                    comment: `全量同步: ${d.qnhStock} -> ${d.elemeStock}`
                }));

                try {
                    // 调试模式下跳过实际更新
                    let success;
                    if (this.debugMode) {
                        this._log('warn', `⚠️ 调试模式：跳过批次 ${batchIndex} 的实际更新`);
                        success = true; // 模拟成功
                    } else {
                        success = await this.qnhClient.batchUpdateMultipleSkus(
                            this.qnhStoreId,
                            skuUpdates,
                            '全量同步'
                        );
                    }

                    if (success) {
                        successCount += batch.length;
                        
                        // ✅ 优化：成功时不再记录操作日志，减少数据库写入
                        // 仅保存商品映射
                        for (const item of batch) {
                            this.db.saveProductMapping(
                                this.groupId,
                                item.barcode,
                                item.skuId,
                                item.name
                            );
                        }
                        
                        this._log('info', `批次 ${batchIndex} 更新成功`);
                    } else {
                        failedCount += batch.length;
                        this._log('error', `批次 ${batchIndex} 更新失败`);
                        
                        // 记录失败日志
                        for (const item of batch) {
                            this.db.addOperationLog(
                                this.groupId,
                                'full_sync',
                                item.barcode,
                                item.qnhStock,
                                item.elemeStock,
                                this.qnhStoreId,
                                false,
                                '批量更新失败'
                            );
                        }
                    }

                    // 延时避免频繁请求
                    if (i + batchSize < differences.length) {
                        this._checkCancelled();
                        await this._sleep(500);
                    }

                } catch (error) {
                    this._log('error', `批次 ${batchIndex} 更新异常: ${error.message}`);
                    failedCount += batch.length;
                    
                    // 记录异常日志
                    for (const item of batch) {
                        this.db.addOperationLog(
                            this.groupId,
                            'full_sync',
                            item.barcode,
                            item.qnhStock,
                            item.elemeStock,
                            this.qnhStoreId,
                            false,
                            error.message
                        );
                    }
                }
            }

            // 步骤7: 更新同步历史
            const endTime = new Date();
            const duration = ((endTime - startTime) / 1000).toFixed(1);

            this.db.updateSyncHistory(syncId, {
                endTime: endTime,
                status: 'success',
                totalItems: differences.length,
                successItems: successCount,
                failedItems: failedCount
            });

            const result = {
                status: 'success',
                startTime: startTime,
                endTime: endTime,
                duration: parseFloat(duration),
                totalProducts: elemeProducts.length,
                totalDifferences: differences.length,
                successItems: successCount,
                failedItems: failedCount,
                successRate: differences.length > 0 ? ((successCount / differences.length) * 100).toFixed(2) + '%' : '100%'
            };

            this._updateProgress(100, '全量同步完成');
            this._log('info', '==================== 全量同步完成 ====================');
            this._log('info', `耗时: ${duration}秒`);
            this._log('info', `商品总数: ${elemeProducts.length}`);
            this._log('info', `库存差异: ${differences.length}`);
            this._log('info', `更新成功: ${successCount}`);
            this._log('info', `更新失败: ${failedCount}`);
            this._log('info', `成功率: ${result.successRate}`);
            
            if (this.debugMode) {
                this._log('warn', '⚠️ 调试模式：未执行实际库存更新');
            }

            return result;

        } catch (error) {
            this._log('error', `全量同步失败: ${error.message}`);
            console.error(error);

            this._updateProgress(-1, `同步失败: ${error.message}`);

            this.db.updateSyncHistory(syncId, {
                endTime: new Date(),
                status: error.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed',
                errorMsg: error.message
            });

            return error.code === 'SYNC_CANCELLED' ? {
                status: 'cancelled'
            } : {
                status: 'failed',
                error: error.message,
                stack: error.stack
            };
        }
    }

    /**
     * 增量同步
     * 
     * 流程:
     * 1. 查询饿了么操作记录（支持分页）
     * 2. 解析库存变化
     * 3. 根据条形码批量查询牵牛花SKU
     * 4. 批量更新牵牛花库存
     * 
     * @param {number} timeRange - 查询时间范围（秒）
     * @param {number} startTime - 开始时间（秒级时间戳），null则自动计算
     * @returns {Object} 同步结果
     */
    async incrementalSync(timeRange = 3600, startTime = null) {
        // 重置取消标记，允许新的同步正常开始
        this._cancelRequested = false;
        const syncStart = new Date();
        const syncId = this.db.addSyncHistory(this.groupId, 'incremental', syncStart, 'running');

        try {
            this._log('info', '==================== 开始增量同步 ====================');
            this._updateProgress(0, '开始增量同步...');

            // 纠正可能的门店ID错误
            await this._ensureNumericQnhStoreId();

            // 步骤1: 确定查询时间范围（修正：使用“全量导出创建时间”和“上次增量查询开始时间”的较新者）
            if (!startTime) {
                // 读取组信息中的标记
                const group = this.db.getGroup(this.groupId) || {};

                let lastFullExport = null;
                if (group.last_full_export_time) {
                    const t = new Date(group.last_full_export_time);
                    if (!isNaN(t.getTime())) lastFullExport = t;
                }

                let lastIncrQueryStarted = null;
                if (group.last_incr_query_started_at) {
                    const t = new Date(group.last_incr_query_started_at);
                    if (!isNaN(t.getTime())) lastIncrQueryStarted = t;
                }

                // 兼容旧逻辑：若上述两者都不存在，则退回“上次成功结束时间”（仅在无标记时生效）
                const lastFullEnd = this.db.getLastSyncTime(this.groupId, 'full');
                const lastIncrEnd = this.db.getLastSyncTime(this.groupId, 'incremental');

                const markCandidates = [lastFullExport, lastIncrQueryStarted].filter(Boolean);
                let base = null;
                let baseSource = '';

                if (markCandidates.length > 0) {
                    base = markCandidates.reduce((a, b) => (a > b ? a : b));
                    baseSource = (base === lastIncrQueryStarted) ? 'last_incr_query_started_at' : 'last_full_export_time';
                } else {
                    const fallback = (lastFullEnd && lastIncrEnd)
                        ? (lastFullEnd > lastIncrEnd ? lastFullEnd : lastIncrEnd)
                        : (lastFullEnd || lastIncrEnd);
                    if (!fallback) {
                        this._log('warn', '未检测到历史基线，请先执行一次全量同步');
                        this._updateProgress(-1, '需要先执行一次全量同步');
                        this.db.updateSyncHistory(syncId, {
                            endTime: new Date(),
                            status: 'failed',
                            errorMsg: 'require_full_sync_first'
                        });
                        return { status: 'failed', error: 'require_full_sync_first' };
                    }
                    base = fallback;
                    baseSource = 'fallback_last_success_end_time';
                }

                if (!base) {
                    this._log('warn', '未检测到历史基线，请先执行一次全量同步');
                    this._updateProgress(-1, '需要先执行一次全量同步');
                    this.db.updateSyncHistory(syncId, {
                        endTime: new Date(),
                        status: 'failed',
                        errorMsg: 'require_full_sync_first'
                    });
                    return { status: 'failed', error: 'require_full_sync_first' };
                }
                startTime = Math.floor(base.getTime() / 1000);

                this._log('info', `使用增量起点(来源=${baseSource}): ${this._formatBeijing(new Date(startTime * 1000))}`);
            }

            const endTime = Math.floor(Date.now() / 1000);
            const timeRangeMinutes = ((endTime - startTime) / 60).toFixed(1);

            // 若时间区间超过3小时（180分钟），提示需要先做全量
            if ((endTime - startTime) > 3 * 3600) {
                const msg = '增量起始时间距离当前超过3小时，请先执行一次全量同步';
                this._log('warn', msg);
                this._updateProgress(-1, '需要先执行一次全量同步（区间>3小时）');
                this.db.updateSyncHistory(syncId, {
                    endTime: new Date(),
                    status: 'failed',
                    errorMsg: 'require_full_sync_due_to_time_range'
                });
                return { status: 'failed', error: 'require_full_sync_due_to_time_range' };
            }

            // 日志：以秒级时间戳为主，同时展示标准北京时间
            this._log('info', `查询时间范围(时间戳秒): ${startTime} 到 ${endTime}`);
            const startDate = new Date(startTime * 1000);
            const endDate = new Date(endTime * 1000);
            this._log('info', `北京时间: ${this._formatBeijing(startDate)} 到 ${this._formatBeijing(endDate)}`);
            this._log('info', `时长: ${timeRangeMinutes} 分钟`);

            this._checkCancelled();
            // 在真正发起查询前先记录“本次增量查询开始时间”（仅在成功完成后落库）
            const thisIncrQueryStartedAt = new Date();

            // 步骤2: 查询操作记录（支持分页）(0% -> 30%)
            this._log('info', '步骤1: 查询饿了么操作记录...');
            this._updateProgress(0, '查询操作记录...');
            let allLogs = [];
            let pageNumber = 1;
            const pageSize = 100;

            while (true) {
                this._checkCancelled();
                const logsData = await this.elemeClient.queryOperationLog(
                    startTime,
                    endTime,
                    pageNumber,
                    pageSize
                );

                const total = logsData.total || 0;
                const logs = logsData.data || [];
                allLogs.push(...logs);

                this._log('info', `查询第 ${pageNumber} 页: ${logs.length} 条记录 (总数: ${total})`);

                // 判断是否还有下一页
                if (pageNumber * pageSize >= total || logs.length === 0) {
                    break;
                }

                pageNumber++;
                
                // 分页请求间隔
                if (pageNumber <= Math.ceil(total / pageSize)) {
                    await this._sleep(300);
                }
            }

            this._log('info', `共查询到 ${allLogs.length} 条操作记录`);
            this._updateProgress(30, `查询到${allLogs.length}条记录`);

            if (allLogs.length === 0) {
                this._log('info', '没有操作记录，无需同步');
                
                this.db.updateSyncHistory(syncId, {
                    endTime: new Date(),
                    status: 'success',
                    totalItems: 0,
                    successItems: 0,
                    failedItems: 0
                });
                
                this._updateProgress(100, '无需同步');

                return {
                    status: 'success',
                    message: 'no_logs',
                    totalLogs: 0,
                    stockChanges: 0,
                    affectedProducts: 0,
                    successItems: 0,
                    failedItems: 0
                };
            }

            this._checkCancelled();
            // 步骤3: 解析库存变化 (30% -> 40%)
            this._log('info', '步骤2: 解析库存变化...');
            this._updateProgress(30, '解析库存变化...');
            const parsedLogs = ElemeParser.parseOperationLogs({ data: allLogs });
            this._log('info', `解析出 ${parsedLogs.length} 条有效库存变化`);
            this._updateProgress(40, `解析出${parsedLogs.length}条变化`);

            if (parsedLogs.length === 0) {
                this._log('info', '没有库存变化，无需同步');
                
                this.db.updateSyncHistory(syncId, {
                    endTime: new Date(),
                    status: 'success',
                    totalItems: 0,
                    successItems: 0,
                    failedItems: 0
                });

                return {
                    status: 'success',
                    message: 'no_changes',
                    totalLogs: allLogs.length,
                    stockChanges: 0,
                    affectedProducts: 0,
                    successItems: 0,
                    failedItems: 0
                };
            }

            this._checkCancelled();
            // 步骤4: 按条形码分组
            this._log('info', '步骤3: 按条形码分组...');
            const grouped = ElemeParser.groupStockChangesByBarcode(parsedLogs);
            this._log('info', `涉及 ${Object.keys(grouped).length} 个商品`);

            this._checkCancelled();
            // 步骤5: 根据条形码查询牵牛花SKU (40% -> 50%)
            this._log('info', '步骤4: 查询牵牛花SKU...');
            this._updateProgress(40, '查询SKU映射...');
            const barcodes = Object.keys(grouped);
            const skuIdMap = await this.qnhClient.getSkuIdsByBarcodes(this.qnhStoreId, barcodes);
            this._log('info', `查询到 ${Object.keys(skuIdMap).length} 个SKU映射`);
            this._updateProgress(50, `查询到${Object.keys(skuIdMap).length}个SKU`);

            // 步骤6: 准备批量更新
            this._log('info', '步骤5: 准备批量更新...');
            const updates = [];
            let unmatchedCount = 0;

            for (const [barcode, data] of Object.entries(grouped)) {
                const skuId = skuIdMap[barcode];
                
                if (!skuId) {
                    this._log('warn', `未找到条形码 ${barcode} 的SKU`);
                    unmatchedCount++;
                    continue;
                }

                updates.push({
                    barcode: barcode,
                    skuId: skuId,
                    newQuantity: data.final_stock,
                    changeCount: data.change_count,
                    comment: `增量同步: ${data.change_count}次变化`
                });
            }

            if (updates.length === 0) {
                this._log('info', '没有需要更新的商品');
                
                this.db.updateSyncHistory(syncId, {
                    endTime: new Date(),
                    status: 'success',
                    totalItems: 0,
                    successItems: 0,
                    failedItems: 0
                });

                return {
                    status: 'success',
                    message: 'no_updates',
                    totalLogs: allLogs.length,
                    stockChanges: parsedLogs.length,
                    affectedProducts: 0,
                    unmatchedProducts: unmatchedCount,
                    successItems: 0,
                    failedItems: 0
                };
            }

            this._log('info', `准备更新 ${updates.length} 个商品 (未匹配: ${unmatchedCount})`);

            // 调试模式：直接跳过批处理，快速完成
            if (this.debugMode) {
                this._log('warn', '⚠️ 调试模式：跳过库存更新批处理，直接完成');
                this._updateProgress(100, '调试模式：同步完成（未执行实际更新）');

                const syncEnd = new Date();
                const duration = ((syncEnd - syncStart) / 1000).toFixed(1);

                this.db.updateSyncHistory(syncId, {
                    endTime: syncEnd,
                    status: 'success',
                    totalItems: updates.length,
                    successItems: updates.length,
                    failedItems: 0
                });

                // 调试模式下同样写入“本次增量查询开始时间”，用于下次作为起点
                try {
                    this.db.updateGroup(this.groupId, {
                        last_incr_query_started_at: thisIncrQueryStartedAt.toISOString()
                    });
                } catch (e) {
                    this._log('warn', `写入增量查询开始时间失败: ${e.message}`);
                }

                const result = {
                    status: 'success',
                    startTime: syncStart,
                    endTime: syncEnd,
                    duration: parseFloat(duration),
                    totalLogs: allLogs.length,
                    stockChanges: parsedLogs.length,
                    affectedProducts: updates.length,
                    unmatchedProducts: unmatchedCount,
                    successItems: updates.length,
                    failedItems: 0,
                    successRate: updates.length > 0 ? '100%' : '100%'
                };

                this._log('info', '==================== 增量同步完成（调试模式） ====================');
                return result;
            }

            // 步骤7: 批量更新库存（10个SKU一组）(50% -> 100%)
            this._log('info', '步骤6: 批量更新牵牛花库存...');
            const batchSize = 10;
            let successCount = 0;
            let failedCount = 0;
            const totalBatches = Math.ceil(updates.length / batchSize);

            for (let i = 0; i < updates.length; i += batchSize) {
                this._checkCancelled();
                const batchIndex = Math.floor(i / batchSize) + 1;
                const batch = updates.slice(i, i + batchSize);
                
                // 更新进度 (50% + 当前批次进度)
                const currentProgress = 50 + (batchIndex / totalBatches) * 50;
                this._updateProgress(currentProgress, `批量更新 ${batchIndex}/${totalBatches}`);
                
                this._log('info', `处理批次 ${batchIndex}/${totalBatches} (${batch.length} 个商品)...`);

                const skuUpdates = batch.map(u => ({
                    skuId: u.skuId,
                    newQuantity: u.newQuantity,
                    comment: u.comment
                }));

                try {
                    // 调试模式下跳过实际更新
                    let success;
                    if (this.debugMode) {
                        this._log('warn', `⚠️ 调试模式：跳过批次 ${batchIndex} 的实际更新`);
                        success = true; // 模拟成功
                    } else {
                        success = await this.qnhClient.batchUpdateMultipleSkus(
                            this.qnhStoreId,
                            skuUpdates,
                            '增量同步'
                        );
                    }

                    if (success) {
                        successCount += batch.length;
                        
                        // ✅ 优化：成功时不再记录操作日志，减少数据库写入
                        // 仅保存商品映射
                        for (const item of batch) {
                            this.db.saveProductMapping(
                                this.groupId,
                                item.barcode,
                                item.skuId
                            );
                        }
                        
                        this._log('info', `批次 ${batchIndex} 更新成功`);
                    } else {
                        failedCount += batch.length;
                        this._log('error', `批次 ${batchIndex} 更新失败`);
                        
                        // 记录失败日志
                        for (const item of batch) {
                            this.db.addOperationLog(
                                this.groupId,
                                'incremental_sync',
                                item.barcode,
                                null,
                                item.newQuantity,
                                this.qnhStoreId,
                                false,
                                '批量更新失败'
                            );
                        }
                    }

                    // 延时避免频繁请求
                    if (i + batchSize < updates.length) {
                        this._checkCancelled();
                        await this._sleep(500);
                    }

                } catch (error) {
                    this._log('error', `批次 ${batchIndex} 更新异常: ${error.message}`);
                    failedCount += batch.length;
                    
                    // 记录异常日志
                    for (const item of batch) {
                        this.db.addOperationLog(
                            this.groupId,
                            'incremental_sync',
                            item.barcode,
                            null,
                            item.newQuantity,
                            this.qnhStoreId,
                            false,
                            error.message
                        );
                    }
                }
            }

            // 步骤8: 更新同步历史
            const syncEnd = new Date();
            const duration = ((syncEnd - syncStart) / 1000).toFixed(1);

            this.db.updateSyncHistory(syncId, {
                endTime: syncEnd,
                status: 'success',
                totalItems: updates.length,
                successItems: successCount,
                failedItems: failedCount
            });

            // 成功后写入“本次增量查询开始时间”，用于下次起点
            try {
                this.db.updateGroup(this.groupId, {
                    last_incr_query_started_at: thisIncrQueryStartedAt.toISOString()
                });
            } catch (e) {
                this._log('warn', `写入增量查询开始时间失败: ${e.message}`);
            }

            const result = {
                status: 'success',
                startTime: syncStart,
                endTime: syncEnd,
                duration: parseFloat(duration),
                totalLogs: allLogs.length,
                stockChanges: parsedLogs.length,
                affectedProducts: updates.length,
                unmatchedProducts: unmatchedCount,
                successItems: successCount,
                failedItems: failedCount,
                successRate: updates.length > 0 ? ((successCount / updates.length) * 100).toFixed(2) + '%' : '100%'
            };

            this._updateProgress(100, '增量同步完成');
            this._log('info', '==================== 增量同步完成 ====================');
            this._log('info', `耗时: ${duration}秒`);
            this._log('info', `操作记录: ${allLogs.length} 条`);
            this._log('info', `库存变化: ${parsedLogs.length} 条`);
            this._log('info', `涉及商品: ${updates.length} 个`);
            this._log('info', `未匹配: ${unmatchedCount} 个`);
            this._log('info', `更新成功: ${successCount}`);
            this._log('info', `更新失败: ${failedCount}`);
            this._log('info', `成功率: ${result.successRate}`);
            
            if (this.debugMode) {
                this._log('warn', '⚠️ 调试模式：未执行实际库存更新');
            }

            return result;

        } catch (error) {
            this._log('error', `增量同步失败: ${error.message}`);
            console.error(error);

            this._updateProgress(-1, `同步失败: ${error.message}`);

            this.db.updateSyncHistory(syncId, {
                endTime: new Date(),
                status: error.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed',
                errorMsg: error.message
            });

            return error.code === 'SYNC_CANCELLED' ? {
                status: 'cancelled'
            } : {
                status: 'failed',
                error: error.message,
                stack: error.stack
            };
        }
    }

    /**
     * 获取统计信息
     * @returns {Object} 统计信息
     */
    getStats() {
        return this.db.getSyncStats(this.groupId);
    }
}

module.exports = SyncEngine;

