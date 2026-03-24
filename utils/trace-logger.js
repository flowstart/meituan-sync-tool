/**
 * 追溯日志管理模块
 * 用于记录同步过程的详细JSON日志，便于排查库存不一致问题
 */

const fs = require('fs');
const path = require('path');
const { toLocalISOString, toLocalDateString } = require('./time-utils');
const fileWriteQueue = require('./file-write-queue');

/**
 * 获取追溯日志目录
 * @param {string} baseDir - 基础目录
 * @param {number} groupId - 双向同步组ID
 * @returns {string} 日志目录路径
 */
function getTraceLogDir(baseDir, groupId) {
    const dateStr = toLocalDateString(new Date());
    return path.join(baseDir, 'sync_trace', `dual_${groupId}`, dateStr);
}

/**
 * 写入追溯日志
 * @param {string} baseDir - 基础目录（如 data/）
 * @param {number} groupId - 双向同步组ID
 * @param {string} syncType - 同步类型 'full' / 'incremental'
 * @param {number} syncRunId - 同步运行ID
 * @param {Object} data - 日志数据
 * @returns {string|null} 日志文件路径，失败返回null
 */
function writeTraceLog(baseDir, groupId, syncType, syncRunId, data) {
    try {
        const logDir = getTraceLogDir(baseDir, groupId);

        // 生成文件名
        const timestamp = Date.now();
        const filename = `${syncType}_${syncRunId}_${timestamp}.json`;
        const filePath = path.join(logDir, filename);

        // 添加元数据
        const logData = {
            ...data,
            _meta: {
                syncRunId,
                syncType,
                groupId,
                createdAt: toLocalISOString(new Date()),
                version: '1.0'
            }
        };

        // 写入文件（异步串行原子写），避免阻塞事件循环
        const payload = JSON.stringify(logData, null, 2);
        fileWriteQueue.writeFileAtomic(filePath, payload, 'utf8').then(() => {
            console.log(`[TraceLogger] 写入追溯日志: ${filePath}`);
        });
        
        return filePath;
    } catch (error) {
        console.error(`[TraceLogger] 写入追溯日志失败: ${error.message}`);
        return null;
    }
}

/**
 * 写入追溯日志（async 版本，必要时可 await）
 */
async function writeTraceLogAsync(baseDir, groupId, syncType, syncRunId, data) {
    const logDir = getTraceLogDir(baseDir, groupId);
    const timestamp = Date.now();
    const filename = `${syncType}_${syncRunId}_${timestamp}.json`;
    const filePath = path.join(logDir, filename);
    const logData = {
        ...data,
        _meta: {
            syncRunId,
            syncType,
            groupId,
            createdAt: toLocalISOString(new Date()),
            version: '1.0'
        }
    };
    const payload = JSON.stringify(logData, null, 2);
    await fileWriteQueue.writeFileAtomic(filePath, payload, 'utf8');
    return filePath;
}

/**
 * 读取追溯日志
 * @param {string} baseDir - 基础目录
 * @param {number} groupId - 双向同步组ID
 * @param {number} syncRunId - 同步运行ID
 * @returns {Object|null} 日志数据，失败返回null
 */
function readTraceLog(baseDir, groupId, syncRunId) {
    try {
        const traceDir = path.join(baseDir, 'sync_trace', `dual_${groupId}`);
        
        if (!fs.existsSync(traceDir)) {
            return null;
        }

        // 遍历日期目录查找对应的日志
        const dateDirs = fs.readdirSync(traceDir).filter(d => {
            const fullPath = path.join(traceDir, d);
            return fs.statSync(fullPath).isDirectory();
        });

        for (const dateDir of dateDirs) {
            const datePath = path.join(traceDir, dateDir);
            const files = fs.readdirSync(datePath).filter(f => f.endsWith('.json'));
            
            for (const file of files) {
                // 文件名格式: {syncType}_{syncRunId}_{timestamp}.json
                const parts = file.replace('.json', '').split('_');
                if (parts.length >= 2 && parts[1] === String(syncRunId)) {
                    const filePath = path.join(datePath, file);
                    const content = fs.readFileSync(filePath, 'utf8');
                    return JSON.parse(content);
                }
            }
        }

        return null;
    } catch (error) {
        console.error(`[TraceLogger] 读取追溯日志失败: ${error.message}`);
        return null;
    }
}

/**
 * 清理指定天数前的追溯日志
 * @param {string} baseDir - 基础目录
 * @param {number} daysToKeep - 保留天数
 * @returns {Object} { deletedFiles, deletedDirs }
 */
