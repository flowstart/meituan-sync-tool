/**
 * Electron主进程
 * 集成同步引擎 - 提供完整的库存同步功能
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const logger = require('./utils/logger');
const fileWriteQueue = require('./utils/file-write-queue');
const SyncDatabase = require('./database/database');
const SyncManager = require('./core/sync-manager');
const DualSyncManager = require('./core/dual-sync-manager');

let mainWindow = null;
let db = null;
let syncManager = null;
let dualSyncManager = null;

/**
 * 清理30天前的追溯数据
 */
function cleanupOldTraceData() {
    try {
        const DAYS_TO_KEEP = 30;
        
        // 清理数据库中的追溯记录
        const dbDeleted = db.cleanupOldDualSyncTrace(DAYS_TO_KEEP);
        logger.info(`清理数据库追溯记录: 删除 ${dbDeleted} 条`);
        
        // 清理JSON日志文件
        const { cleanupOldTraceLogs } = require('./utils/trace-logger');
        const dataDir = path.join(app.getPath('userData'), 'data');
        const logResult = cleanupOldTraceLogs(dataDir, DAYS_TO_KEEP);
        logger.info(`清理追溯日志文件: 删除 ${logResult.deletedFiles} 个文件, ${logResult.deletedDirs} 个目录`);
    } catch (error) {
        logger.error('清理追溯数据失败:', error);
    }
}

/**
 * 创建主窗口
 */
function createWindow() {
    logger.info('创建主窗口...');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
        title: '美团同步工具 - 饿了么到牵牛花库存同步',
        backgroundColor: '#f5f5f5',
        icon: path.join(__dirname, 'assets/icon.png') // 如果有图标的话
  });

  // 加载前端界面
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // renderer 健康监控：白屏/崩溃可观测 + 可选自愈
  try {
    let lastAutoReloadAt = 0;
    const AUTO_RELOAD_COOLDOWN_MS = 60 * 1000;

    mainWindow.webContents.on('render-process-gone', (event, details) => {
      logger.error('渲染进程退出(render-process-gone):', details);
      const reason = details && details.reason;
      const now = Date.now();
      const shouldAutoReload = reason === 'crashed' || reason === 'oom' || reason === 'killed';
      if (shouldAutoReload && now - lastAutoReloadAt >= AUTO_RELOAD_COOLDOWN_MS) {
        lastAutoReloadAt = now;
        setTimeout(() => {
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              logger.warn('尝试自动重载页面以恢复白屏...');
              mainWindow.reload();
            }
          } catch (e) {
            logger.error('自动重载失败:', e);
          }
        }, 1000);
      }
    });

    mainWindow.on('unresponsive', () => {
      logger.error('窗口无响应(unresponsive)');
    });

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      logger.error('页面加载失败(did-fail-load):', { errorCode, errorDescription, validatedURL });
    });
  } catch (e) {
    logger.error('注册 renderer 监控失败:', e);
  }

  // 开发模式下打开DevTools
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
        logger.info('开发模式：DevTools已打开');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
        logger.info('主窗口已关闭');
    });

    logger.info('主窗口创建完成');
}

/**
 * 初始化数据库和同步管理器
 */
function initializeServices() {
    try {
        // 初始化数据库
        const dbPath = path.join(app.getPath('userData'), 'sync.db');
        db = new SyncDatabase(dbPath);
        logger.info(`数据库初始化完成: ${dbPath}`);

        // 初始化同步管理器
        syncManager = new SyncManager(db);
        logger.info('同步管理器初始化完成');

        // 初始化双向同步管理器（传入用户数据目录，避免打包后不可写）
        const dataDir = path.join(app.getPath('userData'), 'data');
        dualSyncManager = new DualSyncManager(db, dataDir);
        logger.info(`双向同步管理器初始化完成，dataDir: ${dataDir}`);

        // 启动时清理30天前的追溯数据
        cleanupOldTraceData();

        // 监听日志事件，转发到渲染进程
        syncManager.on('log', (logEntry) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('sync-log', logEntry);
            }
        });

        // 监听同步开始/完成事件，转发到渲染进程
        syncManager.on('sync-started', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('sync-started', data);
            }
        });
        syncManager.on('sync-complete', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                // 与渲染进程现有监听对齐
                mainWindow.webContents.send('sync-finished', data);
            }
        });

        // 监听进度事件，转发到渲染进程
        syncManager.on('progress', (progressData) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('sync-progress', progressData);
            }
        });

        // 监听同步开始/完成事件
        syncManager.on('sync-started', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('sync-started', data);
            }
        });

        syncManager.on('sync-complete', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('sync-finished', data);
            }
        });

        // 监听定时任务状态变化
        syncManager.on('scheduled-task-changed', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('scheduled-task-changed', data);
            }
        });

        // 监听同步开始/完成事件，转发到渲染进程
        syncManager.on('sync-started', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('sync-started', data);
            }
        });
        syncManager.on('sync-complete', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                // 统一转发
                mainWindow.webContents.send('sync-complete', { groupId: data.groupId, result: data.result });
                // 兼容已有监听
                mainWindow.webContents.send('sync-finished', { groupId: data.groupId });
            }
        });

        // 双向同步管理器事件监听
        dualSyncManager.on('log', (logEntry) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('dual-sync-log', logEntry);
            }
        });

        dualSyncManager.on('progress', (progressData) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('dual-sync-progress', progressData);
            }
        });

        dualSyncManager.on('sync-started', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('dual-sync-started', data);
            }
        });

        dualSyncManager.on('sync-complete', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('dual-sync-complete', data);
            }
        });

        dualSyncManager.on('scheduled-task-changed', (data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('dual-sync-scheduled-changed', data);
            }
        });

        logger.info('服务初始化完成');
        return true;
    } catch (error) {
        logger.error('服务初始化失败:', error);
        return false;
    }
}

