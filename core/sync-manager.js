/**
 * 同步管理器 - 多组调度和定时任务管理
 * 负责多组同步的并发控制、定时任务、日志隔离
 */

const EventEmitter = require('events');
const SyncEngine = require('./sync-engine');
const path = require('path');
const fs = require('fs');

class SyncManager extends EventEmitter {
    /**
     * 初始化同步管理器
     * @param {Object} database - 数据库实例
     */
    constructor(database) {
        super();
        
        this.db = database;
        
        // 活跃的同步引擎实例 {groupId: SyncEngine}
        this._engines = new Map();
        // 正在运行的同步 {groupId: {type}}
        this._running = new Map();
        
        // 定时任务 {groupId: {timerId, intervalMinutes}}
        this._scheduledTasks = new Map();
        
        // 组日志缓存 {groupId: [logEntry]}（最近100条）
        this._groupLogs = new Map();
        
        // 运行中的任务 {groupId: { type: 'full'|'incremental' }}
        this._running = new Map();
        
        console.log('[SyncManager] 初始化完成');
    }

    /**
     * 获取或创建同步引擎
     * @private
     * @param {number} groupId - 组ID
     * @returns {SyncEngine} 同步引擎实例
     */
    _getOrCreateEngine(groupId) {
        if (this._engines.has(groupId)) {
            return this._engines.get(groupId);
        }

        // 从数据库加载组配置
        const group = this.db.getGroup(groupId);
        if (!group) {
            throw new Error(`组不存在: ${groupId}`);
        }

        if (!group.enabled) {
            throw new Error(`组已禁用: ${groupId}`);
        }

        // 构建配置
        const elemeConfig = {
            cookies: group.eleme_cookies,
            seller_id: group.eleme_seller_id,
            store_id: group.eleme_store_id
        };

        const qnhConfig = {
            cookies: group.qnh_cookies,
            store_id: group.qnh_store_id
        };

        // 获取全局配置
        const debugMode = this.db.getConfig('debug_mode', 'false') === 'true';

        // 创建引擎（传入日志回调、进度回调、调试模式）
        const engine = new SyncEngine(
            groupId,
            elemeConfig,
            qnhConfig,
            this.db,
            this._emitLog.bind(this), // 日志回调
            this._emitProgress.bind(this), // 进度回调
            debugMode // 调试模式
        );

        this._engines.set(groupId, engine);
        
        return engine;
    }

    /**
     * 刷新所有引擎配置（全局配置变更后调用）
     */
    refreshAllEngines() {
        const count = this._engines.size;
        this._engines.clear();
        console.log(`[SyncManager] 已刷新所有引擎配置 (共 ${count} 个)`);
    }

    /**
     * 发送进度更新
     * @private
     * @param {number} groupId - 组ID
     * @param {number} progress - 进度 (0-100)
     * @param {string} message - 进度消息
     */
    _emitProgress(groupId, progress, message) {
        this.emit('progress', {
            groupId,
            progress,
            message,
            timestamp: new Date()
        });
    }

    /**
     * 发送日志（文件+内存+事件）
     * @private
     * @param {number} groupId - 组ID
     * @param {string} level - 日志级别 (info/warn/error)
     * @param {string} message - 日志消息
     */
    _emitLog(groupId, level, message) {
        const logEntry = {
            timestamp: new Date(),
            level: level,
            groupId: groupId,
            message: message
        };

        // 1. 内存缓存（最近100条）
        if (!this._groupLogs.has(groupId)) {
            this._groupLogs.set(groupId, []);
        }
        const logs = this._groupLogs.get(groupId);
        logs.push(logEntry);
        if (logs.length > 100) {
            logs.shift();
        }

        // 2. 写入文件
        try {
            const logDir = path.join('logs', 'groups');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            
            const dateStr = this._getDateStr();
            const logFile = path.join(logDir, `group_${groupId}_${dateStr}.log`);
            const logLine = `[${logEntry.timestamp.toISOString()}] [${level.toUpperCase()}] ${message}\n`;
            
            fs.appendFileSync(logFile, logLine);
        } catch (error) {
            console.error(`[SyncManager] 写入日志文件失败: ${error.message}`);
        }

        // 3. 触发事件（供UI实时显示）
        this.emit('log', logEntry);
    }

