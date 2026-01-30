/**
 * 双向同步管理器 - 多组调度和定时任务管理
 * 负责双向同步的并发控制、定时任务、日志隔离
 */

const EventEmitter = require('events');
const DualSyncEngine = require('./dual-sync-engine');
const { toLocalISOString } = require('../utils/time-utils');
const path = require('path');
const fs = require('fs');
const fileWriteQueue = require('../utils/file-write-queue');

class DualSyncManager extends EventEmitter {
    /**
     * 初始化双向同步管理器
     * @param {Object} database - 数据库实例
     * @param {string} dataDir - 用户数据目录（用于存储日志、追溯记录等运行时数据）
     */
    constructor(database, dataDir = null) {
        super();
        
        this.db = database;
        // 注入的数据目录，避免使用 __dirname（打包后不可写）
        this.dataDir = dataDir || path.join(__dirname, '..', 'data');
        
        // 活跃的同步引擎实例 {groupId: DualSyncEngine}
        this._engines = new Map();
        
        // 正在运行的同步 {groupId: {type}}
        this._running = new Map();
        
        // 定时任务 {groupId: {timerId, intervalMinutes}}
        this._scheduledTasks = new Map();
        
        // 组日志缓存 {groupId: [logEntry]}（最近100条）
        this._groupLogs = new Map();
        
        console.log(`[DualSyncManager] 初始化完成，dataDir: ${this.dataDir}`);
    }

    /**
     * 获取或创建同步引擎
     * @private
     */
    _getOrCreateEngine(groupId) {
        if (this._engines.has(groupId)) {
            return this._engines.get(groupId);
        }

        // 从数据库加载组配置
        const group = this.db.getDualSyncGroup(groupId);
        if (!group) {
            throw new Error(`双向同步组不存在: ${groupId}`);
        }

        if (!group.enabled) {
            throw new Error(`双向同步组已禁用: ${groupId}`);
        }

        // 获取全局调试模式配置
        const debugMode = this.db.getConfig('debug_mode', 'false') === 'true';

        // 构造引擎配置（注意数据库字段名是 a_eleme_xxx / b_eleme_xxx）
        const config = {
            elemeA: {
                cookies: group.a_eleme_cookies,
                seller_id: group.a_eleme_seller_id,
                store_id: group.a_eleme_store_id
            },
            qnhA: {
                cookies: group.a_qnh_cookies,
                store_id: group.a_qnh_store_id
            },
            elemeB: {
                cookies: group.b_eleme_cookies,
                seller_id: group.b_eleme_seller_id,
                store_id: group.b_eleme_store_id
            },
            qnhB: {
                cookies: group.b_qnh_cookies,
                store_id: group.b_qnh_store_id
            }
        };

        // 创建引擎（传入 dataDir，避免引擎使用硬编码路径）
        const engine = new DualSyncEngine(
            config,
            this.db,
            groupId,
            this._emitLog.bind(this),
            this._emitProgress.bind(this),
            debugMode,
            this.dataDir
        );

        this._engines.set(groupId, engine);
        
        return engine;
    }

    /**
     * 刷新引擎配置（配置变更后调用）
     */
    refreshEngine(groupId) {
        if (this._engines.has(groupId)) {
            this._engines.delete(groupId);
            console.log(`[DualSyncManager] 已刷新组 ${groupId} 的引擎配置`);
        }
    }

    /**
     * 刷新所有引擎配置（全局配置变更后调用）
     */
    refreshAllEngines() {
        const count = this._engines.size;
        this._engines.clear();
        console.log(`[DualSyncManager] 已刷新所有引擎配置 (共 ${count} 个)`);
    }