function cleanupOldTraceLogs(baseDir, daysToKeep = 30) {
    const result = { deletedFiles: 0, deletedDirs: 0 };
    
    try {
        const traceBaseDir = path.join(baseDir, 'sync_trace');
        
        if (!fs.existsSync(traceBaseDir)) {
            return result;
        }

        const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
        const cutoffDateStr = toLocalDateString(cutoffDate);

        // 遍历所有组目录
        const groupDirs = fs.readdirSync(traceBaseDir).filter(d => {
            const fullPath = path.join(traceBaseDir, d);
            return fs.statSync(fullPath).isDirectory() && d.startsWith('dual_');
        });

        for (const groupDir of groupDirs) {
            const groupPath = path.join(traceBaseDir, groupDir);
            
            // 遍历日期目录
            const dateDirs = fs.readdirSync(groupPath).filter(d => {
                const fullPath = path.join(groupPath, d);
                return fs.statSync(fullPath).isDirectory();
            });

            for (const dateDir of dateDirs) {
                // 日期格式: YYYY-MM-DD
                if (dateDir < cutoffDateStr) {
                    const datePath = path.join(groupPath, dateDir);
                    
                    // 删除目录下的所有文件
                    const files = fs.readdirSync(datePath);
                    for (const file of files) {
                        fs.unlinkSync(path.join(datePath, file));
                        result.deletedFiles++;
                    }
                    
                    // 删除空目录
                    fs.rmdirSync(datePath);
                    result.deletedDirs++;
                }
            }

            // 如果组目录为空，也删除
            const remainingDirs = fs.readdirSync(groupPath);
            if (remainingDirs.length === 0) {
                fs.rmdirSync(groupPath);
            }
        }

        console.log(`[TraceLogger] 清理 ${daysToKeep} 天前的追溯日志: 删除 ${result.deletedFiles} 个文件, ${result.deletedDirs} 个目录`);
    } catch (error) {
        console.error(`[TraceLogger] 清理追溯日志失败: ${error.message}`);
    }

    return result;
}

/**
 * 获取指定组的所有追溯日志文件列表
 * @param {string} baseDir - 基础目录
 * @param {number} groupId - 双向同步组ID
 * @param {number} limit - 最大返回数量
 * @returns {Array<Object>} 日志文件列表 [{syncRunId, syncType, date, path}]
 */