    /**
     * 获取日期字符串 YYYY-MM-DD
     * @private
     */
    _getDateStr() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * 单组同步
     * @private
     * @param {number} groupId - 组ID
     * @param {string} syncType - 同步类型 (full/incremental)
     * @param {Object} options - 选项
     * @returns {Object} 同步结果
     */
    async _syncGroup(groupId, syncType, options = {}) {
        let result;
        try {
            const engine = this._getOrCreateEngine(groupId);
            
            this._emitLog(groupId, 'info', `开始${syncType === 'full' ? '全量' : '增量'}同步`);
            this._running.set(groupId, { type: syncType });
            this.emit('sync-started', { groupId, type: syncType });
            
            if (syncType === 'full') {
                result = await engine.fullSync(options.exportDir);
            } else {
                result = await engine.incrementalSync(options.timeRange, options.startTime);
            }
            
            if (result.status === 'success') {
                this._emitLog(groupId, 'info', `${syncType === 'full' ? '全量' : '增量'}同步成功`);
                // 写回“上次同步时间与数量”到组表，供UI渲染
                try {
                    const end = result.endTime || new Date();
                    const count = (syncType === 'full') ? (result.totalDifferences ?? result.successItems ?? 0)
                                 : (result.affectedProducts ?? result.successItems ?? 0);
                    const fields = {};
                    if (syncType === 'full') {
                        fields.last_full_sync_time = end.toISOString();
                        fields.last_full_sync_count = count;
                    } else {
                        fields.last_incr_sync_time = end.toISOString();
                        fields.last_incr_sync_count = count;
                    }
                    this.db.updateGroup(groupId, fields);
                } catch (e) {
                    this._emitLog(groupId, 'warn', `更新组同步摘要失败: ${e.message}`);
                }
            } else {
                this._emitLog(groupId, 'error', `${syncType === 'full' ? '全量' : '增量'}同步失败: ${result.error}`);
            }
            
            return result;
            
        } catch (error) {
            this._emitLog(groupId, 'error', `同步异常: ${error.message}`);
            throw error;
        } finally {
            const running = this._running.get(groupId);
            this._running.delete(groupId);
            // 将结果也一并带上，方便渲染层更新“上次同步信息”
            this.emit('sync-complete', { groupId, type: running ? running.type : undefined, result });
        }
    }

    /**
     * 取消正在运行的同步
     * @param {number} groupId 
     */
    cancel(groupId) {
        // 如果该组有正在运行的任务，则发送取消信号
        if (this.isRunning(groupId)) {
            const engine = this._engines.get(groupId);
            if (engine) {
                try {
                    engine.cancel();
                    this._emitLog(groupId, 'warn', '收到终止任务指令，正在中止...');
                    // 若存在定时任务，一并停止，避免下一轮自动触发
                    if (this._scheduledTasks.has(groupId)) {
                        this.stopScheduledSync(groupId);
                        this._emitLog(groupId, 'info', '已同时停止该组的定时增量任务');
                        return { success: true, action: 'cancel_running_and_stop_scheduled' };
                    }
                    return { success: true, action: 'cancel_running' };
                } catch (e) {
                    this._emitLog(groupId, 'error', `终止任务失败: ${e.message}`);
                    return { success: false, error: e.message };
                }
            }
        }

        // 没有运行中的任务，如果存在定时任务，视为“待机状态下的停止”，直接停止定时任务
        if (this._scheduledTasks.has(groupId)) {
            this.stopScheduledSync(groupId);
            this._emitLog(groupId, 'info', '已停止定时增量任务');
            return { success: true, action: 'stop_scheduled' };
        }

        return { success: false, error: 'no_active_task' };
    }

    /**
     * 是否正在运行
     */
    isRunning(groupId) {
        return this._running.has(groupId);
    }

    /**
     * 获取运行中任务
     */
    getRunningTasks() {
        const obj = {};
        for (const [gid, info] of this._running.entries()) {
            obj[gid] = info;
        }
        return obj;
    }