    /**
     * 发送进度更新
     * @private
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

        // 2. 写入文件（使用注入的 dataDir，避免打包后不可写）
        try {
            const logDir = path.join(this.dataDir, 'logs', 'dual-sync');
            const dateStr = this._getDateStr();
            const logFile = path.join(logDir, `dual_group_${groupId}_${dateStr}.log`);
            const logLine = `[${toLocalISOString(logEntry.timestamp)}] [${level.toUpperCase()}] ${message}\n`;
            // 异步串行写入（避免阻塞事件循环）
            fileWriteQueue.appendFile(logFile, logLine, 'utf8');
        } catch (error) {
            console.error(`[DualSyncManager] 写入日志文件失败: ${error.message}`);
        }

        // 3. 触发事件（供UI实时显示）
        this.emit('log', logEntry);
    }

    /**
     * 获取日期字符串
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
     * 执行全量同步
     */
    async fullSync(groupId, options = {}) {
        try {
            const engine = this._getOrCreateEngine(groupId);
            
            this._emitLog(groupId, 'info', '开始全量同步');
            this._running.set(groupId, { type: 'full' });
            this.emit('sync-started', { groupId, type: 'full' });
            
            // 不再传递 exportDir，引擎使用构造时注入的 dataDir
            const result = await engine.fullSync();
            
            if (result.status === 'success') {
                this._emitLog(groupId, 'info', '全量同步成功');
            } else if (result.status === 'cancelled') {
                this._emitLog(groupId, 'warn', '全量同步已取消');
            } else {
                this._emitLog(groupId, 'error', `全量同步失败: ${result.error}`);
            }
            
            return result;
            
        } catch (error) {
            this._emitLog(groupId, 'error', `全量同步异常: ${error.message}`);
            throw error;
        } finally {
            this._running.delete(groupId);
            this.emit('sync-complete', { groupId, type: 'full' });
        }
    }

    /**
     * 执行增量同步
     */
    async incrementalSync(groupId, options = {}) {
        try {
            const engine = this._getOrCreateEngine(groupId);
            
            this._emitLog(groupId, 'info', '开始增量同步');
            this._running.set(groupId, { type: 'incremental' });
            this.emit('sync-started', { groupId, type: 'incremental' });
            
            // 不再传递 exportDir，引擎使用构造时注入的 dataDir
            const result = await engine.incrementalSync();
            
            if (result.status === 'success') {
                this._emitLog(groupId, 'info', '增量同步成功');
            } else if (result.status === 'partial') {
                this._emitLog(groupId, 'warn', `增量同步部分完成: 成功${result.success}个, 失败${result.failed}个`);
            } else if (result.status === 'cancelled') {
                this._emitLog(groupId, 'warn', '增量同步已取消');
            } else {
                this._emitLog(groupId, 'error', `增量同步失败: ${result.error || '未知错误'}`);
            }
            
            return result;
            
        } catch (error) {
            this._emitLog(groupId, 'error', `增量同步异常: ${error.message}`);
            throw error;
        } finally {
            this._running.delete(groupId);
            this.emit('sync-complete', { groupId, type: 'incremental' });
        }
    }