function listTraceLogs(baseDir, groupId, limit = 100) {
    const logs = [];
    
    try {
        const traceDir = path.join(baseDir, 'sync_trace', `dual_${groupId}`);
        
        if (!fs.existsSync(traceDir)) {
            return logs;
        }

        // 遍历日期目录（按日期倒序）
        const dateDirs = fs.readdirSync(traceDir)
            .filter(d => {
                const fullPath = path.join(traceDir, d);
                return fs.statSync(fullPath).isDirectory();
            })
            .sort((a, b) => b.localeCompare(a)); // 倒序

        for (const dateDir of dateDirs) {
            if (logs.length >= limit) break;
            
            const datePath = path.join(traceDir, dateDir);
            const files = fs.readdirSync(datePath)
                .filter(f => f.endsWith('.json'))
                .sort((a, b) => b.localeCompare(a)); // 倒序

            for (const file of files) {
                if (logs.length >= limit) break;
                
                // 解析文件名
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
        console.error(`[TraceLogger] 列出追溯日志失败: ${error.message}`);
    }

    return logs;
}

/**
 * 从 JSON 日志中提取指定条形码的原始记录
 * @param {string} baseDir - 基础目录
 * @param {number} groupId - 双向同步组ID
 * @param {string} barcode - 条形码
 * @param {string} sinceDate - 开始日期 (YYYY-MM-DD格式)
 * @param {number} limit - 最大返回记录数
 * @returns {Object} { rawRecords, filteredRecords, filteredFingerprintRecords, filteredConsumedRecords, deduplicatedRecords, appliedRecords }
 */
function getTraceRecordsByBarcode(baseDir, groupId, barcode, sinceDate = null, limit = 1000) {
    const result = {
        rawRecords: [],           // 全部原始记录
        filteredRecords: [],      // 全部被过滤的记录（指纹+历史消费）
        filteredFingerprintRecords: [], // 被指纹过滤的记录
        filteredConsumedRecords: [], // 被历史消费账本过滤的记录
        deduplicatedRecords: [],  // 被去重的记录
        appliedRecords: []        // 实际同步的记录
    };
    
    const pushWithMeta = (arr, record, extra) => {
        arr.push({
            ...record,
            ...extra
        });
    };
    
    const normalizeFilteredList = (maybeListOrMap, side) => {
        if (!maybeListOrMap) return [];
        // 新结构：数组（不区分 A/B）
        if (Array.isArray(maybeListOrMap)) return maybeListOrMap;
        // 旧/未来结构：按 side 分组
        if (side && typeof maybeListOrMap === 'object' && Array.isArray(maybeListOrMap[side])) {
            return maybeListOrMap[side];
        }
        return [];
    };
    
    try {
        const traceDir = path.join(baseDir, 'sync_trace', `dual_${groupId}`);
        
        if (!fs.existsSync(traceDir)) {
            return result;
        }

        // 遍历日期目录（按日期正序，确保时间顺序）
        const dateDirs = fs.readdirSync(traceDir)
            .filter(d => {
                const fullPath = path.join(traceDir, d);
                if (!fs.statSync(fullPath).isDirectory()) return false;
                // 如果指定了开始日期，过滤掉之前的
                if (sinceDate && d < sinceDate) return false;
                return true;
            })
            .sort(); // 正序

        let totalRecords = 0;

        for (const dateDir of dateDirs) {
            if (totalRecords >= limit) break;
            
            const datePath = path.join(traceDir, dateDir);
            const files = fs.readdirSync(datePath)
                .filter(f => f.endsWith('.json') && f.startsWith('incremental_'))
                .sort(); // 正序

            for (const file of files) {
                if (totalRecords >= limit) break;
                
                try {
                    const filePath = path.join(datePath, file);
                    const content = fs.readFileSync(filePath, 'utf8');
                    const logData = JSON.parse(content);
                    
                    const syncRunId = logData._meta?.syncRunId || parseInt(file.split('_')[1], 10);
                    const syncTime = logData._meta?.createdAt || dateDir;

                    // 提取该条形码的原始记录
                    const sides = ['A', 'B'];
                    for (const side of sides) {
                        const rawList = logData.rawRecords?.[side] || [];
                        for (const record of rawList) {
                            if (record.barcode === barcode) {
                                pushWithMeta(result.rawRecords, record, {
                                    side,
                                    syncRunId,
                                    syncTime,
                                    recordType: 'raw'
                                });
                                totalRecords++;
                            }
                        }

                        // 提取被指纹过滤的记录
                        const filteredList = normalizeFilteredList(logData.filteredRecords?.byFingerprint, side);
                        for (const record of filteredList) {
                            if (record.barcode === barcode) {
                                const enriched = {
                                    // filteredRecords 在现有日志里是不区分 side 的；这里尽量补上 side 方便展示
                                    side: record.side || side,
                                    syncRunId,
                                    syncTime,
                                    recordType: 'filtered'
                                };
                                pushWithMeta(result.filteredRecords, record, enriched);
                                pushWithMeta(result.filteredFingerprintRecords, record, enriched);
                            }
                        }

                        const consumedList = normalizeFilteredList(logData.filteredRecords?.byConsumed, side);
                        for (const record of consumedList) {
                            if (record.barcode === barcode) {
                                const enriched = {
                                    side: record.side || side,
                                    syncRunId,
                                    syncTime,
                                    recordType: 'filtered_consumed'
                                };
                                pushWithMeta(result.filteredRecords, record, enriched);
                                pushWithMeta(result.filteredConsumedRecords, record, enriched);
                            }
                        }

                        // 提取被去重的记录
                        const dedupList = normalizeFilteredList(logData.filteredRecords?.byDeduplication, side);
                        for (const record of dedupList) {
                            if (record.barcode === barcode) {
                                pushWithMeta(result.deduplicatedRecords, record, {
                                    side: record.side || side,
                                    syncRunId,
                                    syncTime,
                                    recordType: 'deduplicated'
                                });
                            }
                        }
                    }

                    // 提取实际同步的记录
                    const directions = ['A->B', 'B->A'];
                    for (const direction of directions) {
                        const successList = logData.appliedChanges?.[direction]?.success || [];
                        for (const record of successList) {
                            if (record.barcode === barcode) {
                                result.appliedRecords.push({
                                    ...record,
                                    direction,
                                    syncRunId,
                                    syncTime,
                                    recordType: 'applied',
                                    applyResult: 'success'
                                });
                            }
                        }

                        const failedList = logData.appliedChanges?.[direction]?.failed || [];
                        for (const record of failedList) {
                            if (record.barcode === barcode) {
                                result.appliedRecords.push({
                                    ...record,
                                    direction,
                                    syncRunId,
                                    syncTime,
                                    recordType: 'applied',
                                    applyResult: 'failed'
                                });
                            }
                        }
                    }
                } catch (parseError) {
                    console.warn(`[TraceLogger] 解析日志文件失败 ${file}: ${parseError.message}`);
                }
            }
        }

        console.log(`[TraceLogger] 查询条形码 ${barcode} 追溯记录: 原始${result.rawRecords.length}, 过滤${result.filteredRecords.length}, 去重${result.deduplicatedRecords.length}, 同步${result.appliedRecords.length}`);
    } catch (error) {
        console.error(`[TraceLogger] 查询追溯记录失败: ${error.message}`);
    }

    return result;
}

module.exports = {
    writeTraceLog,
    writeTraceLogAsync,
    readTraceLog,
    cleanupOldTraceLogs,
    listTraceLogs,
    getTraceLogDir,
    getTraceRecordsByBarcode
};