    /**
     * 多组同步（带并发控制）
     * @param {Array<number>} groupIds - 组ID列表
     * @param {string} syncType - 同步类型 (full/incremental)
     * @param {number} concurrency - 并发数量（默认3）
     * @param {Object} options - 选项
     * @returns {Promise<Object>} 结果 {groupId: result}
     */
    async syncMultipleGroups(groupIds, syncType = 'incremental', concurrency = 3, options = {}) {
        console.log(`[SyncManager] 多组同步开始: ${groupIds.length} 个组, 并发: ${concurrency}`);
        
        const results = {};
        const queue = [...groupIds];
        const running = new Set();
        let nextDelay = 0;

        return new Promise((resolve) => {
            const processNext = () => {
                // 检查是否完成
                if (queue.length === 0 && running.size === 0) {
                    console.log('[SyncManager] 多组同步完成');
                    resolve(results);
                    return;
                }

                // 启动新任务（不超过并发限制）
                while (queue.length > 0 && running.size < concurrency) {
                    const groupId = queue.shift();
                    running.add(groupId);

                    // 错峰启动（每组延时10秒）
                    const delay = nextDelay;
                    nextDelay += 10000;

                    console.log(`[SyncManager] 组 ${groupId} 将在 ${delay / 1000} 秒后启动`);

                    setTimeout(() => {
                        this._emitLog(groupId, 'info', `启动同步 (队列位置: ${groupIds.indexOf(groupId) + 1}/${groupIds.length})`);
                        
                        this._syncGroup(groupId, syncType, options)
                            .then(result => {
                                results[groupId] = { status: 'success', ...result };
                                this._emitLog(groupId, 'info', '同步任务完成');
                            })
                            .catch(error => {
                                results[groupId] = { status: 'failed', error: error.message };
                                this._emitLog(groupId, 'error', `同步任务失败: ${error.message}`);
                            })
                            .finally(() => {
                                running.delete(groupId);
                                processNext();
                            });
                    }, delay);
                }
            };

            processNext();
        });
    }

    /**
     * 启动定时任务
     * @param {number} groupId - 组ID
     * @param {number} intervalMinutes - 间隔时间（分钟）
     */
    startScheduledSync(groupId, intervalMinutes = 10, options = {}) {
        // 停止现有任务
        this.stopScheduledSync(groupId);

        const intervalMs = intervalMinutes * 60 * 1000;

        const runImmediately = options.runImmediately !== undefined ? !!options.runImmediately : true;

        this._emitLog(groupId, 'info', `启动定时任务，间隔: ${intervalMinutes}分钟${runImmediately ? '（立即执行一次）' : '（首次延迟执行）'}`);

        // 北京时间格式化
        const toBeijing = (d) => {
            const date = new Date(d);
            const bj = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60000);
            const y = bj.getFullYear();
            const m = String(bj.getMonth() + 1).padStart(2, '0');
            const day = String(bj.getDate()).padStart(2, '0');
            const hh = String(bj.getHours()).padStart(2, '0');
            const mm = String(bj.getMinutes()).padStart(2, '0');
            const ss = String(bj.getSeconds()).padStart(2, '0');
            return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
        };

        const runOnce = async () => {
            if (this.isRunning(groupId)) {
                this._emitLog(groupId, 'warn', '上一次任务仍在进行，跳过本轮定时触发');
                return;
            }
            this._emitLog(groupId, 'info', `定时增量同步开始 (间隔: ${intervalMinutes}分钟)`);
            try {
                const result = await this._syncGroup(groupId, 'incremental');
                if (result.status === 'success') {
                    this._emitLog(groupId, 'info', '定时增量同步完成');
                } else {
                    this._emitLog(groupId, 'error', `定时增量同步失败: ${result.error}`);
                    // 若增量时间区间超阈值，则停止定时任务并提示用户应先做全量
                    if (result.error === 'require_full_sync_due_to_time_range') {
                        this._emitLog(groupId, 'warn', '由于增量区间超过3小时，已停止该组定时增量任务，请先进行一次全量同步任务');
                        this.stopScheduledSync(groupId);
                        return; // 直接结束本轮，不再记录下次时间
                    }
                }
            } catch (error) {
                this._emitLog(groupId, 'error', `定时增量同步异常: ${error.message}`);
            } finally {
                // 仅当定时任务仍然活跃时，才记录下次时间
                if (this._scheduledTasks.has(groupId)) {
                    const next = new Date(Date.now() + intervalMs);
                    this._emitLog(groupId, 'info', `下次定时增量时间(北京时间): ${toBeijing(next)}`);
                }
            }
        };