    /**
     * 取消正在运行的同步
     */
    cancel(groupId) {
        if (this.isRunning(groupId)) {
            const engine = this._engines.get(groupId);
            if (engine) {
                try {
                    engine.cancel();
                    this._emitLog(groupId, 'warn', '收到终止任务指令，正在中止...');
                    
                    // 同时停止定时任务
                    if (this._scheduledTasks.has(groupId)) {
                        this.stopScheduledSync(groupId);
                        this._emitLog(groupId, 'info', '已同时停止定时任务');
                        return { success: true, action: 'cancel_running_and_stop_scheduled' };
                    }
                    return { success: true, action: 'cancel_running' };
                } catch (e) {
                    this._emitLog(groupId, 'error', `终止任务失败: ${e.message}`);
                    return { success: false, error: e.message };
                }
            }
        }

        // 没有运行中的任务，停止定时任务
        if (this._scheduledTasks.has(groupId)) {
            this.stopScheduledSync(groupId);
            this._emitLog(groupId, 'info', '已停止定时任务');
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
     * 启动定时任务
     */
    startScheduledSync(groupId, intervalMinutes = 10, options = {}) {
        // 停止现有任务
        this.stopScheduledSync(groupId);

        const intervalMs = intervalMinutes * 60 * 1000;
        const runImmediately = options.runImmediately !== undefined ? !!options.runImmediately : true;
        // 不再需要 exportDir，引擎使用构造时注入的 dataDir

        this._emitLog(groupId, 'info', `启动定时任务，间隔: ${intervalMinutes}分钟${runImmediately ? '（立即执行一次）' : ''}`);

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

        const scheduleNext = (delayMs) => {
            if (!this._scheduledTasks.has(groupId)) return;
            const task = this._scheduledTasks.get(groupId);

            // 清理旧定时器（兼容历史 setInterval / setTimeout）
            try { clearTimeout(task.timerId); } catch (_) {}
            try { clearInterval(task.timerId); } catch (_) {}

            const nextDueAt = new Date(Date.now() + delayMs);
            task.nextDueAt = nextDueAt;
            task.timerType = 'timeout';
            task.timerId = setTimeout(() => runOnce(), delayMs);

            this._emitLog(groupId, 'info', `下次定时同步时间: ${toBeijing(nextDueAt)}`);
        };

        const runOnce = async () => {
            // fixed-delay：以上一次“任务完成时间”为基准，完成后再延迟 intervalMs 执行下一次
            if (this.isRunning(groupId)) {
                this._emitLog(groupId, 'warn', '上一次任务仍在进行，跳过本轮');
                // 本轮跳过也按 fixed-delay 继续排下一次
                if (this._scheduledTasks.has(groupId)) scheduleNext(intervalMs);
                return;
            }

            this._emitLog(groupId, 'info', `定时增量同步开始 (间隔: ${intervalMinutes}分钟)`);
            
            try {
                // 不再传递 exportDir，使用引擎内部的 dataDir
                const result = await this.incrementalSync(groupId);
                
                if (result.status === 'success') {
                    this._emitLog(groupId, 'info', '定时增量同步完成');
                } else if (result.status === 'partial') {
                    this._emitLog(groupId, 'warn', `定时增量同步部分完成: 成功${result.success}个, 失败${result.failed}个`);
                } else if (result.status === 'cancelled') {
                    this._emitLog(groupId, 'warn', '定时增量同步已取消');
                } else if (result.error === 'require_full_sync_first' || 
                           result.error === 'require_full_sync_due_to_time_range') {
                    this._emitLog(groupId, 'warn', '需要先执行全量同步，已停止定时任务');
                    this.stopScheduledSync(groupId);
                    return;
                } else {
                    this._emitLog(groupId, 'error', `定时增量同步失败: ${result.error || '未知错误'}`);
                    
                    // 检查是否为认证类错误（Cookie过期等），如果是则停止定时任务
                    const errorMsg = result.error || '';
                    if (errorMsg.includes('登录状态无效') || 
                        errorMsg.includes('已过期') || 
                        errorMsg.includes('code: 102') ||
                        errorMsg.includes('认证失败') ||
                        errorMsg.includes('未登录')) {
                        this._emitLog(groupId, 'error', 'Cookie已过期或无效，已停止定时任务，请更新Cookie后重新启动');
                        this.stopScheduledSync(groupId);
                        return;
                    }
                }
            } catch (error) {
                this._emitLog(groupId, 'error', `定时增量同步异常: ${error.message}`);
                
                // 检查异常信息是否为认证类错误
                const errorMsg = error.message || '';
                if (errorMsg.includes('登录状态无效') || 
                    errorMsg.includes('已过期') || 
                    errorMsg.includes('code: 102') ||
                    errorMsg.includes('认证失败') ||
                    errorMsg.includes('未登录')) {
                    this._emitLog(groupId, 'error', 'Cookie已过期或无效，已停止定时任务，请更新Cookie后重新启动');
                    this.stopScheduledSync(groupId);
                    return;
                }
            } finally {
                // fixed-delay：任务结束后再安排下一次
                if (this._scheduledTasks.has(groupId)) {
                    scheduleNext(intervalMs);
                }
            }
        };

        // 写入任务状态（先占位，便于 scheduleNext / stop 能正确工作）
        this._scheduledTasks.set(groupId, {
            timerId: null,
            timerType: 'timeout',
            intervalMinutes: intervalMinutes,
            runImmediately: runImmediately,
            startTime: new Date(),
            nextDueAt: null
        });

        if (runImmediately) {
            runOnce();
        } else {
            scheduleNext(intervalMs);
        }

        // 触发状态变化事件
        this.emit('scheduled-task-changed', {
            groupId: groupId,
            action: 'start',
            intervalMinutes: intervalMinutes
        });

        console.log(`[DualSyncManager] 组 ${groupId} 定时任务已启动，间隔: ${intervalMinutes}分钟`);
    }

    /**
     * 停止定时任务
     */
    stopScheduledSync(groupId) {
        if (this._scheduledTasks.has(groupId)) {
            const task = this._scheduledTasks.get(groupId);
            // 兼容清理 setInterval / setTimeout
            try { clearInterval(task.timerId); } catch (_) {}
            try { clearTimeout(task.timerId); } catch (_) {}
            this._scheduledTasks.delete(groupId);

            this._emitLog(groupId, 'info', '定时任务已停止');

            // 触发状态变化事件
            this.emit('scheduled-task-changed', {
                groupId: groupId,
                action: 'stop'
            });

            console.log(`[DualSyncManager] 组 ${groupId} 定时任务已停止`);
        }
    }

    /**
     * 安全停止定时任务：
     * - 永远停止后续定时触发
     * - 若当前正在运行且仍在查询阶段，则同时 cancel 本轮
     * - 若已进入写入阶段，则默认不取消本轮（避免写入中断导致状态不一致）
     */
    stopScheduledSyncSafe(groupId) {
        const wasScheduled = this._scheduledTasks.has(groupId);
        if (wasScheduled) {
            this.stopScheduledSync(groupId);
        }

        if (this.isRunning(groupId)) {
            const engine = this._engines.get(groupId);
            const stage = engine && typeof engine.getStage === 'function'
                ? engine.getStage()
                : (engine && engine.stage ? engine.stage : 'idle');

            if (stage === 'querying') {
                try {
                    engine && engine.cancel();
                    this._emitLog(groupId, 'warn', '已停止定时任务，并在查询阶段取消本轮同步（安全取消）');
                    return { success: true, action: 'stop_scheduled_and_cancel_running' };
                } catch (e) {
                    this._emitLog(groupId, 'error', `安全取消失败: ${e.message}`);
                    return { success: false, error: e.message };
                }
            }

            this._emitLog(groupId, 'warn', '已停止定时任务；当前已进入写入阶段，本轮将继续完成（未取消本轮）');
            return { success: true, action: 'stop_scheduled_only_running_apply' };
        }

        if (wasScheduled) {
            return { success: true, action: 'stop_scheduled' };
        }
        return { success: false, error: 'no_active_task' };
    }

    /**
     * 停止所有定时任务
     */
    stopAllScheduled() {
        console.log(`[DualSyncManager] 停止所有定时任务 (${this._scheduledTasks.size} 个)`);
        
        for (const groupId of this._scheduledTasks.keys()) {
            this.stopScheduledSync(groupId);
        }
    }

    /**
     * 获取定时任务状态
     */
    getScheduledTasks(groupId = null) {
        if (groupId !== null) {
            if (this._scheduledTasks.has(groupId)) {
                const task = this._scheduledTasks.get(groupId);
                return {
                    groupId: groupId,
                    intervalMinutes: task.intervalMinutes,
                    startTime: task.startTime,
                    nextDueAt: task.nextDueAt || null,
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
                nextDueAt: task.nextDueAt || null,
                isActive: true
            });
        }
        return tasks;
    }

    /**
     * 获取组日志（内存缓存）
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
     */
    clearGroupLogs(groupId) {
        if (this._groupLogs.has(groupId)) {
            this._groupLogs.get(groupId).length = 0;
            console.log(`[DualSyncManager] 组 ${groupId} 日志缓存已清空`);
        }
    }

    /**
     * 关闭管理器
     */
    close() {
        console.log('[DualSyncManager] 正在关闭...');
        
        // 停止所有定时任务
        this.stopAllScheduled();
        
        // 清空引擎实例
        this._engines.clear();
        
        // 清空日志缓存
        this._groupLogs.clear();
        
        console.log('[DualSyncManager] 已关闭');
    }
}

module.exports = DualSyncManager;

