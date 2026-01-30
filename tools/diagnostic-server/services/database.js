/**
 * 数据库读取服务
 * 只读模式访问 sync.db，提供诊断查询功能
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class DatabaseService {
    /**
     * @param {string} dbPath - 数据库文件路径
     * @param {string} dataDir - data 目录路径（用于读取追溯日志）
     */
    constructor(dbPath, dataDir) {
        this.dbPath = dbPath;
        this.dataDir = dataDir;
        
        // 以只读模式打开数据库
        this.db = new Database(dbPath, { readonly: true });
        
        console.log(`[DatabaseService] 数据库已打开: ${dbPath}`);
    }

    /**
     * 关闭数据库连接
     */
    close() {
        if (this.db) {
            this.db.close();
            console.log('[DatabaseService] 数据库已关闭');
        }
    }

    // ==================== 同步组查询 ====================

    /**
     * 获取所有双向同步组
     */
    getAllDualSyncGroups() {
        const stmt = this.db.prepare('SELECT * FROM dual_sync_groups ORDER BY id');
        return stmt.all();
    }

    /**
     * 获取指定双向同步组
     */
    getDualSyncGroup(groupId) {
        const stmt = this.db.prepare('SELECT * FROM dual_sync_groups WHERE id = ?');
        return stmt.get(groupId);
    }

    // ==================== 同步历史查询 ====================

    /**
     * 获取双向同步历史
     */
    getDualSyncHistory(groupId = null, limit = 100, offset = 0) {
        let sql = 'SELECT * FROM dual_sync_history';
        const params = [];
        
        if (groupId) {
            sql += ' WHERE group_id = ?';
            params.push(groupId);
        }
        
        sql += ' ORDER BY start_time DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        
        const stmt = this.db.prepare(sql);
        return stmt.all(...params);
    }

    /**
     * 获取同步历史统计
     */
    getDualSyncHistoryStats(groupId = null) {
        let whereClause = groupId ? 'WHERE group_id = ?' : '';
        const params = groupId ? [groupId] : [];

        // 总体统计
        const totalStmt = this.db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) as partial,
                SUM(success_items) as total_success_items,
                SUM(failed_items) as total_failed_items
            FROM dual_sync_history ${whereClause}
        `);
        const total = totalStmt.get(...params);

        // 按日期统计
        const dailyStmt = this.db.prepare(`
            SELECT 
                DATE(start_time) as date,
                COUNT(*) as count,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
            FROM dual_sync_history ${whereClause}
            GROUP BY DATE(start_time)
            ORDER BY date DESC
            LIMIT 30
        `);
        const daily = dailyStmt.all(...params);

        return { total, daily };
    }

    // ==================== 追溯查询 ====================

    /**
     * 按条形码查询追溯记录
     */
    getTraceByBarcode(groupId, barcode, limit = 500) {
        // 1. 查询最近一次全量同步基准
        const fullSyncStmt = this.db.prepare(`
            SELECT * FROM dual_sync_trace
            WHERE group_id = ? AND barcode = ? AND sync_type = 'full'
            ORDER BY created_at DESC
            LIMIT 1
        `);
        const fullSyncBaseline = fullSyncStmt.get(groupId, barcode) || null;

        // 2. 确定查询起始时间
        let sinceTime = null;
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        if (fullSyncBaseline) {
            sinceTime = fullSyncBaseline.created_at < thirtyDaysAgo 
                ? thirtyDaysAgo 
                : fullSyncBaseline.created_at;
        } else {
            sinceTime = thirtyDaysAgo;
        }

        // 3. 查询增量同步记录
        const incrStmt = this.db.prepare(`
            SELECT * FROM dual_sync_trace
            WHERE group_id = ? AND barcode = ? AND sync_type = 'incremental'
              AND created_at >= ?
            ORDER BY created_at ASC
            LIMIT ?
        `);
        const incrementalRecords = incrStmt.all(groupId, barcode, sinceTime, limit);

        return {
            fullSyncBaseline,
            incrementalRecords,
            isFullSyncOlderThan30Days: fullSyncBaseline && fullSyncBaseline.created_at < thirtyDaysAgo
        };
    }

    /**
     * 按同步批次查询追溯记录
     */
    getTraceByRun(groupId, syncRunId) {
        const stmt = this.db.prepare(`
            SELECT * FROM dual_sync_trace
            WHERE group_id = ? AND sync_run_id = ?
            ORDER BY barcode, direction
        `);
        return stmt.all(groupId, syncRunId);
    }

    /**
     * 获取所有有追溯记录的条形码列表
     */
    getTracedBarcodes(groupId, limit = 100) {
        const stmt = this.db.prepare(`
            SELECT DISTINCT barcode, 
                   MAX(product_name) as product_name,
                   COUNT(*) as record_count,
                   MAX(created_at) as last_sync_time
            FROM dual_sync_trace
            WHERE group_id = ?
            GROUP BY barcode
            ORDER BY last_sync_time DESC
            LIMIT ?
        `);
        return stmt.all(groupId, limit);
    }

    // ==================== 库存快照查询 ====================

    /**
     * 获取库存快照
     */
    getStockSnapshots(groupId) {
        const stmt = this.db.prepare(`
            SELECT barcode, last_known_stock as stock, product_name, last_sync_time as updated_at
            FROM dual_sync_stock_snapshot
            WHERE group_id = ?
            ORDER BY barcode
        `);
        return stmt.all(groupId);
    }

    /**
     * 获取库存快照统计
     */
    getStockSnapshotStats(groupId) {
        const stmt = this.db.prepare(`
            SELECT 
                COUNT(*) as total_products,
                SUM(last_known_stock) as total_stock,
                AVG(last_known_stock) as avg_stock,
                MIN(last_sync_time) as oldest_update,
                MAX(last_sync_time) as newest_update
            FROM dual_sync_stock_snapshot
            WHERE group_id = ?
        `);
        return stmt.get(groupId);
    }

    // ==================== 失败记录分析 ====================

    /**
     * 获取失败操作日志
     */
    getFailedOperationLogs(groupId = null, limit = 100) {
        let sql = 'SELECT * FROM dual_operation_log WHERE success = 0';
        const params = [];
        
        if (groupId) {
            sql += ' AND group_id = ?';
            params.push(groupId);
        }
        
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        
        const stmt = this.db.prepare(sql);
        return stmt.all(...params);
    }

    /**
     * 获取失败原因统计
     */
    getFailureReasonStats(groupId = null) {
        let whereClause = 'WHERE success = 0';
        const params = [];
        
        if (groupId) {
            whereClause += ' AND group_id = ?';
            params.push(groupId);
        }

        const stmt = this.db.prepare(`
            SELECT 
                error_msg,
                COUNT(*) as count,
                COUNT(DISTINCT barcode) as unique_barcodes
            FROM dual_operation_log
            ${whereClause}
            GROUP BY error_msg
            ORDER BY count DESC
        `);
        return stmt.all(...params);
    }

    /**
     * 获取高频失败商品
     */
    getFrequentlyFailedProducts(groupId = null, limit = 50) {
        let whereClause = 'WHERE success = 0';
        const params = [];
        
        if (groupId) {
            whereClause += ' AND group_id = ?';
            params.push(groupId);
        }

        const stmt = this.db.prepare(`
            SELECT 
                barcode,
                COUNT(*) as fail_count,
                GROUP_CONCAT(DISTINCT error_msg) as error_types,
                MAX(created_at) as last_fail_time
            FROM dual_operation_log
            ${whereClause}
            GROUP BY barcode
            ORDER BY fail_count DESC
            LIMIT ?
        `);
        params.push(limit);
        return stmt.all(...params);
    }

    // ==================== 诊断分析 ====================

    /**
     * 获取综合诊断报告
     */
    getDiagnosisReport(groupId) {
        const group = this.getDualSyncGroup(groupId);
        if (!group) {
            throw new Error('同步组不存在');
        }

        // 同步历史统计
        const historyStats = this.getDualSyncHistoryStats(groupId);

        // 库存快照统计
        const stockStats = this.getStockSnapshotStats(groupId);

        // 失败原因统计
        const failureStats = this.getFailureReasonStats(groupId);

        // 高频失败商品
        const frequentFailures = this.getFrequentlyFailedProducts(groupId, 20);

        // 最近同步记录
        const recentHistory = this.getDualSyncHistory(groupId, 10);

        // 追溯记录中的异常统计
        const traceAnomalies = this.getTraceAnomalies(groupId);

        return {
            group,
            historyStats,
            stockStats,
            failureStats,
            frequentFailures,
            recentHistory,
            traceAnomalies
        };
    }

    /**
     * 获取追溯记录中的异常统计
     */
    getTraceAnomalies(groupId) {
        // 统计被过滤的记录
        const filteredStmt = this.db.prepare(`
            SELECT 
                filter_reason,
                COUNT(*) as count
            FROM dual_sync_trace
            WHERE group_id = ? AND was_filtered = 1
            GROUP BY filter_reason
            ORDER BY count DESC
        `);
        const filtered = filteredStmt.all(groupId);

        // 统计失败的记录
        const failedStmt = this.db.prepare(`
            SELECT 
                error_msg,
                COUNT(*) as count
            FROM dual_sync_trace
            WHERE group_id = ? AND apply_result = 'failed'
            GROUP BY error_msg
            ORDER BY count DESC
        `);
        const failed = failedStmt.all(groupId);

        // 统计去重的记录
        const dedupStmt = this.db.prepare(`
            SELECT COUNT(*) as count
            FROM dual_sync_trace
            WHERE group_id = ? AND was_deduplicated = 1
        `);
        const dedup = dedupStmt.get(groupId);

        return {
            filtered,
            failed,
            deduplicated: dedup ? dedup.count : 0
        };
    }

    // ==================== 追溯日志文件读取 ====================

    /**
     * 列出追溯日志文件
     */
    listTraceLogs(groupId, limit = 100) {
        const traceDir = path.join(this.dataDir, 'sync_trace', `dual_${groupId}`);
        const logs = [];

        if (!fs.existsSync(traceDir)) {
            return logs;
        }

        try {
            // 遍历日期目录
            const dateDirs = fs.readdirSync(traceDir)
                .filter(d => fs.statSync(path.join(traceDir, d)).isDirectory())
                .sort((a, b) => b.localeCompare(a));

            for (const dateDir of dateDirs) {
                if (logs.length >= limit) break;

                const datePath = path.join(traceDir, dateDir);
                const files = fs.readdirSync(datePath)
                    .filter(f => f.endsWith('.json'))
                    .sort((a, b) => b.localeCompare(a));

                for (const file of files) {
                    if (logs.length >= limit) break;

                    const parts = file.replace('.json', '').split('_');
                    if (parts.length >= 3) {
                        logs.push({
                            syncType: parts[0],
                            syncRunId: parseInt(parts[1], 10),
                            timestamp: parseInt(parts[2], 10),
                            date: dateDir,
                            path: path.join(datePath, file)
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`列出追溯日志失败: ${error.message}`);
        }

        return logs;
    }

    /**
     * 读取追溯日志文件
     */
    readTraceLog(groupId, syncRunId) {
        const traceDir = path.join(this.dataDir, 'sync_trace', `dual_${groupId}`);

        if (!fs.existsSync(traceDir)) {
            return null;
        }

        try {
            const dateDirs = fs.readdirSync(traceDir)
                .filter(d => fs.statSync(path.join(traceDir, d)).isDirectory());

            for (const dateDir of dateDirs) {
                const datePath = path.join(traceDir, dateDir);
                const files = fs.readdirSync(datePath).filter(f => f.endsWith('.json'));

                for (const file of files) {
                    const parts = file.replace('.json', '').split('_');
                    if (parts.length >= 2 && parts[1] === String(syncRunId)) {
                        const filePath = path.join(datePath, file);
                        const content = fs.readFileSync(filePath, 'utf8');
                        return JSON.parse(content);
                    }
                }
            }
        } catch (error) {
            console.error(`读取追溯日志失败: ${error.message}`);
        }

        return null;
    }

    /**
     * 获取指定条形码的原始操作记录（从 JSON 日志中提取）
     * 按门店侧（A 或 B）分别返回，并正确标注状态
     * @param {number} groupId - 组ID
     * @param {string} barcode - 条形码
     * @param {string} side - 门店侧 ('A' 或 'B')
     * @param {string} sinceDate - 开始日期 (YYYY-MM-DD)
     * @returns {Object} { baseline, records, theoreticalStock, storeName }
     */
    getTraceRawRecordsByBarcode(groupId, barcode, side = 'A', sinceDate = null) {
        const traceDir = path.join(this.dataDir, 'sync_trace', `dual_${groupId}`);
        
        // 增量同步方向：A 门店的变化同步给 B (A->B)，B 门店的变化同步给 A (B->A)
        const syncDirection = side === 'A' ? 'A->B' : 'B->A';
        const oppositeSide = side === 'A' ? 'B' : 'A';
        
        const result = {
            baseline: null,           // 全量同步基准
            records: [],              // 原始操作记录列表
            theoreticalStock: null,   // 理论库存（计算值）
            storeName: null           // 门店名称
        };

        // 1. 获取全量同步基准
        // 注意：全量同步是 A->B，所以 A 和 B 门店共享同一个基准
        const fullSyncStmt = this.db.prepare(`
            SELECT * FROM dual_sync_trace
            WHERE group_id = ? AND barcode = ? AND sync_type = 'full'
            ORDER BY created_at DESC
            LIMIT 1
        `);
        result.baseline = fullSyncStmt.get(groupId, barcode) || null;

        // 确定查询起始日期
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        let startDate = sinceDate;
        if (!startDate && result.baseline) {
            startDate = result.baseline.created_at.slice(0, 10);
        }
        if (!startDate) {
            startDate = thirtyDaysAgo.toISOString().slice(0, 10);
        }

        // 初始化理论库存（从全量基准开始）
        let theoreticalStock = result.baseline ? result.baseline.current_stock : null;

        if (!fs.existsSync(traceDir)) {
            result.theoreticalStock = theoreticalStock;
            return result;
        }

        try {
            // 遍历日期目录
            const dateDirs = fs.readdirSync(traceDir)
                .filter(d => {
                    const fullPath = path.join(traceDir, d);
                    if (!fs.statSync(fullPath).isDirectory()) return false;
                    if (d < startDate) return false;
                    return true;
                })
                .sort();

            for (const dateDir of dateDirs) {
                const datePath = path.join(traceDir, dateDir);
                const files = fs.readdirSync(datePath)
                    .filter(f => f.endsWith('.json') && f.startsWith('incremental_'))
                    .sort();

                for (const file of files) {
                    try {
                        const filePath = path.join(datePath, file);
                        const content = fs.readFileSync(filePath, 'utf8');
                        const logData = JSON.parse(content);

                        const syncRunId = logData.syncRunId || parseInt(file.split('_')[1], 10);
                        const syncTime = logData.startTime || dateDir;
                        
                        // 获取当前 side 的查询时间窗口
                        const queryWindow = logData.queryWindow?.[side] || {};
                        const queryStart = queryWindow.start || null;
                        const queryEnd = queryWindow.end || null;

                        // 只获取当前 side 的原始记录
                        const rawList = logData.rawRecords?.[side] || [];
                        
                        // 获取当前 side 的过滤记录
                        const filteredByFingerprint = (logData.filteredRecords?.byFingerprint || [])
                            .filter(r => r.side === side && r.barcode === barcode);
                        const filteredByDedup = (logData.filteredRecords?.byDeduplication || [])
                            .filter(r => r.side === side && r.barcode === barcode);
                        
                        // 获取对应方向的成功/失败记录
                        const successList = (logData.appliedChanges?.[syncDirection]?.success || [])
                            .filter(r => r.barcode === barcode);
                        const failedList = (logData.appliedChanges?.[syncDirection]?.failed || [])
                            .filter(r => r.barcode === barcode);

                        // 构建过滤集合（使用 key: barcode_oldStock_newStock）
                        const filteredKeys = new Set(filteredByFingerprint.map(r => `${r.barcode}_${r.oldStock}_${r.newStock}`));
                        const dedupKeys = new Set(filteredByDedup.map(r => `${r.barcode}_${r.oldStock}_${r.newStock}`));
                        // 成功记录使用 barcode 匹配（因为可能合并了多条变化）
                        const successBarcodes = new Set(successList.map(r => r.barcode));
                        const failedBarcodes = new Set(failedList.map(r => r.barcode));

                        for (const record of rawList) {
                            if (record.barcode !== barcode) continue;

                            const key = `${record.barcode}_${record.oldStock}_${record.newStock}`;
                            let status = 'synced';
                            let statusReason = '';
                            let sourceLabel = '';

                            // 判断状态
                            if (filteredKeys.has(key)) {
                                status = 'filtered';
                                const fr = filteredByFingerprint.find(r => 
                                    r.barcode === barcode && r.oldStock === record.oldStock && r.newStock === record.newStock
                                );
                                statusReason = fr?.filterReason || '指纹过滤';
                                sourceLabel = `来源于${oppositeSide}，回流`;
                            } else if (dedupKeys.has(key)) {
                                status = 'deduplicated';
                                const dr = filteredByDedup.find(r => 
                                    r.barcode === barcode && r.oldStock === record.oldStock && r.newStock === record.newStock
                                );
                                statusReason = dr?.filterReason || '去重';
                            } else if (failedBarcodes.has(barcode)) {
                                status = 'failed';
                                const fr = failedList.find(r => r.barcode === barcode);
                                statusReason = fr?.error || '同步失败';
                            } else if (successBarcodes.has(barcode)) {
                                status = 'synced';
                                statusReason = `已同步到${oppositeSide}`;
                            }

                            // 提取门店名称（从 opUser 中）
                            if (!result.storeName && record.opUser) {
                                const match = record.opUser.match(/【子门店】\s*([^\s]+)/);
                                if (match) {
                                    result.storeName = match[1];
                                }
                            }

                            result.records.push({
                                opType: '修改门店商品',
                                opContent: record.opContent || `库存：${record.oldStock} → ${record.newStock}`,
                                barcode: record.barcode,
                                bizId: record.bizId || '',
                                opTime: record.opTime,
                                opUser: record.opUser || '',
                                oldStock: record.oldStock,
                                newStock: record.newStock,
                                change: record.change,
                                side: side,
                                syncRunId: syncRunId,
                                syncTime: syncTime,
                                queryStart: queryStart,  // 查询起始时间
                                queryEnd: queryEnd,      // 查询结束时间
                                status: status,
                                statusReason: statusReason,
                                sourceLabel: sourceLabel,
                                runningStock: null  // 稍后计算
                            });
                        }
                    } catch (parseError) {
                        console.warn(`解析日志文件失败 ${file}: ${parseError.message}`);
                    }
                }
            }

            // 按时间正序排序，计算每条记录的累计库存
            result.records.sort((a, b) => new Date(a.opTime) - new Date(b.opTime));
            
            let runningStock = result.baseline ? result.baseline.current_stock : null;
            // 用于追踪已计算过的去重记录（同一组重复记录只算一次）
            const countedDedupKeys = new Set();
            
            for (const record of result.records) {
                if (runningStock !== null) {
                    if (record.status === 'deduplicated') {
                        // 去重记录：同一组重复记录只计算一次变化量
                        const dedupKey = `${record.oldStock}_${record.newStock}_${record.change}`;
                        if (!countedDedupKeys.has(dedupKey)) {
                            // 第一次遇到这组去重记录，计入变化量
                            runningStock += record.change || 0;
                            countedDedupKeys.add(dedupKey);
                        }
                        // 后续相同的去重记录跳过
                    } else {
                        // 非去重记录正常累加
                        runningStock += record.change || 0;
                    }
                    record.runningStock = runningStock;
                }
            }
            
            // 最终理论库存
            theoreticalStock = runningStock;
            
            // 按时间倒序排序（最新的在前）
            result.records.sort((a, b) => new Date(b.opTime) - new Date(a.opTime));

        } catch (error) {
            console.error(`获取原始记录失败: ${error.message}`);
        }

        result.theoreticalStock = theoreticalStock;
        return result;
    }

    /**
     * 分页查询所有原始操作记录
     * @param {Object} options - 查询选项
     * @param {number} options.groupId - 组ID
     * @param {string} options.side - 门店 ('A' 或 'B')
     * @param {string} options.barcode - 条形码过滤
     * @param {number} options.oldStock - 老库存过滤
     * @param {number} options.newStock - 新库存过滤
     * @param {number} options.syncRunIdStart - 增量任务ID起始
     * @param {number} options.syncRunIdEnd - 增量任务ID结束
     * @param {number} options.page - 页码 (从1开始)
     * @param {number} options.pageSize - 每页条数
     * @returns {Object} { records, total, page, pageSize, totalPages }
     */
    queryRawRecords(options) {
        const {
            groupId,
            side,
            barcode,
            oldStock,
            newStock,
            syncRunIdStart,
            syncRunIdEnd,
            page = 1,
            pageSize = 100
        } = options;

        const traceDir = path.join(this.dataDir, 'sync_trace', `dual_${groupId}`);
        const allRecords = [];

        if (!fs.existsSync(traceDir)) {
            return { records: [], total: 0, page, pageSize, totalPages: 0 };
        }

        try {
            // 遍历所有日期目录
            const dateDirs = fs.readdirSync(traceDir)
                .filter(d => {
                    const fullPath = path.join(traceDir, d);
                    return fs.statSync(fullPath).isDirectory();
                })
                .sort();

            for (const dateDir of dateDirs) {
                const datePath = path.join(traceDir, dateDir);
                const files = fs.readdirSync(datePath)
                    .filter(f => f.endsWith('.json') && f.startsWith('incremental_'))
                    .sort();

                for (const file of files) {
                    try {
                        const filePath = path.join(datePath, file);
                        const content = fs.readFileSync(filePath, 'utf8');
                        const logData = JSON.parse(content);

                        const syncRunId = logData.syncRunId || parseInt(file.split('_')[1], 10);

                        // 增量任务ID范围过滤
                        if (syncRunIdStart && syncRunId < syncRunIdStart) continue;
                        if (syncRunIdEnd && syncRunId > syncRunIdEnd) continue;

                        const queryWindow = logData.queryWindow || {};

                        // 遍历门店 A 和 B
                        const sides = side ? [side] : ['A', 'B'];
                        for (const s of sides) {
                            const rawList = logData.rawRecords?.[s] || [];
                            const qw = queryWindow[s] || {};

                            for (const record of rawList) {
                                // 条形码过滤
                                if (barcode && record.barcode !== barcode) continue;
                                // 老库存过滤
                                if (oldStock !== undefined && oldStock !== null && record.oldStock !== oldStock) continue;
                                // 新库存过滤
                                if (newStock !== undefined && newStock !== null && record.newStock !== newStock) continue;

                                allRecords.push({
                                    opType: '修改门店商品',
                                    opContent: record.opContent || `库存：${record.oldStock} → ${record.newStock}`,
                                    barcode: record.barcode,
                                    bizId: record.bizId || '',
                                    opTime: record.opTime,
                                    opUser: record.opUser || '',
                                    oldStock: record.oldStock,
                                    newStock: record.newStock,
                                    change: record.change,
                                    syncRunId: syncRunId,
                                    queryStart: qw.start || null,
                                    queryEnd: qw.end || null,
                                    side: s
                                });
                            }
                        }
                    } catch (parseError) {
                        console.warn(`解析日志文件失败 ${file}: ${parseError.message}`);
                    }
                }
            }

            // 按操作时间倒序排序
            allRecords.sort((a, b) => new Date(b.opTime) - new Date(a.opTime));

            // 分页
            const total = allRecords.length;
            const totalPages = Math.ceil(total / pageSize);
            const startIdx = (page - 1) * pageSize;
            const records = allRecords.slice(startIdx, startIdx + pageSize);

            return { records, total, page, pageSize, totalPages };
        } catch (error) {
            console.error(`查询原始记录失败: ${error.message}`);
            return { records: [], total: 0, page, pageSize, totalPages: 0 };
        }
    }
}

module.exports = DatabaseService;
