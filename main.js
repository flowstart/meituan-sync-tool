/**
 * Electron主进程
 * 集成同步引擎 - 提供完整的库存同步功能
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const logger = require('./utils/logger');
const SyncDatabase = require('./database/database');
const SyncManager = require('./core/sync-manager');
const DualSyncManager = require('./core/dual-sync-manager');

let mainWindow = null;
let db = null;
let syncManager = null;
let dualSyncManager = null;

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

        // 初始化双向同步管理器
        dualSyncManager = new DualSyncManager(db);
        logger.info('双向同步管理器初始化完成');

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
            return db.getRecentLogs(limit);
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
            cookiesCheckInterval: parseInt(db.getConfig('cookies_check_interval', '24'))
        };
    } catch (error) {
        logger.error('获取全局配置失败:', error);
        throw error;
    }
});

// 保存全局配置
ipcMain.handle('save-config', async (event, config) => {
    try {
        db.setConfig('incremental_interval', config.incrementalInterval.toString());
        db.setConfig('batch_concurrency', config.batchConcurrency.toString());
        db.setConfig('debug_mode', config.debugMode.toString());
        db.setConfig('cookies_check_interval', config.cookiesCheckInterval.toString());
        
        logger.info('全局配置已保存');
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
        // 确保传入用户数据目录下的 data 子目录，避免打包后路径问题
        const exportDir = path.join(app.getPath('userData'), 'data');
        const result = await dualSyncManager.fullSync(groupId, { ...options, exportDir });
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

logger.info('主进程初始化完成');
logger.info('IPC事件处理器已注册');