/**
 * 应用启动
 */
app.whenReady().then(() => {
    // 设置日志目录到用户数据目录（打包后可写）
    const userDataPath = app.getPath('userData');
    const logsPath = path.join(userDataPath, 'logs');
    logger.setLogDir(logsPath);
    
    logger.info('='.repeat(60));
    logger.info('美团同步工具启动中...');
    logger.info('架构：Electron + 同步引擎（无Python后端）');
    logger.info(`用户数据目录: ${userDataPath}`);
    logger.info(`日志目录: ${logsPath}`);
    logger.info('='.repeat(60));

    try {
        // 初始化服务
        if (!initializeServices()) {
            throw new Error('服务初始化失败');
        }

        // 创建窗口
    createWindow();

        logger.info('应用启动完成！');
  } catch (error) {
        logger.error('应用启动失败:', error);
    app.quit();
  }
});

/**
 * 所有窗口关闭时
 */
app.on('window-all-closed', () => {
    logger.info('所有窗口已关闭');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * macOS重新激活
 */
app.on('activate', () => {
  if (mainWindow === null) {
        logger.info('重新创建窗口');
    createWindow();
  }
});

/**
 * 退出前清理
 */
app.on('before-quit', () => {
    logger.info('应用退出中...');

    // 尽力 flush 异步文件写入队列，避免退出时丢日志/追溯
    // 注意：Electron 的 before-quit 不适合长时间阻塞，这里只做“尽力而为”
    try {
        fileWriteQueue.flushAll().catch(() => {});
    } catch (_) {}
    
    // 停止所有定时任务
    if (syncManager) {
        syncManager.close();
        logger.info('同步管理器已关闭');
    }

    // 停止双向同步管理器
    if (dualSyncManager) {
        dualSyncManager.close();
        logger.info('双向同步管理器已关闭');
    }
    
    // 关闭数据库
    if (db) {
        db.close();
        logger.info('数据库已关闭');
    }
    
    logger.info('资源清理完成');
});

/**
 * 捕获未处理的异常
 */
process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常:', error);
});

/**
 * IPC通信处理器 - 组管理
 */

// 获取所有组
ipcMain.handle('get-all-groups', async (event, enabledOnly = false) => {
    try {
        return db.getAllGroups(enabledOnly);
    } catch (error) {
        logger.error('获取组列表失败:', error);
        throw error;
    }
});

// 获取指定组
ipcMain.handle('get-group', async (event, groupId) => {
    try {
        return db.getGroup(groupId);
    } catch (error) {
        logger.error(`获取组失败 (${groupId}):`, error);
        throw error;
    }
});

// 添加组
ipcMain.handle('add-group', async (event, { name, elemeConfig, qnhConfig }) => {
    try {
        const groupId = db.addGroup(name, elemeConfig, qnhConfig);
        logger.info(`组添加成功: ${name} (ID: ${groupId})`);
        return { success: true, groupId };
    } catch (error) {
        logger.error('添加组失败:', error);
        return { success: false, error: error.message };
    }
});

