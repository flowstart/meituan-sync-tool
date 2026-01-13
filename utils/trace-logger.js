/**
 * 追溯日志管理模块
 * 用于记录同步过程的详细JSON日志，便于排查库存不一致问题
 */

const fs = require('fs');
const path = require('path');
const { toLocalISOString, toLocalDateString } = require('./time-utils');

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
        
        // 确保目录存在
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

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

        // 写入文件
        fs.writeFileSync(filePath, JSON.stringify(logData, null, 2), 'utf8');
        console.log(`[TraceLogger] 写入追溯日志: ${filePath}`);
        
        return filePath;
    } catch (error) {
        console.error(`[TraceLogger] 写入追溯日志失败: ${error.message}`);
        return null;
    }
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

module.exports = {
    writeTraceLog,
    readTraceLog,
    cleanupOldTraceLogs,
    listTraceLogs,
    getTraceLogDir
};