        // 周期调度：仅使用 setInterval，避免 setTimeout 与 setInterval 在首个间隔同时触发导致并发
        const timerId = setInterval(runOnce, intervalMs);

        if (runImmediately) {
            // 立即先执行一轮；后续由 setInterval 在 intervalMs 后再次触发
            runOnce();
        }

        this._scheduledTasks.set(groupId, {
            timerId: timerId,
            intervalMinutes: intervalMinutes,
            runImmediately: runImmediately,
            startTime: new Date()
        });

        // 触发定时任务状态变化事件
        this.emit('scheduled-task-changed', {
            groupId: groupId,
            action: 'start',
            intervalMinutes: intervalMinutes
        });

        console.log(`[SyncManager] 组 ${groupId} 定时任务已启动，间隔: ${intervalMinutes}分钟`);
    }

    /**
     * 停止定时任务
     * @param {number} groupId - 组ID
     */
    stopScheduledSync(groupId) {
        if (this._scheduledTasks.has(groupId)) {
            const task = this._scheduledTasks.get(groupId);
            clearInterval(task.timerId);
            this._scheduledTasks.delete(groupId);

            this._emitLog(groupId, 'info', '定时任务已停止');

            // 触发定时任务状态变化事件
            this.emit('scheduled-task-changed', {
                groupId: groupId,
                action: 'stop'
            });

            console.log(`[SyncManager] 组 ${groupId} 定时任务已停止`);
        }
    }

    /**
     * 停止所有定时任务
     */
    stopAllScheduled() {
        console.log(`[SyncManager] 停止所有定时任务 (${this._scheduledTasks.size} 个)`);
        
        for (const groupId of this._scheduledTasks.keys()) {
            this.stopScheduledSync(groupId);
        }
    }

    /**
     * 获取定时任务状态
     * @param {number} groupId - 组ID（可选）
     * @returns {Object|Array} 定时任务信息
     */
    getScheduledTasks(groupId = null) {
        if (groupId !== null) {
            if (this._scheduledTasks.has(groupId)) {
                const task = this._scheduledTasks.get(groupId);
                return {
                    groupId: groupId,
                    intervalMinutes: task.intervalMinutes,
                    startTime: task.startTime,
                    isActive: true
                };
            }
            return null;
        }

        // 返回所有定时任务
        const tasks = [];
        for (const [gid, task] of this._scheduledTasks.entries()) {
            tasks.push({
                groupId: gid,
                intervalMinutes: task.intervalMinutes,
                startTime: task.startTime,
                isActive: true
            });
        }
        return tasks;
    }

    /**
     * 获取组日志（内存缓存）
     * @param {number} groupId - 组ID
     * @param {number} limit - 限制数量
     * @returns {Array} 日志列表
     */
    getGroupLogs(groupId, limit = 100) {
        if (!this._groupLogs.has(groupId)) {
            return [];
        }

        const logs = this._groupLogs.get(groupId);
        
        if (limit && logs.length > limit) {
            return logs.slice(-limit);
        }
        
        return logs.slice();
    }

    /**
     * 清空组日志缓存
     * @param {number} groupId - 组ID
     */
    clearGroupLogs(groupId) {
        if (this._groupLogs.has(groupId)) {
            this._groupLogs.get(groupId).length = 0;
            console.log(`[SyncManager] 组 ${groupId} 日志缓存已清空`);
        }
    }

    /**
     * 关闭管理器（停止所有任务）
     */
    close() {
        console.log('[SyncManager] 正在关闭...');
        
        // 停止所有定时任务
        this.stopAllScheduled();
        
        // 清空引擎实例
        this._engines.clear();
        
        // 清空日志缓存
        this._groupLogs.clear();
        
        console.log('[SyncManager] 已关闭');
    }
}

module.exports = SyncManager;