// 更新组
ipcMain.handle('update-group', async (event, { groupId, updates }) => {
    try {
        db.updateGroup(groupId, updates);
        logger.info(`组更新成功: ${groupId}`);
        return { success: true };
    } catch (error) {
        logger.error(`更新组失败 (${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 删除组
ipcMain.handle('delete-group', async (event, groupId) => {
    try {
        // 先停止定时任务
        syncManager.stopScheduledSync(groupId);
        
        db.deleteGroup(groupId);
        logger.info(`组删除成功: ${groupId}`);
        return { success: true };
    } catch (error) {
        logger.error(`删除组失败 (${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 复制组
ipcMain.handle('duplicate-group', async (event, { groupId, newName = null }) => {
    try {
        const newGroupId = db.duplicateGroup(groupId, newName);
        logger.info(`组复制成功: ${groupId} -> ${newGroupId}`);
        return { success: true, groupId: newGroupId };
    } catch (error) {
        logger.error(`复制组失败 (${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

/**
 * IPC通信处理器 - 同步操作
 */

// 单组同步
ipcMain.handle('sync-group', async (event, { groupId, syncType, options = {} }) => {
    try {
        logger.info(`开始同步: 组${groupId}, 类型: ${syncType}`);
        const result = await syncManager._syncGroup(groupId, syncType, options);
        logger.info(`同步完成: 组${groupId}, 结果: ${result.status}`);

        // 主动通知渲染进程（用于同步完成后刷新UI中的“上次同步信息”）
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('sync-complete', { groupId, result });
        }
        return result;
    } catch (error) {
        logger.error(`同步失败 (组${groupId}):`, error);
        return { status: 'failed', error: error.message };
    }
});

// 取消同步
ipcMain.handle('cancel-sync', async (event, { groupId }) => {
    try {
        const result = syncManager.cancel(groupId);
        return result;
    } catch (error) {
        logger.error(`取消同步失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 多组同步
ipcMain.handle('sync-multiple-groups', async (event, { groupIds, syncType, concurrency = 3, options = {} }) => {
    try {
        logger.info(`多组同步开始: ${groupIds.length}个组, 并发: ${concurrency}`);
        const results = await syncManager.syncMultipleGroups(groupIds, syncType, concurrency, options);
        logger.info('多组同步完成');
        return results;
    } catch (error) {
        logger.error('多组同步失败:', error);
        throw error;
    }
});

/**
 * IPC通信处理器 - 定时任务
 */

// 启动定时任务
ipcMain.handle('start-scheduled-sync', (event, { groupId, intervalMinutes = 10, runImmediately = true }) => {
    try {
        syncManager.startScheduledSync(groupId, intervalMinutes, { runImmediately });
        logger.info(`定时任务启动: 组${groupId}, 间隔${intervalMinutes}分钟, runImmediately=${runImmediately}`);
        return { success: true };
    } catch (error) {
        logger.error(`启动定时任务失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 停止定时任务
ipcMain.handle('stop-scheduled-sync', (event, { groupId }) => {
    try {
        syncManager.stopScheduledSync(groupId);
        logger.info(`定时任务停止: 组${groupId}`);
        return { success: true };
    } catch (error) {
        logger.error(`停止定时任务失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 获取定时任务状态
ipcMain.handle('get-scheduled-tasks', (event, groupId = null) => {
    try {
        return syncManager.getScheduledTasks(groupId);
    } catch (error) {
        logger.error('获取定时任务失败:', error);
        throw error;
    }
});

/**
 * IPC通信处理器 - 历史和日志
 */

// 获取同步历史
ipcMain.handle('get-sync-history', async (event, { groupId, limit = 50 }) => {
    try {
        if (groupId) {
            return db.getGroupSyncHistory(groupId, limit);
        } else {
            return db.getRecentSyncHistory(limit);
        }
    } catch (error) {
        logger.error('获取同步历史失败:', error);
        throw error;
    }
});

// 获取操作日志
ipcMain.handle('get-operation-logs', async (event, { groupId, limit = 100 }) => {
    try {
        if (groupId) {
            return db.getGroupLogs(groupId, limit);
        } else {
            // 全部组：合并单向 + 双向失败日志
            return db.getRecentFailedLogsCombined(limit);
        }
    } catch (error) {
        logger.error('获取操作日志失败:', error);
        throw error;
    }
});

// 获取内存日志缓存
ipcMain.handle('get-group-logs', (event, { groupId, limit = 100 }) => {
    try {
        return syncManager.getGroupLogs(groupId, limit);
    } catch (error) {
        logger.error(`获取组日志失败 (组${groupId}):`, error);
        return [];
    }
});

// 清空组日志缓存
ipcMain.handle('clear-group-logs', (event, { groupId }) => {
    try {
        syncManager.clearGroupLogs(groupId);
        return { success: true };
    } catch (error) {
        logger.error(`清空组日志失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 获取统计信息
ipcMain.handle('get-sync-stats', async (event, groupId = null) => {
    try {
        return db.getSyncStats(groupId);
    } catch (error) {
        logger.error('获取统计信息失败:', error);
        throw error;
    }
});

/**
 * IPC通信处理器 - Cookies验证
 */

// 验证饿了么cookies
ipcMain.handle('validate-eleme-cookies', async (event, { groupId, cookies }) => {
    try {
        const ElemeClient = require('./api/eleme-client');
        const result = await ElemeClient.getShopInfoFromCookies(cookies);
        
        if (result.success) {
            // 更新数据库（注意：SQLite只接受数字，布尔值要转为0/1）
            db.updateGroup(groupId, {
                eleme_cookies: cookies,
                eleme_seller_id: result.seller_id,
                eleme_store_id: result.store_id,
                eleme_store_name: result.store_name,
                eleme_cookies_valid: 1  // true -> 1
            });
            
            logger.info(`饿了么cookies验证成功: 组${groupId}, 门店: ${result.store_name}`);
            
            return {
                success: true,
                storeName: result.store_name
            };
        } else {
            logger.warn(`饿了么cookies验证失败: 组${groupId}, 错误: ${result.error}`);
            return {
                success: false,
                error: result.error
            };
        }
    } catch (error) {
        logger.error(`验证饿了么cookies失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 验证牵牛花cookies
ipcMain.handle('validate-qnh-cookies', async (event, { groupId, cookies }) => {
    try {
        const createClient = require('./api/qnh-client-factory');
        const client = createClient(null, { cookies });
        const stores = await client.getStores();
        
        // 更新数据库（注意：SQLite只接受数字，布尔值要转为0/1）
        db.updateGroup(groupId, {
            qnh_cookies: cookies,
            qnh_cookies_valid: 1  // true -> 1
        });
        
        logger.info(`牵牛花cookies验证成功: 组${groupId}, 获取到${Object.keys(stores).length}个门店`);
        
        return {
            success: true,
            stores: Object.entries(stores).map(([id, name]) => ({ id, name }))
        };
    } catch (error) {
        logger.error(`验证牵牛花cookies失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

/**
 * IPC通信处理器 - 全局配置
 */

// 获取全局配置
ipcMain.handle('get-config', async () => {
    try {
        return {
            incrementalInterval: parseInt(db.getConfig('incremental_interval', '10')),
            batchConcurrency: parseInt(db.getConfig('batch_concurrency', '3')),
            debugMode: db.getConfig('debug_mode', 'false') === 'true',
            cookiesCheckInterval: parseInt(db.getConfig('cookies_check_interval', '24')),
            dualFingerprintTimeThresholdMinutes: parseInt(db.getConfig('dual_fingerprint_time_threshold_minutes', '5')),
            platformDedupTimeThresholdSeconds: parseInt(db.getConfig('platform_dedup_time_threshold_seconds', '10')),
            incrementalLookbackMinutes: parseInt(db.getConfig('incremental_lookback_minutes', '30'))
        };
    } catch (error) {
        logger.error('获取全局配置失败:', error);
        throw error;
    }
});

// 获取用户数据目录路径
ipcMain.handle('get-user-data-path', () => {
    return path.join(app.getPath('userData'), 'data');
});

// 保存全局配置
ipcMain.handle('save-config', async (event, config) => {
    try {
        db.setConfig('incremental_interval', config.incrementalInterval.toString());
        db.setConfig('batch_concurrency', config.batchConcurrency.toString());
        db.setConfig('debug_mode', config.debugMode.toString());
        db.setConfig('cookies_check_interval', config.cookiesCheckInterval.toString());
        db.setConfig('dual_fingerprint_time_threshold_minutes', String(config.dualFingerprintTimeThresholdMinutes ?? 5));
        db.setConfig('platform_dedup_time_threshold_seconds', String(config.platformDedupTimeThresholdSeconds ?? 10));
        db.setConfig('incremental_lookback_minutes', String(config.incrementalLookbackMinutes ?? 30));
        
        // 刷新所有缓存的引擎，确保使用新配置（特别是 debugMode）
        syncManager.refreshAllEngines();
        dualSyncManager.refreshAllEngines();
        
        logger.info('全局配置已保存，已刷新所有引擎');
        return { success: true };
    } catch (error) {
        logger.error('保存全局配置失败:', error);
        return { success: false, error: error.message };
    }
});

/**
 * IPC通信处理器 - 工具方法
 */

// 获取应用版本
ipcMain.handle('get-app-version', () => {
    const packageJson = require('./package.json');
    return packageJson.version;
});

// 获取应用路径
ipcMain.handle('get-app-path', () => {
    return app.getPath('userData');
});

// 打开文件所在文件夹
ipcMain.handle('open-file', (event, filePath) => {
    const { shell } = require('electron');
    shell.showItemInFolder(filePath);
});

// 日志记录
ipcMain.on('log', (event, level, ...args) => {
    if (logger[level]) {
        logger[level](...args);
    }
});

/**
 * IPC通信处理器 - 双向同步组管理
 */

// 获取所有双向同步组
ipcMain.handle('dual-sync-get-groups', async (event, enabledOnly = false) => {
    try {
        return db.getAllDualSyncGroups(enabledOnly);
    } catch (error) {
        logger.error('获取双向同步组列表失败:', error);
        throw error;
    }
});

// 获取指定双向同步组
ipcMain.handle('dual-sync-get-group', async (event, groupId) => {
    try {
        return db.getDualSyncGroup(groupId);
    } catch (error) {
        logger.error(`获取双向同步组失败 (${groupId}):`, error);
        throw error;
    }
});

// 添加双向同步组
ipcMain.handle('dual-sync-add-group', async (event, { name, config }) => {
    try {
        const groupId = db.addDualSyncGroup(name, config || {});
        logger.info(`双向同步组添加成功: ${name} (ID: ${groupId})`);
        return { success: true, groupId };
    } catch (error) {
        logger.error('添加双向同步组失败:', error);
        return { success: false, error: error.message };
    }
});

// 更新双向同步组
ipcMain.handle('dual-sync-update-group', async (event, { groupId, updates }) => {
    try {
        db.updateDualSyncGroup(groupId, updates);
        // 刷新引擎配置
        dualSyncManager.refreshEngine(groupId);
        logger.info(`双向同步组更新成功: ${groupId}`);
        return { success: true };
    } catch (error) {
        logger.error(`更新双向同步组失败 (${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 删除双向同步组
ipcMain.handle('dual-sync-delete-group', async (event, groupId) => {
    try {
        // 先停止定时任务
        dualSyncManager.stopScheduledSync(groupId);
        db.deleteDualSyncGroup(groupId);
        logger.info(`双向同步组删除成功: ${groupId}`);
        return { success: true };
    } catch (error) {
        logger.error(`删除双向同步组失败 (${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 复制双向同步组
ipcMain.handle('dual-sync-duplicate-group', async (event, { groupId, newName }) => {
    try {
        const newGroupId = db.duplicateDualSyncGroup(groupId, newName);
        logger.info(`双向同步组复制成功: ${groupId} -> ${newGroupId}`);
        return { success: true, groupId: newGroupId };
    } catch (error) {
        logger.error(`复制双向同步组失败 (${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

/**
 * IPC通信处理器 - 双向同步操作
 */

// 执行全量同步
ipcMain.handle('dual-sync-full', async (event, { groupId, options = {} }) => {
    try {
        logger.info(`开始双向全量同步: 组${groupId}`);
        // dataDir 已在 DualSyncManager 初始化时注入，无需再传递
        const result = await dualSyncManager.fullSync(groupId, options);
        logger.info(`双向全量同步完成: 组${groupId}, 结果: ${result.status}`);
        return result;
    } catch (error) {
        logger.error(`双向全量同步失败 (组${groupId}):`, error);
        return { status: 'failed', error: error.message };
    }
});

// 执行增量同步
ipcMain.handle('dual-sync-incremental', async (event, { groupId }) => {
    try {
        logger.info(`开始双向增量同步: 组${groupId}`);
        // dataDir 已在 DualSyncManager 初始化时注入，无需再传递
        const result = await dualSyncManager.incrementalSync(groupId);
        logger.info(`双向增量同步完成: 组${groupId}, 结果: ${result.status}`);
        return result;
    } catch (error) {
        logger.error(`双向增量同步失败 (组${groupId}):`, error);
        return { status: 'failed', error: error.message };
    }
});

// 取消同步
ipcMain.handle('dual-sync-cancel', async (event, { groupId }) => {
    try {
        const result = dualSyncManager.cancel(groupId);
        return result;
    } catch (error) {
        logger.error(`取消双向同步失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

/**
 * IPC通信处理器 - 双向同步定时任务
 */

// 启动定时任务
ipcMain.handle('dual-sync-start-scheduled', (event, { groupId, intervalMinutes = 10, runImmediately = true }) => {
    try {
        // dataDir 已在 DualSyncManager 初始化时注入，无需再传递
        dualSyncManager.startScheduledSync(groupId, intervalMinutes, { runImmediately });
        logger.info(`双向同步定时任务启动: 组${groupId}, 间隔${intervalMinutes}分钟`);
        return { success: true };
    } catch (error) {
        logger.error(`启动双向同步定时任务失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 停止定时任务
ipcMain.handle('dual-sync-stop-scheduled', (event, { groupId }) => {
    try {
        dualSyncManager.stopScheduledSync(groupId);
        logger.info(`双向同步定时任务停止: 组${groupId}`);
        return { success: true };
    } catch (error) {
        logger.error(`停止双向同步定时任务失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 安全停止定时任务（查询阶段会 cancel 本轮；写入阶段默认仅停止后续定时）
ipcMain.handle('dual-sync-stop-scheduled-safe', (event, { groupId }) => {
    try {
        const result = dualSyncManager.stopScheduledSyncSafe(groupId);
        logger.info(`双向同步定时任务安全停止: 组${groupId}, action=${result.action || 'unknown'}`);
        return result;
    } catch (error) {
        logger.error(`安全停止双向同步定时任务失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 获取定时任务状态
ipcMain.handle('dual-sync-get-scheduled-tasks', (event, groupId = null) => {
    try {
        return dualSyncManager.getScheduledTasks(groupId);
    } catch (error) {
        logger.error('获取双向同步定时任务失败:', error);
        throw error;
    }
});

/**
 * IPC通信处理器 - 双向同步日志
 */

// 获取组日志
ipcMain.handle('dual-sync-get-logs', (event, { groupId, limit = 100 }) => {
    try {
        return dualSyncManager.getGroupLogs(groupId, limit);
    } catch (error) {
        logger.error(`获取双向同步日志失败 (组${groupId}):`, error);
        return [];
    }
});

// 清空组日志
ipcMain.handle('dual-sync-clear-logs', (event, { groupId }) => {
    try {
        dualSyncManager.clearGroupLogs(groupId);
        return { success: true };
    } catch (error) {
        logger.error(`清空双向同步日志失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 获取同步历史
ipcMain.handle('dual-sync-get-history', async (event, { groupId, limit = 50 }) => {
    try {
        return db.getDualSyncGroupHistory(groupId, limit);
    } catch (error) {
        logger.error('获取双向同步历史失败:', error);
        throw error;
    }
});

/**
 * IPC通信处理器 - 双向同步Cookie验证
 */

// 验证A饿了么cookies
ipcMain.handle('dual-sync-validate-a-eleme', async (event, { groupId, cookies }) => {
    try {
        const ElemeClient = require('./api/eleme-client');
        const result = await ElemeClient.getShopInfoFromCookies(cookies);
        
        if (result.success) {
            db.updateDualSyncGroup(groupId, {
                a_eleme_cookies: cookies,
                a_eleme_seller_id: result.seller_id,
                a_eleme_store_id: result.store_id,
                a_eleme_store_name: result.store_name,
                a_eleme_cookies_valid: 1
            });
            dualSyncManager.refreshEngine(groupId);
            
            logger.info(`A饿了么cookies验证成功: 组${groupId}, 门店: ${result.store_name}`);
            return { success: true, storeName: result.store_name };
        } else {
            return { success: false, error: result.error };
        }
    } catch (error) {
        logger.error(`验证A饿了么cookies失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 验证B饿了么cookies
ipcMain.handle('dual-sync-validate-b-eleme', async (event, { groupId, cookies }) => {
    try {
        const ElemeClient = require('./api/eleme-client');
        const result = await ElemeClient.getShopInfoFromCookies(cookies);
        
        if (result.success) {
            db.updateDualSyncGroup(groupId, {
                b_eleme_cookies: cookies,
                b_eleme_seller_id: result.seller_id,
                b_eleme_store_id: result.store_id,
                b_eleme_store_name: result.store_name,
                b_eleme_cookies_valid: 1
            });
            dualSyncManager.refreshEngine(groupId);
            
            logger.info(`B饿了么cookies验证成功: 组${groupId}, 门店: ${result.store_name}`);
            return { success: true, storeName: result.store_name };
        } else {
            return { success: false, error: result.error };
        }
    } catch (error) {
        logger.error(`验证B饿了么cookies失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 验证A牵牛花cookies
ipcMain.handle('dual-sync-validate-a-qnh', async (event, { groupId, cookies }) => {
    try {
        const createClient = require('./api/qnh-client-factory');
        const client = createClient(null, { cookies });
        const stores = await client.getStores();
        
        db.updateDualSyncGroup(groupId, {
            a_qnh_cookies: cookies,
            a_qnh_cookies_valid: 1
        });
        dualSyncManager.refreshEngine(groupId);
        
        logger.info(`A牵牛花cookies验证成功: 组${groupId}, 获取到${Object.keys(stores).length}个门店`);
        
        return {
            success: true,
            stores: Object.entries(stores).map(([id, name]) => ({ id, name }))
        };
    } catch (error) {
        logger.error(`验证A牵牛花cookies失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 验证B牵牛花cookies
ipcMain.handle('dual-sync-validate-b-qnh', async (event, { groupId, cookies }) => {
    try {
        const createClient = require('./api/qnh-client-factory');
        const client = createClient(null, { cookies });
        const stores = await client.getStores();
        
        db.updateDualSyncGroup(groupId, {
            b_qnh_cookies: cookies,
            b_qnh_cookies_valid: 1
        });
        dualSyncManager.refreshEngine(groupId);
        
        logger.info(`B牵牛花cookies验证成功: 组${groupId}, 获取到${Object.keys(stores).length}个门店`);
        
        return {
            success: true,
            stores: Object.entries(stores).map(([id, name]) => ({ id, name }))
        };
    } catch (error) {
        logger.error(`验证B牵牛花cookies失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 选择A牵牛花门店
ipcMain.handle('dual-sync-select-a-qnh-store', async (event, { groupId, storeId, storeName }) => {
    try {
        db.updateDualSyncGroup(groupId, {
            a_qnh_store_id: storeId,
            a_qnh_store_name: storeName
        });
        dualSyncManager.refreshEngine(groupId);
        
        logger.info(`A牵牛花门店选择成功: 组${groupId}, 门店: ${storeName}`);
        return { success: true };
    } catch (error) {
        logger.error(`选择A牵牛花门店失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 选择B牵牛花门店
ipcMain.handle('dual-sync-select-b-qnh-store', async (event, { groupId, storeId, storeName }) => {
    try {
        db.updateDualSyncGroup(groupId, {
            b_qnh_store_id: storeId,
            b_qnh_store_name: storeName
        });
        dualSyncManager.refreshEngine(groupId);
        
        logger.info(`B牵牛花门店选择成功: 组${groupId}, 门店: ${storeName}`);
        return { success: true };
    } catch (error) {
        logger.error(`选择B牵牛花门店失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// ==================== 追溯查询功能 ====================

// 按条形码查询追溯记录（增强版：包含原始记录详情）
ipcMain.handle('dual-sync-get-trace-by-barcode', async (event, { groupId, barcode, limit = 500, includeRawRecords = true }) => {
    try {
        const result = db.getDualSyncTraceByBarcode(groupId, barcode, limit);
        
        // 如果需要，从 JSON 日志中读取原始记录详情
        if (includeRawRecords) {
            const { getTraceRecordsByBarcode } = require('./utils/trace-logger');
            const dataDir = path.join(app.getPath('userData'), 'data');
            
            // 计算开始日期（用于匹配追溯日志的目录 YYYY-MM-DD，采用“本地日期”避免时区导致跨天）
            let sinceDate = null;
            if (result.fullSyncBaseline && typeof result.fullSyncBaseline.created_at === 'string') {
                // created_at 形如 2026-01-17T15:52:22（无时区），直接取日期部分最稳定
                sinceDate = result.fullSyncBaseline.created_at.slice(0, 10);
            } else {
                const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
                const y = thirtyDaysAgo.getFullYear();
                const m = String(thirtyDaysAgo.getMonth() + 1).padStart(2, '0');
                const d = String(thirtyDaysAgo.getDate()).padStart(2, '0');
                sinceDate = `${y}-${m}-${d}`;
            }
            
            // 获取 JSON 日志中的原始记录
            const rawData = getTraceRecordsByBarcode(dataDir, groupId, barcode, sinceDate, limit);
            result.rawRecordsDetail = rawData;
        }
        
        return { success: true, data: result };
    } catch (error) {
        logger.error(`查询追溯记录失败 (组${groupId}, 条形码${barcode}):`, error);
        return { success: false, error: error.message };
    }
});

// 按同步批次查询追溯记录
ipcMain.handle('dual-sync-get-trace-by-run', async (event, { groupId, syncRunId }) => {
    try {
        const records = db.getDualSyncTraceByRun(groupId, syncRunId);
        return { success: true, data: records };
    } catch (error) {
        logger.error(`查询追溯记录失败 (组${groupId}, 运行ID${syncRunId}):`, error);
        return { success: false, error: error.message };
    }
});

// 获取追溯详细日志（JSON文件）
ipcMain.handle('dual-sync-get-trace-detail', async (event, { groupId, syncRunId }) => {
    try {
        const { readTraceLog } = require('./utils/trace-logger');
        const dataDir = path.join(app.getPath('userData'), 'data');
        const logData = readTraceLog(dataDir, groupId, syncRunId);
        
        if (logData) {
            return { success: true, data: logData };
        } else {
            return { success: false, error: '未找到详细日志' };
        }
    } catch (error) {
        logger.error(`获取追溯详细日志失败 (组${groupId}, 运行ID${syncRunId}):`, error);
        return { success: false, error: error.message };
    }
});

// 列出追溯日志文件
ipcMain.handle('dual-sync-list-trace-logs', async (event, { groupId, limit = 100 }) => {
    try {
        const { listTraceLogs } = require('./utils/trace-logger');
        const dataDir = path.join(app.getPath('userData'), 'data');
        const logs = listTraceLogs(dataDir, groupId, limit);
        return { success: true, data: logs };
    } catch (error) {
        logger.error(`列出追溯日志失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// 导出追溯数据到 Excel
ipcMain.handle('dual-sync-export-trace', async (event, { groupId, barcode }) => {
    try {
        const XLSX = require('xlsx');
        const result = db.getDualSyncTraceByBarcode(groupId, barcode, 1000);
        
        // 准备 Excel 数据
        const excelData = [];
        
        // 添加全量同步基准
        if (result.fullSyncBaseline) {
            const baseline = result.fullSyncBaseline;
            excelData.push({
                '同步类型': '全量同步',
                '方向': baseline.direction || 'A->B',
                '时间': baseline.created_at,
                '原始变化量': '-',
                '过滤状态': '-',
                '去重状态': '-',
                '结果': baseline.apply_result,
                '应用前库存': baseline.current_stock,
                '目标库存': baseline.target_stock,
                '错误信息': baseline.error_msg || ''
            });
        }
        
        // 添加增量同步记录
        for (const record of result.incrementalRecords) {
            excelData.push({
                '同步类型': '增量同步',
                '方向': record.direction,
                '时间': record.created_at,
                '原始变化量': record.source_total_change,
                '过滤状态': record.was_filtered ? '是' : '否',
                '去重状态': record.was_deduplicated ? '是' : '否',
                '结果': record.apply_result,
                '应用前库存': record.current_stock,
                '目标库存': record.target_stock,
                '错误信息': record.error_msg || ''
            });
        }
        
        // 创建工作簿
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(excelData);
        XLSX.utils.book_append_sheet(wb, ws, '追溯记录');
        
        // 保存文件
        const dataDir = path.join(app.getPath('userData'), 'data', 'trace_export');
        const fs = require('fs');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        const fileName = `trace_${groupId}_${barcode}_${Date.now()}.xlsx`;
        const filePath = path.join(dataDir, fileName);
        XLSX.writeFile(wb, filePath);
        
        logger.info(`导出追溯数据: ${filePath}`);
        return { success: true, filePath };
    } catch (error) {
        logger.error(`导出追溯数据失败 (组${groupId}, 条形码${barcode}):`, error);
        return { success: false, error: error.message };
    }
});

// 获取最近一次全量同步时间
ipcMain.handle('dual-sync-get-last-full-sync-time', async (event, { groupId }) => {
    try {
        const time = db.getLastFullSyncTime(groupId);
        return { success: true, time };
    } catch (error) {
        logger.error(`获取全量同步时间失败 (组${groupId}):`, error);
        return { success: false, error: error.message };
    }
});

// ==================== 商品对账功能 ====================

/**
 * 商品对账 IPC 处理器
 * 用于诊断单个商品的库存同步状态，找出遗漏的记录
 */
ipcMain.handle('product-reconciliation', async (event, { groupId, barcode }) => {
    try {
        logger.info(`开始商品对账: 组${groupId}, 条形码${barcode}`);
        
        // 获取组信息和基线时间
        const groupInfo = db.getDualSyncGroupBaselineInfo(groupId);
        if (!groupInfo) {
            return { success: false, error: '双向同步组不存在' };
        }

        const {
            full_sync_a_baseline_time: aBaselineTime,
            full_sync_b_baseline_time: bBaselineTime,
            a_eleme_cookies: aElemeCookies,
            a_eleme_seller_id: aElemeSellerId,
            a_eleme_store_id: aElemeStoreId,
            a_qnh_cookies: aQnhCookies,
            a_qnh_store_id: aQnhStoreId,
            b_eleme_cookies: bElemeCookies,
            b_eleme_seller_id: bElemeSellerId,
            b_eleme_store_id: bElemeStoreId,
            b_qnh_cookies: bQnhCookies,
            b_qnh_store_id: bQnhStoreId
        } = groupInfo;

        if (!aBaselineTime || !bBaselineTime) {
            return { success: false, error: '未找到全量同步基线时间，请先执行全量同步' };
        }

        const ElemeClient = require('./api/eleme-client');
        const createQnhClient = require('./api/qnh-client-factory');
        const { ElemeParser } = require('./utils/parsers');
        const { toLocalISOString } = require('./utils/time-utils');

        const result = {
            barcode,
            groupId,
            // 库存对比
            stockComparison: {
                aQnhStock: null,
                bQnhStock: null,
                diff: null
            },
            // A侧对账结果
            aSide: {
                baselineTime: aBaselineTime,
                elemeRecords: [],
                traceRecords: [],
                missingRecords: []
            },
            // B侧对账结果
            bSide: {
                baselineTime: bBaselineTime,
                elemeRecords: [],
                traceRecords: [],
                missingRecords: []
            }
        };

        const now = new Date();
        const nowIso = toLocalISOString(now);
        const nowTimestamp = Math.floor(now.getTime() / 1000);

        // 1. 查询 A/B 牵牛花当前库存
        try {
            const aQnhClient = createQnhClient(null, { cookies: aQnhCookies });
            const aStockData = await aQnhClient.getStockByBarcodes(aQnhStoreId, [barcode]);
            if (aStockData[barcode]) {
                result.stockComparison.aQnhStock = aStockData[barcode].stock;
            }
        } catch (error) {
            logger.warn(`查询A牵牛花库存失败: ${error.message}`);
        }

        try {
            const bQnhClient = createQnhClient(null, { cookies: bQnhCookies });
            const bStockData = await bQnhClient.getStockByBarcodes(bQnhStoreId, [barcode]);
            if (bStockData[barcode]) {
                result.stockComparison.bQnhStock = bStockData[barcode].stock;
            }
        } catch (error) {
            logger.warn(`查询B牵牛花库存失败: ${error.message}`);
        }

        // 计算库存差值
        if (result.stockComparison.aQnhStock !== null && result.stockComparison.bQnhStock !== null) {
            result.stockComparison.diff = result.stockComparison.aQnhStock - result.stockComparison.bQnhStock;
        }

        // 2. 查询 A 饿了么操作记录（从基线时间到当前）
        try {
            const aElemeClient = new ElemeClient({
                cookies: aElemeCookies,
                seller_id: aElemeSellerId,
                store_id: aElemeStoreId
            });

            const aStartTimestamp = Math.floor(new Date(aBaselineTime).getTime() / 1000);
            let aAllLogs = [];
            let aPage = 1;

            // 分页查询（使用条形码过滤）
            while (true) {
                const logsData = await aElemeClient.queryOperationLog(
                    aStartTimestamp,
                    nowTimestamp,
                    aPage,
                    100,
                    0,
                    barcode  // 使用条形码过滤
                );

                const logs = logsData.data || [];
                aAllLogs.push(...logs);

                if (aPage * 100 >= (logsData.total || 0) || logs.length === 0) {
                    break;
                }
                aPage++;
            }

            // 解析操作记录
            const aParsedLogs = ElemeParser.parseOperationLogs({ data: aAllLogs });
            result.aSide.elemeRecords = aParsedLogs.map(log => ({
                opTime: log.op_time,
                opUser: log.op_user,
                oldStock: log.stock_change?.old_stock,
                newStock: log.stock_change?.new_stock,
                change: log.stock_change?.change
            }));
        } catch (error) {
            logger.warn(`查询A饿了么操作记录失败: ${error.message}`);
        }

        // 3. 查询 B 饿了么操作记录（从基线时间到当前）
        try {
            const bElemeClient = new ElemeClient({
                cookies: bElemeCookies,
                seller_id: bElemeSellerId,
                store_id: bElemeStoreId
            });

            const bStartTimestamp = Math.floor(new Date(bBaselineTime).getTime() / 1000);
            let bAllLogs = [];
            let bPage = 1;

            // 分页查询（使用条形码过滤）
            while (true) {
                const logsData = await bElemeClient.queryOperationLog(
                    bStartTimestamp,
                    nowTimestamp,
                    bPage,
                    100,
                    0,
                    barcode  // 使用条形码过滤
                );

                const logs = logsData.data || [];
                bAllLogs.push(...logs);

                if (bPage * 100 >= (logsData.total || 0) || logs.length === 0) {
                    break;
                }
                bPage++;
            }

            // 解析操作记录
            const bParsedLogs = ElemeParser.parseOperationLogs({ data: bAllLogs });
            result.bSide.elemeRecords = bParsedLogs.map(log => ({
                opTime: log.op_time,
                opUser: log.op_user,
                oldStock: log.stock_change?.old_stock,
                newStock: log.stock_change?.new_stock,
                change: log.stock_change?.change
            }));
        } catch (error) {
            logger.warn(`查询B饿了么操作记录失败: ${error.message}`);
        }

        // 4. 查询本地追溯记录
        // A->B 方向的追溯记录（A饿了么变化同步到B）
        const aTraceRecords = db.getTraceRecordsByBarcodeAndTimeRange(
            groupId, barcode, aBaselineTime, nowIso, 'A->B'
        );
        result.aSide.traceRecords = aTraceRecords.map(r => ({
            syncTime: r.created_at,
            direction: r.direction,
            sourceTotalChange: r.source_total_change,
            targetStock: r.target_stock,
            applyResult: r.apply_result
        }));

        // B->A 方向的追溯记录（B饿了么变化同步到A）
        const bTraceRecords = db.getTraceRecordsByBarcodeAndTimeRange(
            groupId, barcode, bBaselineTime, nowIso, 'B->A'
        );
        result.bSide.traceRecords = bTraceRecords.map(r => ({
            syncTime: r.created_at,
            direction: r.direction,
            sourceTotalChange: r.source_total_change,
            targetStock: r.target_stock,
            applyResult: r.apply_result
        }));

        // 5. 对比找出缺失的记录
        // 构建追溯记录的指纹集合（用于对比）
        const buildFingerprintSet = (traceRecords) => {
            const set = new Set();
            for (const r of traceRecords) {
                // 使用变化量作为简单的指纹
                if (r.sourceTotalChange !== null && r.sourceTotalChange !== undefined) {
                    set.add(r.sourceTotalChange);
                }
            }
            return set;
        };

        // A侧：找出饿了么有但追溯表没有的记录
        // 注意：这是一个简化的对比逻辑，实际可能需要更复杂的匹配
        const aTraceFingerprintSet = buildFingerprintSet(result.aSide.traceRecords);
        for (const record of result.aSide.elemeRecords) {
            // 排除工具同步产生的记录（包含【API】或【子门店】）
            if (record.opUser && (record.opUser.includes('【API】') || record.opUser.includes('【子门店】'))) {
                continue;
            }
            // 检查是否在追溯记录中
            if (record.change !== null && record.change !== undefined && !aTraceFingerprintSet.has(record.change)) {
                result.aSide.missingRecords.push(record);
            }
        }

        // B侧：同理
        const bTraceFingerprintSet = buildFingerprintSet(result.bSide.traceRecords);
        for (const record of result.bSide.elemeRecords) {
            // 排除工具同步产生的记录
            if (record.opUser && (record.opUser.includes('【API】') || record.opUser.includes('【子门店】'))) {
                continue;
            }
            // 检查是否在追溯记录中
            if (record.change !== null && record.change !== undefined && !bTraceFingerprintSet.has(record.change)) {
                result.bSide.missingRecords.push(record);
            }
        }

        logger.info(`商品对账完成: A侧缺失${result.aSide.missingRecords.length}条, B侧缺失${result.bSide.missingRecords.length}条`);
        return { success: true, data: result };
    } catch (error) {
        logger.error(`商品对账失败: ${error.message}`);
        return { success: false, error: error.message };
    }
});

logger.info('主进程初始化完成');
logger.info('IPC事件处理器已注册');
