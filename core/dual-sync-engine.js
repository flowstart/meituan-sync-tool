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
const { toLocalISOString } = require('../utils/time-utils');
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
            
            // 初始化失败记录
            const failedRecords = [];

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
            
            // 记录导出结束时间（作为后续增量同步的起点）
            // 这个时间点之后的销售变化才需要通过增量同步处理
            const exportEndTime = new Date();
            this._log('info', `导出结束时间: ${toLocalISOString(exportEndTime)}（将作为增量同步起点）`);
            
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

            // 【已优化】步骤3.1: 获取B牵牛花当前库存
            // 全量同步是覆盖式同步，不需要计算变化量。
            // 失败时只需记录目标库存(targetStock)即可，无需当前库存(currentStock)。
            // 之前此步骤耗时较长（9000+商品需5分钟），现已移除以提升性能。
            // 如需调试查看变化量，可临时恢复以下代码：
            // this._log('info', '步骤3.1: 获取B牵牛花当前库存...');
            // this._progress(55, '查询B牵牛花库存...');
            // const mappedBarcodes = barcodes.filter(b => qnhBMapping[b]);
            // const bStockData = mappedBarcodes.length > 0
            //     ? await this.qnhB.getStockByBarcodes(this.qnhBStoreId, mappedBarcodes)
            //     : {};

            // 步骤4: 准备更新数据
            this._log('info', '步骤4: 准备更新数据...');
            this._progress(60, '准备更新数据...');
            
            const updatesB = [];
            const updateDetailsB = []; // 保存更新详情（全量同步不含当前库存/变化量），用于调试/失败记录

            for (const product of elemeProducts) {
                const barcode = product.barcode;
                const stock = product.stock;
                const name = product.name || '';
                
                if (!barcode) continue;

                // 只同步到B牵牛花
                const skuIdB = qnhBMapping[barcode];
                if (!skuIdB) {
                    // 未找到映射：写入失败明细，便于人工修复
                    failedRecords.push({
                        direction: 'A→B',
                        barcode,
                        changeAmount: null,
                        currentStock: null,
                        targetStock: stock,
                        reason: '未找到SKU映射'
                    });
                    // 写入双向失败日志（用于"查看失败日志"）
                    this.db.addDualOperationLog(
                        this.groupId,
                        'dual_full_sync',
                        barcode,
                        null,
                        typeof stock === 'number' ? stock : null,
                        this.qnhBStoreId,
                        false,
                        '未找到SKU映射'
                    );
                    continue;
                }

                // 【已优化】不再查询B当前库存，全量同步直接覆盖
                // 原逻辑：const targetInfo = bStockData[barcode]; 判断商品是否存在
                // 现在：只要有SKU映射就直接更新，更新失败会在批量更新阶段捕获
                const targetStock = stock;

                updatesB.push({
                    skuId: skuIdB,
                    newQuantity: stock,
                    comment: `全量同步(A→B)`
                });
                updateDetailsB.push({
                    barcode,
                    name,
                    skuId: skuIdB,
                    currentStock: null,  // 全量同步不查询当前库存
                    targetStock,
                    changeAmount: null   // 全量同步不计算变化量
                });
            }

            this._log('info', `准备更新: B牵牛花 ${updatesB.length} 个`);
            
            this._checkCancelled();

            let successB = 0;
            const successSnapshotsB = [];

            // 调试模式：只打印日志，不执行实际更新
            if (this.debugMode) {
                this._log('warn', '⚠️ 调试模式：跳过实际库存更新');
                
                // 打印B牵牛花更新详情（最多显示20条）
                // 【已优化】全量同步不再查询当前库存，只显示目标库存
                this._log('info', '--- 调试模式：B牵牛花将更新以下商品（实际未执行）---');
                const showCountB = Math.min(updateDetailsB.length, 20);
                for (let i = 0; i < showCountB; i++) {
                    const d = updateDetailsB[i];
                    this._log('info', `  ${d.barcode}: 目标库存 ${d.targetStock}`);
                }
                if (updateDetailsB.length > 20) {
                    this._log('info', `  ... 还有 ${updateDetailsB.length - 20} 个商品`);
                }
                this._log('info', '--- 调试模式结束 ---');
                
                successB = updatesB.length;
                this._progress(85, '调试模式：跳过更新');
            } else {
                // 步骤5: 分批更新B牵牛花
                this._log('info', '步骤5: 更新B牵牛花...');
                this._progress(80, '更新B牵牛花...');
                
                if (updatesB.length > 0) {
                    // 分批处理，每批10个商品
                    const batchSize = 10;
                    let failedB = 0;
                    const totalBatches = Math.ceil(updatesB.length / batchSize);
                    
                    for (let i = 0; i < updatesB.length; i += batchSize) {
                        this._checkCancelled();
                        
                        const batchIndex = Math.floor(i / batchSize) + 1;
                        const batch = updatesB.slice(i, i + batchSize);
                        const batchDetails = updateDetailsB.slice(i, i + batchSize);
                        
                        // 计算进度：80% - 95% 之间
                        const currentProgress = 80 + (batchIndex / totalBatches) * 15;
                        this._progress(currentProgress, `批量更新 ${batchIndex}/${totalBatches}`);
                        
                        try {
                            const success = await this.qnhB.batchUpdateMultipleSkus(
                                this.qnhBStoreId, 
                                batch, 
                                `WEB-全量同步(A→B)`
                            );
                            
                            if (success) {
                                successB += batch.length;
                                // 记录成功快照（用于后续核对）
                                for (const detail of batchDetails) {
                                    if (typeof detail.targetStock === 'number') {
                                        successSnapshotsB.push({
                                            barcode: detail.barcode,
                                            stock: detail.targetStock,
                                            productName: detail.name || null
                                        });
                                    }
                                }
                            } else {
                                failedB += batch.length;
                                this._log('error', `批次 ${batchIndex} 更新失败`);
                                // 记录失败详情
                                for (const detail of batchDetails) {
                                    failedRecords.push({
                                        direction: 'A→B',
                                        barcode: detail.barcode,
                                        changeAmount: detail.changeAmount ?? null,
                                        currentStock: detail.currentStock ?? null,
                                        targetStock: detail.targetStock ?? null,
                                        reason: '批量更新失败'
                                    });
                                    this.db.addDualOperationLog(
                                        this.groupId,
                                        'dual_full_sync',
                                        detail.barcode,
                                        typeof detail.currentStock === 'number' ? detail.currentStock : null,
                                        typeof detail.targetStock === 'number' ? detail.targetStock : null,
                                        this.qnhBStoreId,
                                        false,
                                        '批量更新失败'
                                    );
                                }
                            }
                        } catch (error) {
                            this._log('error', `批次 ${batchIndex} 更新异常: ${error.message}`);
                            failedB += batch.length;
                            // 记录失败详情
                            for (const detail of batchDetails) {
                                failedRecords.push({
                                    direction: 'A→B',
                                    barcode: detail.barcode,
                                    changeAmount: detail.changeAmount ?? null,
                                    currentStock: detail.currentStock ?? null,
                                    targetStock: detail.targetStock ?? null,
                                    reason: error.message
                                });
                                this.db.addDualOperationLog(
                                    this.groupId,
                                    'dual_full_sync',
                                    detail.barcode,
                                    typeof detail.currentStock === 'number' ? detail.currentStock : null,
                                    typeof detail.targetStock === 'number' ? detail.targetStock : null,
                                    this.qnhBStoreId,
                                    false,
                                    error.message
                                );
                            }
                        }
                        
                        // 批次间延迟，避免请求过快
                        if (i + batchSize < updatesB.length) {
                            await this._sleep(500);
                        }
                    }
                    
                    this._log('info', `B牵牛花更新完成: 成功 ${successB}, 失败 ${failedB}`);
                }
            }

            // 步骤6: 记录同步时间
            const now = new Date();
            this.db.updateDualSyncGroup(this.groupId, {
                last_full_sync_time: toLocalISOString(now),
                // 使用导出结束时间作为增量同步的起点
                // 导出数据是在这个时间点的快照，之后的销售变化需要通过增量同步处理
                last_a_query_time: toLocalISOString(exportEndTime),
                // B侧基线使用“全量同步完成时间”，避免下一次增量查询到全量同步引发的 API 回流记录
                last_b_query_time: toLocalISOString(now)
            });

            const duration = ((now - startTime) / 1000).toFixed(1);
            this._progress(100, this.debugMode ? '调试模式：全量同步完成（未执行实际更新）' : '全量同步完成');
            this._log('info', '==================== 全量同步完成(A→B) ====================');
            this._log('info', `耗时: ${duration}秒`);
            this._log('info', `B牵牛花更新: ${successB}/${updatesB.length}`);
            if (this.debugMode) {
                this._log('warn', '⚠️ 调试模式：未执行实际库存更新');
            }
            
            // 如果有失败记录，导出到文件
            if (failedRecords.length > 0) {
                this._log('warn', `有 ${failedRecords.length} 个商品更新失败`);
                this._exportFailedRecords(failedRecords);
            }

            // 成功后写入库存快照（仅非调试模式）
            if (!this.debugMode && successSnapshotsB.length > 0) {
                this.db.saveDualSyncStockSnapshotBatch(this.groupId, successSnapshotsB);
                this._log('info', `已写入库存快照: ${successSnapshotsB.length} 条`);
            }

            return {
                status: 'success',
                duration: parseFloat(duration),
                updatesB: successB,
                failedCount: failedRecords.length
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
     * @param {string} exportDir - 导出目录（可选，默认使用 data 子目录）
     */
    async incrementalSync(exportDir) {
        this._cancelled = false;
        const startTime = new Date();
        
        // 保存 exportDir 供失败记录导出使用
        this._exportDir = exportDir;
        // 双向同步历史记录（用于追踪与指纹回流过滤）
        const historyId = this.db.addDualSyncHistory(this.groupId, 'incremental', startTime, 'running');

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
            const lastAApplyStartTime = group.last_a_apply_start_time;
            const lastAApplyEndTime = group.last_a_apply_end_time;
            const lastBApplyStartTime = group.last_b_apply_start_time;
            const lastBApplyEndTime = group.last_b_apply_end_time;

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

            // 计算“工具写入窗口”对应的指纹过滤集合（用于过滤回流的【API】【子门店】）
            const TOOL_DELAY_MS = 30 * 60 * 1000; // 你观测的最大落地延迟：<=30分钟
            const TOOL_PAD_BEFORE_MS = 5 * 60 * 1000;
            const buildFingerprintSet = (destSide, applyStartIso, applyEndIso) => {
                try {
                    if (!applyStartIso || !applyEndIso) return null;
                    const s = new Date(applyStartIso);
                    const e = new Date(applyEndIso);
                    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
                    const windowStart = toLocalISOString(new Date(s.getTime() - TOOL_PAD_BEFORE_MS));
                    const windowEnd = toLocalISOString(new Date(e.getTime() + TOOL_DELAY_MS));
                    const set = this.db.getDualSyncAppliedFingerprints(this.groupId, destSide, windowStart, windowEnd);
                    this._log('info', `[指纹过滤] destSide=${destSide}, window=${windowStart}~${windowEnd}, 指纹数=${set.size}`);
                    return set;
                } catch (e) {
                    return null;
                }
            };

            // 查询 A 侧饿了么时，需要过滤“上一轮 B→A 写入”回流（destSide=A）
            const aFingerprintSet = buildFingerprintSet('A', lastAApplyStartTime, lastAApplyEndTime);
            // 查询 B 侧饿了么时，需要过滤“上一轮 A→B 写入”回流（destSide=B）
            const bFingerprintSet = buildFingerprintSet('B', lastBApplyStartTime, lastBApplyEndTime);

            // 打印查询时间范围（方便核对）
            this._log('info', `查询时间范围: ${toLocalISOString(new Date(aStartTime * 1000))} ~ ${toLocalISOString(new Date(now * 1000))}`);
            this._log('info', `时间戳(秒): startTime=${aStartTime}, endTime=${now}`);

            // 步骤1: 查询A饿了么操作记录
            this._log('info', '步骤1: 查询A饿了么操作记录...');
            this._progress(10, '查询A饿了么变化...');
            
            const aElemeChanges = await this._queryChanges(this.elemeA, aStartTime, now, 'A', { excludeFingerprints: aFingerprintSet });
            this._log('info', `A饿了么提取到 ${Object.keys(aElemeChanges).length} 个商品变化`);

            this._checkCancelled();

            // 步骤2: 查询B饿了么操作记录
            this._log('info', '步骤2: 查询B饿了么操作记录...');
            this._progress(20, '查询B饿了么变化...');
            
            const bChanges = await this._queryChanges(this.elemeB, bStartTime, now, 'B', { excludeFingerprints: bFingerprintSet });
            this._log('info', `B饿了么提取到 ${Object.keys(bChanges).length} 个商品变化`);

            this._checkCancelled();

            // 计算各侧总变化数
            const aTotal = Object.keys(aElemeChanges).length;
            const bTotal = Object.keys(bChanges).length;

            // 如果都没有变化，直接返回
            if (aTotal === 0 && bTotal === 0) {
                this._log('info', '没有库存变化，无需同步');
                
                // 更新查询时间和增量同步信息
                this.db.updateDualSyncGroup(this.groupId, {
                    last_a_query_time: toLocalISOString(new Date(now * 1000)),
                    last_b_query_time: toLocalISOString(new Date(now * 1000)),
                    last_incr_sync_time: toLocalISOString(),
                    last_incr_sync_count: 0
                });

                // 更新历史记录
                this.db.updateDualSyncHistory(historyId, {
                    endTime: new Date(),
                    status: 'success',
                    aChanges: aTotal,
                    bChanges: bTotal,
                    totalItems: 0,
                    successItems: 0,
                    failedItems: 0
                });

                this._progress(100, '无需同步');
                return { status: 'success', message: 'no_changes' };
            }

            this._checkCancelled();

            // 分别记录各来源的同步结果
            let aElemeSuccess = 0, aElemeFailed = 0;
            let bSuccess = 0, bFailed = 0;
            let allFailedRecords = [];

            // 步骤3.1: 同步A饿了么变化到B
            if (Object.keys(aElemeChanges).length > 0) {
                this._log('info', '步骤3.1: 同步A饿了么变化到B...');
                this._progress(40, '同步A饿了么→B...');
                
                // 记录 B 侧写入窗口（用于下一次查询 B 饿了么时过滤回流）
                let bApplyStartIso = null;
                if (!this.debugMode) {
                    bApplyStartIso = toLocalISOString(new Date());
                    this.db.updateDualSyncGroup(this.groupId, { last_b_apply_start_time: bApplyStartIso });
                }

                const result = await this._applyChanges(
                    aElemeChanges,
                    this.qnhB,
                    this.qnhBStoreId,
                    'A饿了么→B',
                    {
                        syncRunId: historyId,
                        destSide: 'B',
                        directionCode: 'A->B'
                    }
                );
                aElemeSuccess = result.success;
                aElemeFailed = result.failed;
                allFailedRecords = allFailedRecords.concat(result.failedRecords || []);
                this._log('info', `A饿了么→B: 成功${aElemeSuccess}个, 失败${aElemeFailed}个`);

                if (!this.debugMode) {
                    const bApplyEndIso = toLocalISOString(new Date());
                    this.db.updateDualSyncGroup(this.groupId, { last_b_apply_end_time: bApplyEndIso });
                }
            }

            this._checkCancelled();

            // 步骤4: 同步B饿了么变化到A
            if (Object.keys(bChanges).length > 0) {
                this._log('info', '步骤4: 同步B饿了么变化到A...');
                this._progress(80, '同步B饿了么→A...');
                
                // 记录 A 侧写入窗口（用于下一次查询 A 饿了么时过滤回流）
                let aApplyStartIso = null;
                if (!this.debugMode) {
                    aApplyStartIso = toLocalISOString(new Date());
                    this.db.updateDualSyncGroup(this.groupId, { last_a_apply_start_time: aApplyStartIso });
                }

                const result = await this._applyChanges(
                    bChanges,
                    this.qnhA,
                    this.qnhAStoreId,
                    'B饿了么→A',
                    {
                        syncRunId: historyId,
                        destSide: 'A',
                        directionCode: 'B->A'
                    }
                );
                bSuccess = result.success;
                bFailed = result.failed;
                allFailedRecords = allFailedRecords.concat(result.failedRecords || []);
                this._log('info', `B饿了么→A: 成功${bSuccess}个, 失败${bFailed}个`);

                if (!this.debugMode) {
                    const aApplyEndIso = toLocalISOString(new Date());
                    this.db.updateDualSyncGroup(this.groupId, { last_a_apply_end_time: aApplyEndIso });
                }
            }

            // 汇总统计
            const totalSuccess = aElemeSuccess + bSuccess;
            const totalFailed = aElemeFailed + bFailed;

            // 步骤5: 导出失败记录（如果有）
            let failedExcelPath = null;
            if (allFailedRecords.length > 0) {
                this._log('warn', `有 ${allFailedRecords.length} 条记录同步失败，正在导出...`);
                failedExcelPath = this._exportFailedRecords(allFailedRecords);
            }

            // 步骤6: 更新查询时间和增量同步信息
            this.db.updateDualSyncGroup(this.groupId, {
                last_a_query_time: toLocalISOString(new Date(now * 1000)),
                last_b_query_time: toLocalISOString(new Date(now * 1000)),
                last_incr_sync_time: toLocalISOString(),
                last_incr_sync_count: totalSuccess
            });

            // 更新双向同步历史
            this.db.updateDualSyncHistory(historyId, {
                endTime: new Date(),
                status: totalFailed === 0 ? 'success' : 'partial',
                aChanges: aTotal,
                bChanges: bTotal,
                totalItems: totalSuccess + totalFailed,
                successItems: totalSuccess,
                failedItems: totalFailed,
                errorMsg: totalFailed === 0 ? null : `partial_failed:${totalFailed}`
            });

            const duration = ((new Date() - startTime) / 1000).toFixed(1);
            this._progress(100, this.debugMode ? '调试模式：增量同步完成（未执行实际更新）' : '增量同步完成');
            this._log('info', '==================== 双向增量同步完成 ====================');
            this._log('info', `耗时: ${duration}秒`);
            this._log('info', '--- A侧→B同步结果 ---');
            this._log('info', `  饿了么: 成功${aElemeSuccess}个, 失败${aElemeFailed}个`);
            this._log('info', '--- B侧→A同步结果 ---');
            this._log('info', `  饿了么: 成功${bSuccess}个, 失败${bFailed}个`);
            this._log('info', `--- 总计 ---`);
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
                aElemeChanges: Object.keys(aElemeChanges).length,
                aElemeSuccess,
                aElemeFailed,
                bChanges: Object.keys(bChanges).length,
                bSuccess,
                bFailed,
                failedExcelPath
            };

        } catch (error) {
            if (error.code === 'SYNC_CANCELLED') {
                this._log('warn', '增量同步已取消');
                this.db.updateDualSyncHistory(historyId, { endTime: new Date(), status: 'failed', errorMsg: 'SYNC_CANCELLED' });
                return { status: 'cancelled' };
            }
            this._log('error', `增量同步失败: ${error.message}`);
            this.db.updateDualSyncHistory(historyId, { endTime: new Date(), status: 'failed', errorMsg: error.message });
            return { status: 'failed', error: error.message };
        }
    }

    /**
     * 查询饿了么操作记录并提取销售变化
     * @private
     * @returns {Object} {barcode: {totalChange: number}}
     */
    async _queryChanges(elemeClient, startTime, endTime, side, options = {}) {
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

        // 不再按 opUser 过滤（API/订单无法区分工具与非工具），后续使用“指纹+时间窗”过滤工具回流
        const candidateLogs = parsedLogs;
        this._log('info', `[${side}饿了么] 候选库存变化: ${candidateLogs.length}条（不按opUser过滤）`);

        // 去重：按条形码 + 旧库存 + 新库存 去重，避免重复记录导致重复扣减
        // 对于多规格商品，每个规格单独去重
        const seenKeys = new Set();
        const skippedLogs = []; // 记录因字段缺失而跳过的记录
        const changes = {}; // 直接在这里汇总，避免重复遍历
        let totalProcessed = 0;
        let duplicateCount = 0;
        let multiSpecCount = 0;
        let filteredByFingerprint = 0;
        const excludeFingerprints = options && options.excludeFingerprints instanceof Set ? options.excludeFingerprints : null;
        
        for (const log of candidateLogs) {
            // 多规格商品处理
            if (log.is_multi_spec && log.stock_changes_by_barcode) {
                multiSpecCount++;
                const specBarcodes = Object.keys(log.stock_changes_by_barcode);
                
                for (const barcode of specBarcodes) {
                    const stockChange = log.stock_changes_by_barcode[barcode];
                    
                    // 构建去重键：条形码_旧库存_新库存
                    const dedupeKey = `${barcode}_${stockChange.old_stock}_${stockChange.new_stock}`;

                    // 工具回流过滤：命中指纹则跳过
                    if (excludeFingerprints && excludeFingerprints.has(dedupeKey)) {
                        filteredByFingerprint++;
                        continue;
                    }
                    
                    if (seenKeys.has(dedupeKey)) {
                        duplicateCount++;
                        continue;
                    }
                    
                    seenKeys.add(dedupeKey);
                    totalProcessed++;
                    
                    // 汇总变化量
                    if (!changes[barcode]) {
                        changes[barcode] = { totalChange: 0 };
                    }
                    changes[barcode].totalChange += stockChange.change;
                }
                continue;
            }
            
            // 单规格商品处理
            // 检查必要字段是否存在
            if (!log.barcode) {
                skippedLogs.push({
                    reason: '条形码缺失',
                    op_time: log.op_time,
                    op_user: log.op_user,
                    op_content: log.op_content ? log.op_content.substring(0, 100) : ''
                });
                continue;
            }
            
            if (!log.stock_change) {
                skippedLogs.push({
                    reason: '库存变化解析失败',
                    barcode: log.barcode,
                    op_time: log.op_time,
                    op_user: log.op_user,
                    op_content: log.op_content ? log.op_content.substring(0, 100) : ''
                });
                continue;
            }
            
            // 构建去重键：条形码_旧库存_新库存
            const dedupeKey = `${log.barcode}_${log.stock_change.old_stock}_${log.stock_change.new_stock}`;

            // 工具回流过滤：命中指纹则跳过
            if (excludeFingerprints && excludeFingerprints.has(dedupeKey)) {
                filteredByFingerprint++;
                continue;
            }
            
            if (seenKeys.has(dedupeKey)) {
                duplicateCount++;
                continue;
            }
            
            seenKeys.add(dedupeKey);
            totalProcessed++;
            
            // 汇总变化量
            if (!changes[log.barcode]) {
                changes[log.barcode] = { totalChange: 0 };
            }
            changes[log.barcode].totalChange += log.stock_change.change;
        }
        
        // 记录跳过的记录
        if (skippedLogs.length > 0) {
            this._log('warn', `[${side}饿了么] ⚠️ 有 ${skippedLogs.length} 条记录因字段缺失被跳过，库存变化未计算！`);
            for (const skipped of skippedLogs) {
                this._log('warn', `  - 原因: ${skipped.reason}, 条形码: ${skipped.barcode || '无'}, 操作人: ${skipped.op_user || '无'}, 时间: ${skipped.op_time || '无'}`);
            }
        }
        
        // 输出统计信息
        if (multiSpecCount > 0) {
            this._log('info', `[${side}饿了么] 多规格商品: ${multiSpecCount} 条记录`);
        }
        if (duplicateCount > 0) {
            this._log('info', `[${side}饿了么] 去重: 移除 ${duplicateCount} 条重复记录`);
        }
        if (filteredByFingerprint > 0) {
            this._log('info', `[${side}饿了么] 指纹过滤: 移除 ${filteredByFingerprint} 条工具回流记录`);
        }
        this._log('info', `[${side}饿了么] 有效变化: ${totalProcessed} 条，涉及 ${Object.keys(changes).length} 个商品`);

        return changes;
    }

    /**
     * 合并多个变化源的库存变化
     * @private
     * @param {...Object} changeSources - 多个变化对象 {barcode: {totalChange: number}}
     * @returns {Object} 合并后的变化 {barcode: {totalChange: number}}
     */
    _mergeChanges(...changeSources) {
        const merged = {};
        
        for (const source of changeSources) {
            if (!source || typeof source !== 'object') continue;
            
            for (const barcode in source) {
                const change = source[barcode];
                if (!merged[barcode]) {
                    merged[barcode] = { totalChange: 0 };
                }
                merged[barcode].totalChange += change.totalChange || 0;
            }
        }
        
        // 过滤掉总变化为0的条目
        const filtered = {};
        for (const barcode in merged) {
            if (merged[barcode].totalChange !== 0) {
                filtered[barcode] = merged[barcode];
            }
        }
        
        return filtered;
    }

    /**
     * 将变化应用到目标牵牛花
     * @private
     * @returns {Object} {success: number, failed: number, failedRecords: Array}
     */
    async _applyChanges(changes, qnhClient, storeId, direction, options = {}) {
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
                this.db.addDualOperationLog(
                    this.groupId,
                    'dual_incr_sync',
                    barcode,
                    null,
                    null,
                    storeId,
                    false,
                    `[${direction}] 未找到商品`
                );
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
                    // 写入库存快照（用于后续核对）
                    const snapshots = batchDetails
                        .filter(d => typeof d.targetStock === 'number')
                        .map(d => ({ barcode: d.barcode, stock: d.targetStock, productName: null }));
                    if (snapshots.length > 0) {
                        this.db.saveDualSyncStockSnapshotBatch(this.groupId, snapshots);
                    }

                    // 写入指纹（用于过滤下一次饿了么回流记录）
                    if (!this.debugMode && options && options.destSide) {
                        const appliedAt = toLocalISOString(new Date());
                        const items = batchDetails
                            .filter(d => d && d.barcode && typeof d.currentStock === 'number' && typeof d.targetStock === 'number')
                            .map(d => ({
                                barcode: d.barcode,
                                oldStock: d.currentStock,
                                newStock: d.targetStock,
                                appliedAt
                            }));
                        if (items.length > 0) {
                            this.db.addDualSyncAppliedChanges(
                                this.groupId,
                                options.syncRunId || null,
                                options.destSide,
                                options.directionCode || null,
                                items
                            );
                        }
                    }
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
                        this.db.addDualOperationLog(
                            this.groupId,
                            'dual_incr_sync',
                            detail.barcode,
                            typeof detail.currentStock === 'number' ? detail.currentStock : null,
                            typeof detail.targetStock === 'number' ? detail.targetStock : null,
                            storeId,
                            false,
                            `[${direction}] 更新失败`
                        );
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
                    this.db.addDualOperationLog(
                        this.groupId,
                        'dual_incr_sync',
                        detail.barcode,
                        typeof detail.currentStock === 'number' ? detail.currentStock : null,
                        typeof detail.targetStock === 'number' ? detail.targetStock : null,
                        storeId,
                        false,
                        `[${direction}] ${error.message}`
                    );
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
            const baseDir = this._exportDir || path.join(__dirname, '..', 'data');
            
            // 按天分目录存放：data/failed/2025-12-19/
            const now = new Date();
            // 使用本地时间（北京时间）
            const { toLocalDateString, toLocalTimeString } = require('../utils/time-utils');
            const dateStr = toLocalDateString(now);
            const failedDir = path.join(baseDir, 'failed', dateStr);
            if (!fs.existsSync(failedDir)) {
                fs.mkdirSync(failedDir, { recursive: true });
            }

            // 生成文件名（使用本地时间）
            const timeStr = toLocalTimeString(now).replace(/:/g, '-');
            const filename = `dual_sync_failed_${this.groupId}_${timeStr}.xlsx`;
            const filePath = path.join(failedDir, filename);

            // 写入文件
            XLSX.writeFile(wb, filePath);
            
            this._log('warn', `失败记录已导出到: "${filePath}"`);
            return filePath;
        } catch (error) {
            this._log('error', `导出失败记录时出错: ${error.message}`);
            return null;
        }
    }
}

module.exports = DualSyncEngine;

