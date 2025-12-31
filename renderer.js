// 美团同步工具 - 前端逻辑
// 使用Electron IPC通信

const { ipcRenderer } = require('electron');
const { toLocalISOString, toLocalDateString } = require('./utils/time-utils');

// 全局状态
let groups = [];
let logs = {}; // {group_id: [logs]}
let currentEditingGroupId = null; // 正在编辑的组ID
let currentCookieConfig = null; // 当前Cookie配置 {groupId, type: 'eleme'/'qnh'}
let globalConfig = {
    incrementalInterval: 10,
    batchConcurrency: 3,
    debugMode: false,
    cookiesCheckInterval: 24
};
// 运行状态缓存：避免重新渲染时丢失同步状态与按钮隐藏
// 结构: { [groupId]: { syncing: boolean, type: 'full'|'incremental', progress?: number, message?: string } }
let runningStates = {};
// 定时任务状态 { [groupId]: boolean }
let scheduledTasksActive = {};

// ==================== 初始化 ====================

document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 前端初始化...');

    // 初始化IPC监听
    initIPCListeners();

    // 初始化UI事件
    initUIEvents();

    // 显示版本号
    await updateVersionDisplay();

    // 加载全局配置
    loadConfig();

    // 加载同步组数据
    loadGroups();
    
    // 加载双向同步组数据（默认页面为双向同步）
    loadDualSyncGroups();
});

// ==================== 版本显示 ====================

let appVersion = '1.0.0'; // 默认版本

async function updateVersionDisplay() {
    try {
        appVersion = await ipcRenderer.invoke('get-app-version');
        updateStatusBar();
        
        // 在控制台显示欢迎信息
        console.log('='.repeat(60));
        console.log(`🚀 美团同步工具 V${appVersion}`);
        console.log(`📦 Electron 应用 | Node.js ${process.versions.node}`);
        console.log('='.repeat(60));
    } catch (error) {
        console.error('获取版本号失败:', error);
    }
}

// 更新状态栏显示（可在任何地方调用）
function updateStatusBar(customMessage = null) {
    const statusBar = document.getElementById('statusBar');
    if (statusBar) {
        if (customMessage) {
            statusBar.textContent = `🟢 V${appVersion} | ${customMessage}`;
        } else {
            statusBar.textContent = `🟢 V${appVersion} 系统运行正常`;
        }
    }
}

// ==================== IPC监听 ====================

function initIPCListeners() {
    console.log('🔌 初始化IPC监听...');

    // 监听实时日志
    ipcRenderer.on('sync-log', (event, logEntry) => {
        console.log('[日志推送]', logEntry);
        addLog(logEntry.groupId, logEntry.level, logEntry.message);
    });

    // 监听同步进度
    ipcRenderer.on('sync-progress', (event, { groupId, progress, message }) => {
        // 更新运行状态缓存，便于UI重新渲染后恢复进度条
        if (!runningStates[groupId]) {
            runningStates[groupId] = { syncing: true, type: 'incremental', progress: 0, message: '' };
        }
        runningStates[groupId].progress = progress;
        runningStates[groupId].message = message;
        updateProgress(groupId, progress, message);
    });

    // 同步开始/结束
    ipcRenderer.on('sync-started', (event, { groupId, type }) => {
        setGroupSyncState(groupId, true, type);
    });
    ipcRenderer.on('sync-finished', (event, { groupId }) => {
        setGroupSyncState(groupId, false);
    });

    // 监听同步完成事件
    ipcRenderer.on('sync-complete', (event, { groupId, result }) => {
        // 特殊提示：需要先全量
        if (result && result.status === 'failed' && result.error === 'require_full_sync_first') {
            alert('⚠️ 请先执行一次全量同步，再开启增量同步。');
        }
        handleSyncComplete(groupId, result);
    });

    // 监听定时任务状态变化
    ipcRenderer.on('scheduled-task-changed', (event, data) => {
        console.log('[定时任务状态变化]', data);
        scheduledTasksActive[data.groupId] = data.action === 'start';
        updateScheduledTaskStatus(data.groupId, data.action);
        const state = runningStates[data.groupId];
        const isRunning = state && state.syncing;
        setIndeterminateProgress(data.groupId, scheduledTasksActive[data.groupId] && !isRunning);
    });

    // 监听cookies失效通知
    ipcRenderer.on('cookies-invalid', (event, { groupId, type }) => {
        handleCookiesInvalid(groupId, type);
    });

    updateConnectionStatus(true);
    console.log('✅ IPC监听已初始化');
}

function updateConnectionStatus(connected) {
    const statusDot = document.getElementById('connectionStatus');
    const statusText = document.getElementById('connectionText');

    if (connected) {
        statusDot.className = 'status-dot';
        statusText.textContent = '就绪';
    } else {
        statusDot.className = 'status-dot disconnected';
        statusText.textContent = '未连接';
    }
}

// ==================== IPC请求封装 ====================

async function ipcRequest(channel, ...args) {
    try {
        console.log(`[IPC请求] ${channel}`, ...args);
        const result = await ipcRenderer.invoke(channel, ...args);
        console.log(`[IPC响应] ${channel}`, result);
        return result;
    } catch (error) {
        console.error(`[IPC错误] ${channel}:`, error);
        alert(`操作失败: ${error.message}`);
        throw error;
    }
}

// ==================== UI事件 ====================

function initUIEvents() {
    // 页面切换
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const page = tab.dataset.page;
            switchPage(page);
        });
    });

    // 增加组按钮 - 直接创建，不弹窗
    document.getElementById('addGroupBtn').addEventListener('click', createGroupDirectly);

    // 全局配置按钮
    document.getElementById('globalConfigBtn').addEventListener('click', async () => {
        switchPage('config');
        await loadConfigToForm();
    });

    // 刷新日志按钮
    document.getElementById('refreshLogsBtn').addEventListener('click', () => {
        renderLogs();
    });

    // 清空所有日志按钮
    document.getElementById('clearAllLogsBtn').addEventListener('click', () => {
        logs = {};
        renderLogs();
    });

    // 整店校准按钮
    document.getElementById('startCalibrationBtn').addEventListener('click', () => {
        startCalibration();
    });

    document.getElementById('cancelCalibrationBtn').addEventListener('click', () => {
        switchPage('work');
    });

    // 双向同步相关按钮
    const addDualSyncBtn = document.getElementById('addDualSyncGroupBtn');
    if (addDualSyncBtn) {
        addDualSyncBtn.addEventListener('click', () => openDualSyncConfigDialog());
    }

    const refreshDualSyncLogsBtn = document.getElementById('refreshDualSyncLogsBtn');
    if (refreshDualSyncLogsBtn) {
        refreshDualSyncLogsBtn.addEventListener('click', refreshDualSyncLogs);
    }

    const clearDualSyncLogsBtn = document.getElementById('clearDualSyncLogsBtn');
    if (clearDualSyncLogsBtn) {
        clearDualSyncLogsBtn.addEventListener('click', clearDualSyncLogs);
    }
}

function switchPage(pageName) {
    // 切换页面前，关闭所有可能打开的对话框，避免焦点问题
    document.querySelectorAll('dialog[open]').forEach(dialog => {
        dialog.close();
    });
    
    // 重置焦点到 body
    document.body.focus();
    
    // 切换标签页
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.page === pageName);
    });

    // 切换页面
    document.querySelectorAll('.page').forEach(page => {
        page.classList.toggle('active', page.id === `page-${pageName}`);
    });

    // 双向同步页面加载数据
    if (pageName === 'dual-sync') {
        loadDualSyncGroups();
    }

    // 加载对应数据
    if (pageName === 'calibration') {
        renderCalibrationPage();
    }
}

// ==================== 组管理 ====================

async function loadGroups() {
    try {
        console.log('📦 加载同步组...');
        groups = await ipcRequest('get-all-groups');
        console.log('获取到组:', groups);
        renderGroups();
        // 初始化定时任务状态
        try {
            const tasks = await ipcRequest('get-scheduled-tasks');
            scheduledTasksActive = {};
            if (Array.isArray(tasks)) {
                for (const t of tasks) {
                    scheduledTasksActive[t.groupId] = !!t.isActive;
                }
            }
            for (const g of groups) {
                const isActive = !!scheduledTasksActive[g.id];
                const isRunning = runningStates[g.id] && runningStates[g.id].syncing;
                setIndeterminateProgress(g.id, isActive && !isRunning);
            }
        } catch (e) {
            console.warn('获取定时任务状态失败:', e);
        }
        renderCalibrationPage();
    } catch (error) {
        console.error('加载组失败:', error);
        document.getElementById('groupsContainer').innerHTML = `
            <div class="loading-placeholder">
                <div style="color: #ff4d4f;">❌ 加载失败</div>
                <div style="font-size: 12px; margin-top: 8px;">${error.message}</div>
                <button onclick="loadGroups()" style="margin-top: 12px; padding: 8px 16px;">重试</button>
            </div>
        `;
    }
}

/**
 * 检查组是否可以同步
 * @param {Object} group - 组对象
 * @returns {boolean} 是否可以同步
 */
function canSync(group) {
    // 检查饿了么cookies是否配置
    const hasElemeCookies = group.eleme_cookies && group.eleme_cookies.trim() !== '';
    
    // 检查牵牛花cookies是否配置
    const hasQnhCookies = group.qnh_cookies && group.qnh_cookies.trim() !== '';
    
    // 检查牵牛花门店是否选择
    const hasQnhStore = group.qnh_store_id && group.qnh_store_id.trim() !== '';
    
    // 只有三个条件都满足才可以同步
    return hasElemeCookies && hasQnhCookies && hasQnhStore;
}

function renderGroups() {
    const container = document.getElementById('groupsContainer');

    if (groups.length === 0) {
        container.innerHTML = `
            <div class="loading-placeholder">
                <div>暂无同步组</div>
                <div style="font-size: 12px; margin-top: 8px; color: #8c8c8c;">
                    点击「➕ 增加组」添加第一个同步组
                </div>
            </div>
        `;
        return;
    }

    container.innerHTML = groups.map(group => {
        // Cookie直接显示字符串（前50个字符）
        const elemeCookieDisplay = group.eleme_cookies && group.eleme_cookies.trim()
            ? group.eleme_cookies.substring(0, 50) + '...'
            : '点击配置Cookie';

        const qnhCookieDisplay = group.qnh_cookies && group.qnh_cookies.trim()
            ? group.qnh_cookies.substring(0, 50) + '...'
            : '点击配置Cookie';

        // 显示门店信息
        const elemeStoreInfo = group.eleme_store_name
            ? `📍 店铺名称: ${group.eleme_store_name}`
            : (group.eleme_cookies && group.eleme_cookies.trim()
                ? '<span style="color: #faad14;">请重新配置Cookie以获取门店信息</span>'
                : '<span style="color: #8c8c8c;">未配置</span>');

        // 牵牛花门店下拉框和刷新按钮
        const qnhStoreList = window.qnhStores && window.qnhStores[group.id] ? window.qnhStores[group.id] : [];
        let qnhStoreSelect = '';
        let qnhRefreshBtn = '';

        if (qnhStoreList.length > 0 || (group.qnh_store_id && group.qnh_store_name)) {
            // 如果有门店列表或已选择门店，显示下拉框
            if (qnhStoreList.length === 0 && group.qnh_store_id && group.qnh_store_name) {
                // 重新打开软件，只有已选择的门店，需要构建列表
                qnhStoreList.push({
                    id: group.qnh_store_id,
                    name: group.qnh_store_name
                });
                // 同时保存到全局变量
                if (!window.qnhStores) {
                    window.qnhStores = {};
                }
                window.qnhStores[group.id] = qnhStoreList;
            }
            
            qnhStoreSelect = `
                <select class="config-select" onchange="selectQnhStore(${group.id}, this.value)" style="flex: 1;">
                    <option value="">请选择门店...</option>
                    ${qnhStoreList.map(store => `
                        <option value="${store.id}" ${store.id === group.qnh_store_id ? 'selected' : ''}>
                            ${store.name}（${store.id}）
                        </option>
                    `).join('')}
                </select>
                <button class="refresh-btn" onclick="refreshQnhStores(${group.id})" title="刷新门店列表">
                    🔄
                </button>
            `;
        } else if (group.qnh_cookies && group.qnh_cookies.trim()) {
            // 有Cookie但未获取门店列表
            qnhStoreSelect = `
                <input type="text" class="config-input" value="请先获取门店列表" readonly disabled style="flex: 1;">
                <button class="refresh-btn" onclick="refreshQnhStores(${group.id})" title="获取门店列表">
                    🔄
                </button>
            `;
        } else {
            // 未配置Cookie
            qnhStoreSelect = `<input type="text" class="config-input" value="请先配置Cookie" readonly disabled style="flex: 1;">`;
        }

        const isSyncing = !!(runningStates[group.id] && runningStates[group.id].syncing);
        const isScheduled = !!scheduledTasksActive[group.id];
        const syncingType = isSyncing ? (runningStates[group.id].type || '') : '';
        // 同步信息（从最近历史中获取）
        const fullInfo = group.last_full_sync_time && group.last_full_sync_count >= 0
            ? `✅ 全量: ${formatBeijingTime(group.last_full_sync_time)} | ${group.last_full_sync_count}个商品`
            : '';
        const incrInfo = group.last_incr_sync_time && group.last_incr_sync_count >= 0
            ? `🔄 增量: ${formatBeijingTime(group.last_incr_sync_time)} | ${group.last_incr_sync_count}个商品`
            : '';

        return `
        <div class="group-card${isSyncing ? ' syncing' : ''}" data-group-id="${group.id}">
            <div class="group-header">
                <div class="group-name">
                    🔷 ${group.name}
                    <span class="group-status">${isSyncing ? (syncingType === 'full' ? '🔄 全量同步中' : '▶️ 增量同步中') : '⏹️ 待机'}</span>
                </div>
                <div class="group-tools">
                    <button class="tool-btn" title="复制该组" onclick="duplicateGroup(${group.id})">📄 复制</button>
                    <button class="tool-btn" title="编辑组名" onclick="editGroup(${group.id})">✏️ 编辑</button>
                    <button class="tool-btn danger" title="删除该组" onclick="deleteGroup(${group.id})">🗑️ 删除</button>
                </div>
            </div>

            <div class="group-content">
                <!-- 饿了么配置 -->
                <div class="config-row">
                    <div class="config-label">饿了么:</div>
                    <input type="text" class="config-input" value="${elemeCookieDisplay}"
                           readonly onclick="openCookieDialog(${group.id}, 'eleme')"
                           title="点击配置Cookie">
                </div>
                <div class="store-info">${elemeStoreInfo}</div>

                <!-- 箭头 -->
                <div style="text-align: center; margin: 10px 0;">
                    <span class="arrow">⬇️</span>
                </div>

                <!-- 牵牛花配置 -->
                <div class="config-row">
                    <div class="config-label">牵牛花:</div>
                    <input type="text" class="config-input" value="${qnhCookieDisplay}"
                           readonly onclick="openCookieDialog(${group.id}, 'qnh')"
                           title="点击配置Cookie">
                </div>
                <div class="config-row">
                    <div class="config-label">门店:</div>
                    <div style="display: flex; gap: 8px; flex: 1;">
                        ${qnhStoreSelect}
                    </div>
                </div>
            </div>

            <div class="group-actions">
                <button class="action-btn primary btn-incremental" 
                        onclick="startIncrementalSync(${group.id})"
                        ${!canSync(group) || isSyncing || isScheduled ? 'disabled title=\"请先完成饿了么Cookie、牵牛花Cookie和门店配置\"' : ''}
                        style="${isSyncing || isScheduled ? 'display:none;' : ''}">
                    ▶️ 增量同步
                </button>
                <button class="action-btn success btn-full" 
                        onclick="startFullSync(${group.id})"
                        ${!canSync(group) || isSyncing ? 'disabled title=\"请先完成饿了么Cookie、牵牛花Cookie和门店配置\"' : ''}
                        style="${isSyncing ? 'display:none;' : ''}">
                    🔄 全量同步
                </button>
                <button class="action-btn warning btn-cancel" style="${(isSyncing || isScheduled) ? '' : 'display:none;'}" onclick="cancelSync(${group.id})">
                    ⏸️ 暂停/停止
                </button>
            </div>
            <div class="sync-info">
                ${fullInfo ? `<div class="sync-record">${fullInfo}</div>` : ''}
                ${incrInfo ? `<div class="sync-record">${incrInfo}</div>` : ''}
            </div>
        </div>
        `;
    }).join('');

    // 渲染后恢复正在同步的进度条
    for (const [gid, state] of Object.entries(runningStates)) {
        if (state.syncing) {
            updateProgress(parseInt(gid), state.progress ?? 0, state.message ?? '');
        }
    }
}

function formatBeijingTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const beijingOffset = 8 * 60;
    const localOffset = d.getTimezoneOffset();
    const bj = new Date(d.getTime() + (beijingOffset + localOffset) * 60000);
    const y = bj.getFullYear();
    const m = String(bj.getMonth() + 1).padStart(2, '0');
    const day = String(bj.getDate()).padStart(2, '0');
    const hh = String(bj.getHours()).padStart(2, '0');
    const mm = String(bj.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${hh}:${mm}`;
}

// ==================== 同步操作 ====================

async function startIncrementalSync(groupId) {
    try {
        console.log('开始增量同步:', groupId);

        // 清空该组的日志
        logs[groupId] = [];
        renderLogs();

        // 进入待机态：显示无限进度条、隐藏开始按钮，仅显示暂停按钮
        setIndeterminateProgress(groupId, true);

        // 直接开启定时任务（符合预期：点击增量即开启持续循环）
        await ipcRequest('start-scheduled-sync', {
            groupId,
            intervalMinutes: globalConfig.incrementalInterval
        });
        console.log('定时增量同步已启动');
    } catch (error) {
        console.error('启动增量同步失败:', error);
    }
}

async function startFullSync(groupId) {
    // 显示三选项确认框
    showFullSyncDialog(groupId);
}

function showFullSyncDialog(groupId) {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.id = 'fullSyncDialog';
    dialog.innerHTML = `
        <div class="dialog-header">
            <h3>🔄 全量同步确认</h3>
            <button class="dialog-close" onclick="closeFullSyncDialog()">✕</button>
        </div>
        <div class="dialog-content">
            <p style="margin-bottom: 12px;">全量同步会导出所有商品并更新库存，耗时较长（5-15分钟）。</p>
            <p style="font-weight: bold;">请选择操作：</p>
        </div>
        <div class="dialog-footer">
            <button class="btn btn-secondary" onclick="closeFullSyncDialog()">
                取消
            </button>
            <button class="btn btn-primary" onclick="doFullSync(${groupId}, false)">
                仅全量同步
            </button>
            <button class="btn btn-success" onclick="doFullSync(${groupId}, true)">
                全量同步并开启增量
            </button>
        </div>
    `;
    
    document.body.appendChild(dialog);
    dialog.showModal();
}

function closeFullSyncDialog() {
    const dialog = document.getElementById('fullSyncDialog');
    if (dialog) {
        dialog.close();
        dialog.remove();
    }
}

async function doFullSync(groupId, startIncremental) {
    try {
        closeFullSyncDialog();
        
        console.log('开始全量同步:', groupId, '自动开启增量:', startIncremental);

        // 清空该组的日志
        logs[groupId] = [];
        renderLogs();

        const fullResult = await ipcRequest('sync-group', {
            groupId,
            syncType: 'full'
        });

        // 如果选择了自动开启增量，且全量成功，才启动定时任务
        if (startIncremental && fullResult && fullResult.status === 'success') {
            await ipcRequest('start-scheduled-sync', {
                groupId,
                intervalMinutes: globalConfig.incrementalInterval,
                runImmediately: false // 首次延迟执行：避免全量完成后立刻跑增量
            });
            console.log('定时增量同步已启动（首次延迟执行）');
        } else if (startIncremental) {
            console.warn('全量未成功（失败或被取消），不会启动定时增量任务');
            alert('⚠️ 全量未成功，已取消“开启增量”的请求');
        }
        
        console.log('全量同步已启动');
    } catch (error) {
        console.error('启动全量同步失败:', error);
    }
}

function editGroup(groupId) {
    openEditGroupDialog(groupId);
}

async function deleteGroup(groupId) {
    try {
        const confirmed = confirm('确定要删除这个同步组吗？所有相关数据都将被删除。');
        if (!confirmed) return;

        await ipcRequest('delete-group', groupId);

        console.log('删除成功');
        loadGroups();
    } catch (error) {
        console.error('删除组失败:', error);
    }
}

async function duplicateGroup(groupId) {
    try {
        const group = groups.find(g => g.id === groupId);
        if (!group) return;

        // 生成建议的新组名：在原名后添加“（副本）”，避免重名
        let newName = `${group.name}（副本）`;
        // 若有重名，则追加数字
        let suffix = 2;
        while (groups.some(g => g.name === newName)) {
            newName = `${group.name}（副本${suffix}）`;
            suffix += 1;
        }

        const res = await ipcRequest('duplicate-group', { groupId, newName });
        if (res && res.success) {
            console.log('复制成功，新组ID:', res.groupId);
            await loadGroups();
            alert('✅ 已复制同步组，请为新组选择牵牛花门店');
        } else {
            alert('❌ 复制失败: ' + ((res && res.error) || '未知错误'));
        }
    } catch (e) {
        console.error('复制组失败:', e);
        alert('❌ 复制失败: ' + e.message);
    }
}

// ==================== 日志管理 ====================

function addLog(groupId, level, message) {
    if (!logs[groupId]) {
        logs[groupId] = [];
    }

    // 使用本地时间（北京时间）
    const timestamp = toLocalISOString();
    logs[groupId].push({ timestamp, level, message });

    // 限制日志数量（最多1000条）
    if (logs[groupId].length > 1000) {
        logs[groupId].shift();
    }

    renderLogs();
}

function renderLogs() {
    const container = document.getElementById('logsContainer');

    // 无组时展示占位
    if (!groups || groups.length === 0) {
        container.innerHTML = `
            <div class="no-logs">
                <p>暂无日志</p>
                <p style="font-size: 12px; color: #8c8c8c;">开始同步后将显示实时日志</p>
            </div>
        `;
        return;
    }

    // 日志面板顺序：与左侧组列表一致（新在上、老在下），确保左右对应
    const orderedGroups = groups.slice();

    container.innerHTML = orderedGroups.map(group => {
        const groupId = group.id;
        const groupName = group.name || `组 ${groupId}`;
        const logList = logs[groupId] || [];

        const contentHtml = logList.length > 0
            ? logList.map(log => {
                const bj = formatBeijingTime(log.timestamp);
                return `
                    <div class="log-line">
                        <span class="log-time">${bj}</span> |
                        <span class="log-level-${log.level}">${log.level.toUpperCase()}</span> |
                        ${log.message}
                    </div>
                `;
            }).join('')
            : `
                <div class="log-line" style="color: #8c8c8c;">
                    暂无日志，开始同步后将在此显示
                </div>
            `;

        return `
            <div class="log-card">
                <div class="log-header">
                    <div class="log-title">📋 ${groupName}</div>
                    <div class="log-actions">
                        <button class="log-btn" onclick="clearGroupLogs(${groupId})">清空</button>
                        <button class="log-btn" onclick="exportGroupLogs(${groupId})">导出</button>
                    </div>
                </div>
                <div class="log-content">
                    ${contentHtml}
                </div>
            </div>
        `;
    }).join('');

    // 自动滚动到每个日志卡片的底部
    const logCards = container.querySelectorAll('.log-content');
    logCards.forEach(card => {
        card.scrollTop = card.scrollHeight;
    });
}

function clearGroupLogs(groupId) {
    logs[groupId] = [];
    renderLogs();
}

function exportGroupLogs(groupId) {
    alert(`导出组 ${groupId} 日志功能开发中...`);
    // TODO: 导出日志到文件
}

// ==================== 失败日志管理 ====================

/**
 * 打开失败日志对话框
 */
async function viewFailedLogs() {
    const dialog = document.getElementById('failedLogsDialog');
    
    // 填充组筛选下拉框
    const groupFilter = document.getElementById('failedLogsGroupFilter');
    groupFilter.innerHTML = '<option value="">全部组</option>';
    for (const group of groups) {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        groupFilter.appendChild(option);
    }
    
    dialog.showModal();
    
    // 加载日志
    await refreshFailedLogs();
}

/**
 * 关闭失败日志对话框
 */
function closeFailedLogsDialog() {
    document.getElementById('failedLogsDialog').close();
}

/**
 * 刷新失败日志
 */
async function refreshFailedLogs() {
    const groupFilter = document.getElementById('failedLogsGroupFilter');
    const limitFilter = document.getElementById('failedLogsLimitFilter');
    const content = document.getElementById('failedLogsContent');
    
    const groupId = groupFilter.value ? parseInt(groupFilter.value) : null;
    const limit = parseInt(limitFilter.value);
    
    try {
        content.innerHTML = '<div style="text-align: center; color: #999;">加载中...</div>';
        
        const logs = await ipcRequest('get-operation-logs', { groupId, limit });
        
        if (!logs || logs.length === 0) {
            content.innerHTML = '<div style="text-align: center; color: #999;">✅ 暂无失败记录</div>';
            return;
        }
        
        // 渲染失败日志表格
        let html = `
            <table style="width: 100%; border-collapse: collapse; background: white;">
                <thead>
                    <tr style="background: #f0f0f0; border-bottom: 2px solid #ddd;">
                        <th style="padding: 10px; text-align: left;">时间</th>
                        <th style="padding: 10px; text-align: left;">组名</th>
                        <th style="padding: 10px; text-align: left;">类型</th>
                        <th style="padding: 10px; text-align: left;">条形码</th>
                        <th style="padding: 10px; text-align: center;">旧库存</th>
                        <th style="padding: 10px; text-align: center;">新库存</th>
                        <th style="padding: 10px; text-align: left;">错误信息</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        for (const log of logs) {
            const time = new Date(log.created_at).toLocaleString('zh-CN', { 
                timeZone: 'Asia/Shanghai',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            
            const groupName = log.group_name || '未知';
            const operationType =
                log.operation_type === 'full_sync' ? '全量同步' :
                log.operation_type === 'dual_full_sync' ? '双向全量同步' :
                log.operation_type === 'dual_incr_sync' ? '双向增量同步' :
                '增量同步';
            const oldStock = log.old_stock !== null ? log.old_stock : '-';
            const newStock = log.new_stock !== null ? log.new_stock : '-';
            const errorMsg = log.error_msg || '未知错误';
            
            html += `
                <tr style="border-bottom: 1px solid #eee;">
                    <td style="padding: 8px; font-size: 12px;">${time}</td>
                    <td style="padding: 8px;">${groupName}</td>
                    <td style="padding: 8px;">${operationType}</td>
                    <td style="padding: 8px; font-family: monospace;">${log.barcode || '-'}</td>
                    <td style="padding: 8px; text-align: center;">${oldStock}</td>
                    <td style="padding: 8px; text-align: center;">${newStock}</td>
                    <td style="padding: 8px; font-size: 12px; color: #d32f2f;">${errorMsg}</td>
                </tr>
            `;
        }
        
        html += '</tbody></table>';
        content.innerHTML = html;
        
    } catch (error) {
        console.error('加载失败日志失败:', error);
        content.innerHTML = '<div style="text-align: center; color: #d32f2f;">❌ 加载失败: ' + error.message + '</div>';
    }
}

/**
 * 导出失败日志为 CSV
 */
async function exportFailedLogs() {
    const groupFilter = document.getElementById('failedLogsGroupFilter');
    const limitFilter = document.getElementById('failedLogsLimitFilter');
    
    const groupId = groupFilter.value ? parseInt(groupFilter.value) : null;
    const limit = parseInt(limitFilter.value);
    
    try {
        const logs = await ipcRequest('get-operation-logs', { groupId, limit });
        
        if (!logs || logs.length === 0) {
            alert('没有可导出的失败日志');
            return;
        }
        
        // 生成 CSV 内容
        let csv = '时间,组名,类型,条形码,旧库存,新库存,错误信息\n';
        
        for (const log of logs) {
            const time = new Date(log.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            const groupName = log.group_name || '未知';
            const operationType =
                log.operation_type === 'full_sync' ? '全量同步' :
                log.operation_type === 'dual_full_sync' ? '双向全量同步' :
                log.operation_type === 'dual_incr_sync' ? '双向增量同步' :
                '增量同步';
            const barcode = log.barcode || '-';
            const oldStock = log.old_stock !== null ? log.old_stock : '-';
            const newStock = log.new_stock !== null ? log.new_stock : '-';
            const errorMsg = (log.error_msg || '未知错误').replace(/"/g, '""'); // 转义引号
            
            csv += `"${time}","${groupName}","${operationType}","${barcode}","${oldStock}","${newStock}","${errorMsg}"\n`;
        }
        
        // 创建下载
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }); // 添加 BOM 以支持 Excel
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `失败日志_${toLocalDateString()}.csv`;
        link.click();
        URL.revokeObjectURL(url);
        
        alert('✅ 导出成功！');
        
    } catch (error) {
        console.error('导出失败日志失败:', error);
        alert('❌ 导出失败: ' + error.message);
    }
}

// ==================== 整店校准 ====================

function renderCalibrationPage() {
    const container = document.getElementById('calibrationGroups');

    if (groups.length === 0) {
        container.innerHTML = `
            <div class="loading-placeholder">
                <div>暂无可用的同步组</div>
                <div style="font-size: 12px; margin-top: 8px; color: #8c8c8c;">
                    请先在「工作状态」页面添加同步组
                </div>
            </div>
        `;
        return;
    }

    container.innerHTML = groups.map(group => {
        const isSyncing = !!(runningStates[group.id] && runningStates[group.id].syncing);
        const okBase = canSync(group);
        const valid = !!group.eleme_cookies_valid && !!group.qnh_cookies_valid;
        const selectable = okBase && valid && !isSyncing;
        let reason = '';
        if (!okBase) {
            reason = '请先完成饿了么Cookie、牵牛花Cookie与门店配置';
        } else if (!valid) {
            reason = 'Cookies已过期或无效，请重新验证配置';
        } else if (isSyncing) {
            reason = '该组正在执行同步任务，无法选择';
        }
        const statusText = isSyncing ? '🔄 同步中' : (!valid ? '⚠️ Cookies无效' : '⏹️ 待机');

        return `
        <div class="calibration-group">
            <input type="checkbox" class="calibration-checkbox" data-group-id="${group.id}" ${selectable ? '' : 'disabled'} title="${reason}">
            <label style="flex: 1; cursor: pointer;">
                <strong>${group.name}</strong><br>
                <small style="color: #8c8c8c;">
                    饿了么店铺 ${group.eleme_store_id || '-'} → 牵牛花门店 ${group.qnh_store_id || '-'}
                </small>
            </label>
            <span class="group-status">${statusText}</span>
        </div>
        `;
    }).join('');

    // 更新选中计数
    updateCalibrationCount();

    // 绑定checkbox事件
    document.querySelectorAll('.calibration-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', updateCalibrationCount);
    });
}

function updateCalibrationCount() {
    const checked = document.querySelectorAll('.calibration-checkbox:checked');
    const btn = document.getElementById('startCalibrationBtn');
    btn.textContent = `🚀 开始校准选中的组 (${checked.length})`;
    btn.disabled = checked.length === 0;
}

async function startCalibration() {
    const checked = document.querySelectorAll('.calibration-checkbox:checked');
    const groupIds = Array.from(checked).map(cb => parseInt(cb.dataset.groupId));

    if (groupIds.length === 0) {
        alert('请至少选择一个可校准的组');
        return;
    }

    // 直接切换回工作状态页并并行启动全量同步（不再弹确认框）
    switchPage('work');

    try {
        await ipcRequest('sync-multiple-groups', {
            groupIds,
            syncType: 'full',
            concurrency: globalConfig.batchConcurrency,
            options: {}
        });
    } catch (e) {
        console.error('批量校准启动失败', e);
    }
}

// ==================== 对话框管理 ====================

// 数字转中文（一、二、三...）
function numberToChinese(num) {
    const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    if (num <= 10) {
        return chinese[num - 1];
    }
    return num.toString();
}

// 获取默认组名（一组、二组、三组...）
function getDefaultGroupName() {
    const existingNumbers = groups
        .map(g => g.name)
        .filter(name => /^[一二三四五六七八九十]+组$/.test(name))
        .map(name => {
            const chineseNum = name.replace('组', '');
            const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
            return chinese.indexOf(chineseNum) + 1;
        });

    let nextNum = 1;
    while (existingNumbers.includes(nextNum)) {
        nextNum++;
    }

    return `${numberToChinese(nextNum)}组`;
}

// ========== 直接创建组（不弹窗） ==========

async function createGroupDirectly() {
    try {
        const name = getDefaultGroupName();

        await ipcRequest('add-group', {
            name: name,
            elemeConfig: {
                cookies: '',
                seller_id: '',
                store_id: ''
            },
            qnhConfig: {
                cookies: '',
                store_id: ''
            }
        });

        loadGroups(); // 刷新组列表
    } catch (error) {
        console.error('创建组失败:', error);
    }
}

// ========== 增加组对话框（已废弃，保留代码） ==========

function openAddGroupDialog() {
    const dialog = document.getElementById('addGroupDialog');
    const input = document.getElementById('newGroupName');
    input.value = getDefaultGroupName();
    dialog.showModal();

    // 自动选中输入框文本
    setTimeout(() => input.select(), 0);
}

function closeAddGroupDialog() {
    document.getElementById('addGroupDialog').close();
}

async function confirmAddGroup() {
    const name = document.getElementById('newGroupName').value.trim();
    if (!name) {
        alert('请输入组名称');
        return;
    }

    // 检查是否重名
    if (groups.some(g => g.name === name)) {
        alert('组名称已存在，请使用其他名称');
        return;
    }

    try {
        await ipcRequest('add-group', {
            name: name,
            elemeConfig: {
                cookies: '',
                seller_id: '',
                store_id: ''
            },
            qnhConfig: {
                cookies: '',
                store_id: ''
            }
        });

        // 不弹窗，直接关闭对话框并刷新
        closeAddGroupDialog();
        loadGroups(); // 刷新组列表
    } catch (error) {
        console.error('创建组失败:', error);
    }
}

// ========== 编辑组名对话框 ==========

function openEditGroupDialog(groupId) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    currentEditingGroupId = groupId;
    const dialog = document.getElementById('editGroupDialog');
    const input = document.getElementById('editGroupName');
    input.value = group.name;
    dialog.showModal();

    // 自动选中输入框文本
    setTimeout(() => input.select(), 0);
}

function closeEditGroupDialog() {
    document.getElementById('editGroupDialog').close();
    currentEditingGroupId = null;
}

async function confirmEditGroup() {
    const name = document.getElementById('editGroupName').value.trim();
    if (!name) {
        alert('请输入组名称');
        return;
    }

    // 检查是否重名（排除自己）
    if (groups.some(g => g.name === name && g.id !== currentEditingGroupId)) {
        alert('组名称已存在，请使用其他名称');
        return;
    }

    try {
        await ipcRequest('update-group', {
            groupId: currentEditingGroupId,
            updates: { name: name }
        });

        console.log('✅ 修改成功');
        // 保持运行状态不丢失：只更新groups数组中的名称，避免立即全量刷新导致按钮闪现
        const idx = groups.findIndex(g => g.id === currentEditingGroupId);
        if (idx !== -1) {
            groups[idx].name = name;
            renderGroups();
        } else {
            // 回退：若未找到，则全量刷新
            loadGroups();
        }
        closeEditGroupDialog();
    } catch (error) {
        console.error('修改组名失败:', error);
    }
}

// ========== Cookie配置对话框 ==========

function openCookieDialog(groupId, type) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    currentCookieConfig = { groupId, type };

    const dialog = document.getElementById('cookieDialog');
    const title = document.getElementById('cookieDialogTitle');
    const label = document.getElementById('cookieDialogLabel');
    const input = document.getElementById('cookieInput');

    // 重置按钮状态（避免上次验证状态残留）
    const saveBtn = dialog.querySelector('.btn-primary');
    saveBtn.disabled = false;
    saveBtn.textContent = '保存并验证';
    saveBtn.style.opacity = '1';

    // 设置对话框标题和标签
    if (type === 'eleme') {
        title.textContent = '🍪 配置饿了么Cookie';
        label.textContent = '饿了么Cookie字符串：';
        input.value = group.eleme_cookies || '';  // 直接显示字符串
    } else {
        title.textContent = '🍪 配置牵牛花Cookie';
        label.textContent = '牵牛花Cookie字符串：';
        input.value = group.qnh_cookies || '';  // 直接显示字符串
    }

    dialog.showModal();
}

function closeCookieDialog() {
    document.getElementById('cookieDialog').close();
    currentCookieConfig = null;
}

async function confirmCookie() {
    const cookieValue = document.getElementById('cookieInput').value.trim();
    if (!cookieValue) {
        alert('请输入Cookie字符串');
        return;
    }

    const { groupId, type } = currentCookieConfig;

    // 显示Loading状态
    const saveBtn = document.querySelector('#cookieDialog .btn-primary');
    const originalBtnText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = '验证中...';
    saveBtn.style.opacity = '0.6';

    try {
        // 验证Cookie并获取门店信息
        if (type === 'eleme') {
            // 验证饿了么Cookie
            const result = await ipcRequest('validate-eleme-cookies', {
                groupId,
                cookies: cookieValue
            });

            if (!result.success) {
                // 根据错误类型显示不同提示
                let errorMsg = `❌ Cookie验证失败：${result.error}`;
                if (result.error && (result.error.includes('401') || result.error.includes('403') || result.error.includes('token') || result.error.includes('登录'))) {
                    errorMsg += '\n\n请检查Cookie是否正确或已过期。';
                }
                alert(errorMsg);
                
                // 恢复按钮状态
                saveBtn.disabled = false;
                saveBtn.textContent = originalBtnText;
                saveBtn.style.opacity = '1';
                return;
            }

            console.log('✅ 饿了么Cookie验证成功:', result.storeName);
            alert(`✅ 验证成功！\n门店: ${result.storeName}`);
        } else {
            // 验证牵牛华Cookie
            const result = await ipcRequest('validate-qnh-cookies', {
                groupId,
                cookies: cookieValue
            });

            if (!result.success) {
                // 根据错误类型显示不同提示
                let errorMsg = `❌ Cookie验证失败：${result.error}`;
                if (result.error && (result.error.includes('401') || result.error.includes('403') || result.error.includes('token') || result.error.includes('登录'))) {
                    errorMsg += '\n\n请检查Cookie是否正确或已过期。';
                }
                alert(errorMsg);
                
                // 恢复按钮状态
                saveBtn.disabled = false;
                saveBtn.textContent = originalBtnText;
                saveBtn.style.opacity = '1';
                return;
            }

            // 存储门店列表到全局变量，供下拉框使用
            if (!window.qnhStores) {
                window.qnhStores = {};
            }
            window.qnhStores[groupId] = result.stores;

            console.log('✅ 牵牛华Cookie验证成功，获取到', result.stores.length, '个门店');
            alert(`✅ 验证成功！\n获取到 ${result.stores.length} 个门店，请选择门店`);
        }

        // 关闭对话框并刷新
        closeCookieDialog();
        loadGroups(); // 刷新组列表
    } catch (error) {
        console.error('保存Cookie失败:', error);
        alert(`❌ 操作失败：${error.message}`);
        
        // 恢复按钮状态
        saveBtn.disabled = false;
        saveBtn.textContent = originalBtnText;
        saveBtn.style.opacity = '1';
    }
}

// ==================== 门店管理 ====================

/**
 * 选择牵牛花门店
 */
async function selectQnhStore(groupId, storeId) {
    if (!storeId) return;

    try {
        const storeList = window.qnhStores[groupId];
        const store = storeList.find(s => s.id === storeId);

        if (!store) {
            alert('未找到门店信息');
            return;
        }

        // 保存到数据库
        await ipcRequest('update-group', {
            groupId,
            updates: {
                qnh_store_id: storeId,
                qnh_store_name: store.name
            }
        });

        console.log('✅ 牵牛花门店已选择:', store.name);
        loadGroups(); // 刷新组列表
    } catch (error) {
        console.error('选择门店失败:', error);
        alert(`❌ 选择门店失败：${error.message}`);
    }
}

/**
 * 刷新牵牛花门店列表
 */
async function refreshQnhStores(groupId) {
    try {
        const group = groups.find(g => g.id === groupId);
        if (!group || !group.qnh_cookies) {
            alert('请先配置牵牛花Cookie');
            return;
        }

        // 显示Loading状态
        const card = document.querySelector(`[data-group-id="${groupId}"]`);
        const refreshBtn = card.querySelector('.refresh-btn');
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.textContent = '⏳';
            refreshBtn.style.opacity = '0.6';
        }

        // 验证牵牛花Cookie并获取门店列表
        const result = await ipcRequest('validate-qnh-cookies', {
            groupId,
            cookies: group.qnh_cookies
        });

        // 恢复按钮状态
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄';
            refreshBtn.style.opacity = '1';
        }

        if (!result.success) {
            // 根据错误类型显示不同提示
            let errorMsg = `❌ 获取门店列表失败：${result.error}`;
            if (result.error && (result.error.includes('401') || result.error.includes('403') || result.error.includes('token') || result.error.includes('登录'))) {
                errorMsg += '\n\n请检查Cookie是否正确或已过期。';
            }
            alert(errorMsg);
            return;
        }

        // 存储门店列表到全局变量
        if (!window.qnhStores) {
            window.qnhStores = {};
        }
        window.qnhStores[groupId] = result.stores;

        console.log('✅ 牵牛花门店列表已刷新，获取到', result.stores.length, '个门店');
        loadGroups(); // 刷新组列表以显示下拉框
    } catch (error) {
        console.error('刷新门店列表失败:', error);
        alert(`❌ 刷新门店列表失败：${error.message}`);
        
        // 恢复按钮状态
        const card = document.querySelector(`[data-group-id="${groupId}"]`);
        const refreshBtn = card.querySelector('.refresh-btn');
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄';
            refreshBtn.style.opacity = '1';
        }
    }
}

// ==================== 进度条更新 ====================

function updateProgress(groupId, progress, message) {
    const card = document.querySelector(`[data-group-id="${groupId}"]`);
    if (!card) return;

    let progressBar = card.querySelector('.progress-bar');
    let progressFill = card.querySelector('.progress-fill');
    let progressText = card.querySelector('.progress-text');

    // 如果进度条不存在，创建它
    if (!progressBar) {
        const actionsDiv = card.querySelector('.group-actions');
        progressBar = document.createElement('div');
        progressBar.className = 'progress-bar';
        progressBar.style.display = 'none';
        progressBar.innerHTML = '<div class="progress-fill" style="width: 0%"></div>';
        
        progressText = document.createElement('div');
        progressText.className = 'progress-text';
        
        actionsDiv.parentNode.insertBefore(progressBar, actionsDiv);
        actionsDiv.parentNode.insertBefore(progressText, actionsDiv);
        
        progressFill = progressBar.querySelector('.progress-fill');
    }

    if (progress === 0) {
        // 开始同步，显示进度条
        progressBar.style.display = 'block';
        progressBar.classList.remove('indeterminate');
        progressFill.style.width = '0%';
        card.classList.add('syncing');
        // 切换按钮 - 隐藏开始按钮，显示暂停
        toggleGroupButtons(card, true);
        if (!runningStates[groupId]) runningStates[groupId] = {};
        runningStates[groupId].syncing = true;
    } else if (progress === 100) {
        // 同步完成，隐藏进度条
        progressFill.style.width = '100%';
        setTimeout(() => {
            progressBar.style.display = 'none';
            card.classList.remove('syncing');
            toggleGroupButtons(card, false);
        }, 1000);
        if (!runningStates[groupId]) runningStates[groupId] = {};
        runningStates[groupId].syncing = false;
        runningStates[groupId].progress = 100;
        runningStates[groupId].message = message || '';
    } else if (progress === -1) {
        // 同步失败，显示错误状态
        progressBar.style.display = 'none';
        card.classList.remove('syncing');
        card.classList.add('error');
        toggleGroupButtons(card, false);
        setTimeout(() => card.classList.remove('error'), 3000);
        if (!runningStates[groupId]) runningStates[groupId] = {};
        runningStates[groupId].syncing = false;
        runningStates[groupId].progress = -1;
        runningStates[groupId].message = message || '';
    } else {
        // 更新进度
        progressBar.classList.remove('indeterminate');
        progressFill.style.width = Math.min(100, Math.max(0, progress)) + '%';
        if (!runningStates[groupId]) runningStates[groupId] = {};
        runningStates[groupId].progress = progress;
        runningStates[groupId].message = message || '';
    }

    if (progressText && message) {
        progressText.textContent = message;
    }
}

// 在等待定时任务触发时显示无限进度条
function setIndeterminateProgress(groupId, show) {
    const card = document.querySelector(`[data-group-id="${groupId}"]`);
    if (!card) return;
    let progressBar = card.querySelector('.progress-bar');
    let progressFill = card.querySelector('.progress-fill');
    if (!progressBar) {
        const actionsDiv = card.querySelector('.group-actions');
        progressBar = document.createElement('div');
        progressBar.className = 'progress-bar';
        progressBar.style.display = 'none';
        progressBar.innerHTML = '<div class="progress-fill" style="width: 0%"></div>';
        actionsDiv.parentNode.insertBefore(progressBar, actionsDiv);
        progressFill = progressBar.querySelector('.progress-fill');
    }
    if (show) {
        progressBar.style.display = 'block';
        progressBar.classList.add('indeterminate');
        progressFill.style.width = '30%';
        card.classList.add('syncing');
        toggleGroupButtons(card, true);
    } else {
        progressBar.classList.remove('indeterminate');
        progressBar.style.display = 'none';
        card.classList.remove('syncing');
        toggleGroupButtons(card, false);
        // 停止定时后，恢复按钮可用状态
        updateGroupButtonsEnabled(groupId);
    }
}

function toggleGroupButtons(card, syncing) {
    const btnIncr = card.querySelector('.btn-incremental');
    const btnFull = card.querySelector('.btn-full');
    const btnCancel = card.querySelector('.btn-cancel');
    if (btnIncr && btnFull && btnCancel) {
        btnIncr.style.display = syncing ? 'none' : 'inline-block';
        btnFull.style.display = syncing ? 'none' : 'inline-block';
        btnCancel.style.display = syncing ? 'inline-block' : 'none';
    }
}

function setGroupSyncState(groupId, syncing, type = '') {
    const card = document.querySelector(`[data-group-id="${groupId}"]`);
    if (!card) return;
    const statusEl = card.querySelector('.group-status');
    if (syncing) {
        statusEl.textContent = type === 'full' ? '🔄 全量同步中' : '▶️ 增量同步中';
        toggleGroupButtons(card, true);
        if (!runningStates[groupId]) runningStates[groupId] = {};
        runningStates[groupId].syncing = true;
        runningStates[groupId].type = type || runningStates[groupId].type || '';
    } else {
        statusEl.textContent = '⏹️ 待机';
        // 同步结束（成功/失败/取消），按钮应可再次点击
        toggleGroupButtons(card, false);
        // 隐藏进度条
        const bar = card.querySelector('.progress-bar');
        if (bar) bar.style.display = 'none';
        if (!runningStates[groupId]) runningStates[groupId] = {};
        runningStates[groupId].syncing = false;
        // 清除同步类型，避免残留影响渲染
        delete runningStates[groupId].type;
        // 恢复可点击状态（考虑定时状态与配置完整性）
        updateGroupButtonsEnabled(groupId);
    }
}

async function cancelSync(groupId) {
    try {
        const confirmed = confirm('确定要暂停并终止当前同步任务吗？\n已进行的操作将不会回滚。');
        if (!confirmed) return;

        const res = await ipcRequest('cancel-sync', { groupId });
        if (res && res.success) {
            // 若是停止定时任务，立即更新UI为待机但保留“定时开启”提示
            if (res.action === 'stop_scheduled' || res.action === 'cancel_running_and_stop_scheduled') {
                setGroupSyncState(groupId, false);
                // 定时任务状态会通过 scheduled-task-changed 事件再次同步，这里快速反馈
                updateScheduledTaskStatus(groupId, 'stop');
                scheduledTasksActive[groupId] = false;
                updateGroupButtonsEnabled(groupId);
            } else if (res.action === 'cancel_running') {
                // 仅取消当前任务，定时状态保持
                setGroupSyncState(groupId, false);
                updateGroupButtonsEnabled(groupId);
            }
        } else {
            alert('终止任务失败: ' + ((res && res.error) || '未知错误'));
        }
    } catch (e) {
        console.error('取消同步失败', e);
    }
}

// ==================== 同步完成事件处理 ====================

function handleSyncComplete(groupId, result) {
    console.log('[同步完成]', groupId, result);
    
    // 重新加载组数据以显示更新后的同步信息
    loadGroups();
}

// ==================== 定时任务状态更新 ====================

function updateScheduledTaskStatus(groupId, action) {
    console.log(`[定时任务] 组${groupId}: ${action}`);
    const card = document.querySelector(`[data-group-id="${groupId}"]`);
    if (!card) return;
    const bar = card.querySelector('.progress-bar');
    const state = runningStates[groupId];
    const isRunning = state && state.syncing;
    const isActive = action === 'start';
    // 更新本地状态，便于按钮可用性判断
    scheduledTasksActive[groupId] = isActive;
    setIndeterminateProgress(groupId, isActive && !isRunning);
    // 同步按钮可用性
    updateGroupButtonsEnabled(groupId);
}

// 根据当前配置/运行/定时状态，启用或禁用按钮
function updateGroupButtonsEnabled(groupId) {
    const group = groups.find(g => g.id === groupId);
    const card = document.querySelector(`[data-group-id="${groupId}"]`);
    if (!group || !card) return;
    const btnIncr = card.querySelector('.btn-incremental');
    const btnFull = card.querySelector('.btn-full');
    const isRunning = !!(runningStates[groupId] && runningStates[groupId].syncing);
    const isScheduled = !!scheduledTasksActive[groupId];
    const ok = canSync(group);
    if (btnIncr) {
        btnIncr.disabled = !ok || isRunning || isScheduled;
        btnIncr.title = btnIncr.disabled ? '请先完成饿了么Cookie、牵牛花Cookie和门店配置，且未在定时中' : '';
    }
    if (btnFull) {
        btnFull.disabled = !ok || isRunning; // 全量与定时并不冲突，但运行中需要禁用
        btnFull.title = btnFull.disabled ? '请先完成饿了么Cookie、牵牛花Cookie和门店配置' : '';
    }
}

// ==================== Cookies失效通知 ====================

function handleCookiesInvalid(groupId, type) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    const platformName = type === 'eleme' ? '饿了么' : '牵牛花';
    
    // 桌面通知
    if (Notification.permission === 'granted') {
        new Notification('Cookies已过期', {
            body: `${group.name} 的${platformName}cookies已过期，请重新配置`
        });
    }
    
    // UI警告
    alert(`⚠️ ${group.name} 的${platformName}cookies已过期，请重新配置`);
    
    // 重新加载组列表（显示错误状态）
    loadGroups();
}

// ==================== 全局配置管理 ====================

async function loadConfig() {
    try {
        const config = await ipcRequest('get-config');
        globalConfig = config;
        console.log('全局配置已加载:', globalConfig);
    } catch (error) {
        console.error('加载配置失败:', error);
    }
}

/**
 * 加载配置到表单
 */
async function loadConfigToForm() {
    try {
        const config = await ipcRequest('get-config');
        globalConfig = config;
        
        // 填充表单
        document.getElementById('incrementalInterval').value = config.incrementalInterval || 10;
        document.getElementById('batchConcurrency').value = config.batchConcurrency || 3;
        document.getElementById('debugMode').checked = config.debugMode || false;
        document.getElementById('cookiesCheckInterval').value = config.cookiesCheckInterval || 24;
        
        // 获取并显示用户数据路径
        try {
            const dataPath = await ipcRequest('get-user-data-path');
            document.getElementById('dataFilePath').value = dataPath;
        } catch (pathError) {
            console.error('获取数据路径失败:', pathError);
            document.getElementById('dataFilePath').value = '获取失败';
        }
        
        console.log('配置已加载到表单:', config);
    } catch (error) {
        console.error('加载配置失败:', error);
        alert('加载配置失败: ' + error.message);
    }
}

/**
 * 保存配置
 */
async function saveConfig() {
    try {
        const config = {
            incrementalInterval: parseInt(document.getElementById('incrementalInterval').value) || 10,
            batchConcurrency: parseInt(document.getElementById('batchConcurrency').value) || 3,
            debugMode: document.getElementById('debugMode').checked,
            cookiesCheckInterval: parseInt(document.getElementById('cookiesCheckInterval').value) || 24
        };
        
        // 验证配置
        if (config.incrementalInterval < 5 || config.incrementalInterval > 60) {
            alert('增量同步间隔必须在5-60分钟之间');
            return;
        }
        
        if (config.batchConcurrency < 1 || config.batchConcurrency > 10) {
            alert('批量同步并发数必须在1-10之间');
            return;
        }
        
        if (config.cookiesCheckInterval < 1 || config.cookiesCheckInterval > 168) {
            alert('Cookies检测间隔必须在1-168小时之间');
            return;
        }
        
        const result = await ipcRequest('save-config', config);
        
        if (result.success) {
            globalConfig = config;
            alert('✅ 配置保存成功！');
            console.log('配置已保存:', config);
        } else {
            alert('❌ 保存配置失败: ' + result.error);
        }
    } catch (error) {
        console.error('保存配置失败:', error);
        alert('❌ 保存配置失败: ' + error.message);
    }
}

/**
 * 恢复默认配置
 */
function resetConfig() {
    if (confirm('确定要恢复默认配置吗？')) {
        document.getElementById('incrementalInterval').value = 10;
        document.getElementById('batchConcurrency').value = 3;
        document.getElementById('debugMode').checked = false;
        document.getElementById('cookiesCheckInterval').value = 24;
        
        console.log('配置已恢复为默认值');
        alert('✅ 已恢复默认配置，请点击「保存配置」按钮保存');
    }
}

// ==================== 暴露全局函数 ====================

window.loadGroups = loadGroups;
window.startIncrementalSync = startIncrementalSync;
window.startFullSync = startFullSync;
window.editGroup = editGroup;
window.deleteGroup = deleteGroup;
window.duplicateGroup = duplicateGroup;
window.clearGroupLogs = clearGroupLogs;
window.exportGroupLogs = exportGroupLogs;
window.switchPage = switchPage;

// 对话框函数
window.openAddGroupDialog = openAddGroupDialog;
window.closeAddGroupDialog = closeAddGroupDialog;
window.confirmAddGroup = confirmAddGroup;
window.openEditGroupDialog = openEditGroupDialog;
window.closeEditGroupDialog = closeEditGroupDialog;
window.confirmEditGroup = confirmEditGroup;
window.openCookieDialog = openCookieDialog;
window.closeCookieDialog = closeCookieDialog;
window.confirmCookie = confirmCookie;
window.selectQnhStore = selectQnhStore;
window.refreshQnhStores = refreshQnhStores;

// 全量同步对话框
window.closeFullSyncDialog = closeFullSyncDialog;
window.doFullSync = doFullSync;

// 全局配置
window.saveConfig = saveConfig;
window.resetConfig = resetConfig;

// 失败日志
window.viewFailedLogs = viewFailedLogs;
window.closeFailedLogsDialog = closeFailedLogsDialog;
window.refreshFailedLogs = refreshFailedLogs;
window.exportFailedLogs = exportFailedLogs;

// ==================== 双向同步功能 ====================

// 双向同步全局状态
let dualSyncGroups = [];
let dualSyncLogs = {}; // {groupId: [logs]}
let currentDualSyncGroupId = null; // 当前选中/编辑的组ID
let currentDualSyncCookieConfig = null; // 当前Cookie配置 {side: 'a'|'b', type: 'eleme'|'qnh'}
let dualSyncRunningStates = {}; // 运行状态
let dualSyncScheduledTasks = {}; // 定时任务状态
let dualSyncQnhStores = { a: [], b: [] }; // 牵牛花门店列表缓存

// 初始化双向同步IPC监听
function initDualSyncIPCListeners() {
    // 监听双向同步日志
    ipcRenderer.on('dual-sync-log', (event, logEntry) => {
        console.log('[双向同步日志]', logEntry);
        addDualSyncLog(logEntry.groupId, logEntry.level, logEntry.message);
    });

    // 监听双向同步进度
    ipcRenderer.on('dual-sync-progress', (event, { groupId, progress, message }) => {
        if (!dualSyncRunningStates[groupId]) {
            dualSyncRunningStates[groupId] = { syncing: true, type: 'incremental', progress: 0, message: '' };
        }
        dualSyncRunningStates[groupId].progress = progress;
        dualSyncRunningStates[groupId].message = message;
        updateDualSyncProgress(groupId, progress, message);
    });

    // 同步开始
    ipcRenderer.on('dual-sync-started', (event, { groupId, type }) => {
        setDualSyncGroupState(groupId, true, type);
    });

    // 同步完成
    ipcRenderer.on('dual-sync-complete', (event, { groupId }) => {
        setDualSyncGroupState(groupId, false);
        loadDualSyncGroups(); // 刷新列表
    });

    // 定时任务状态变化
    ipcRenderer.on('dual-sync-scheduled-changed', (event, { groupId, action }) => {
        dualSyncScheduledTasks[groupId] = action === 'start';
        renderDualSyncGroups();
    });
}

// 初始化时调用
initDualSyncIPCListeners();

// 加载双向同步组
async function loadDualSyncGroups() {
    try {
        dualSyncGroups = await ipcRenderer.invoke('dual-sync-get-groups');
        
        // 加载定时任务状态
        const tasks = await ipcRenderer.invoke('dual-sync-get-scheduled-tasks');
        dualSyncScheduledTasks = {};
        for (const task of tasks) {
            dualSyncScheduledTasks[task.groupId] = true;
        }
        
        renderDualSyncGroups();
        
        // 渲染所有组的日志窗口
        renderDualSyncLogs();
    } catch (error) {
        console.error('加载双向同步组失败:', error);
    }
}

// 渲染双向同步组列表
function renderDualSyncGroups() {
    const container = document.getElementById('dualSyncGroupsContainer');
    if (!container) return;

    if (dualSyncGroups.length === 0) {
        container.innerHTML = `
            <div class="dual-sync-empty">
                <div class="empty-icon">🔄</div>
                <div class="empty-text">暂无双向同步组</div>
                <button class="btn btn-primary" onclick="openDualSyncConfigDialog()">➕ 创建第一个组</button>
            </div>
        `;
        return;
    }

    container.innerHTML = dualSyncGroups.map(group => renderDualSyncGroupCard(group)).join('');
}

// 渲染单个双向同步组卡片
function renderDualSyncGroupCard(group) {
    const state = dualSyncRunningStates[group.id] || {};
    const isRunning = state.syncing;
    const isScheduled = dualSyncScheduledTasks[group.id];
    
    // 状态标签
    let statusTag = '<span class="sync-status-tag idle">空闲</span>';
    if (isRunning) {
        statusTag = `<span class="sync-status-tag running">同步中${state.progress ? ` ${state.progress}%` : ''}</span>`;
    } else if (isScheduled) {
        statusTag = '<span class="sync-status-tag scheduled">定时运行中</span>';
    }

    // A方信息
    const aElemeInfo = group.a_eleme_store_name || '未配置';
    const aQnhInfo = group.a_qnh_store_name || '未配置';
    
    // B方信息
    const bElemeInfo = group.b_eleme_store_name || '未配置';
    const bQnhInfo = group.b_qnh_store_name || '未配置';

    // 配置是否完整
    const configComplete = group.a_eleme_cookies && group.a_qnh_store_id && 
                           group.b_eleme_cookies && group.b_qnh_store_id;

    // 上次同步信息
    let lastSyncInfo = '';
    if (group.last_full_sync_time) {
        const time = new Date(group.last_full_sync_time).toLocaleString('zh-CN');
        lastSyncInfo += `<span>全量: ${time}</span>`;
    }
    if (group.last_incr_sync_time) {
        const time = new Date(group.last_incr_sync_time).toLocaleString('zh-CN');
        const noChange = group.last_incr_sync_count === 0 ? '（无库存变化）' : '';
        lastSyncInfo += `<span>增量: ${time}${noChange}</span>`;
    }

    return `
        <div class="dual-sync-group-card ${currentDualSyncGroupId === group.id ? 'selected' : ''}" 
             onclick="selectDualSyncGroup(${group.id})">
            <div class="dual-sync-group-header">
                <div class="dual-sync-group-name">${group.name}</div>
                <div class="dual-sync-group-actions">
                    ${statusTag}
                    <button class="btn btn-small" onclick="event.stopPropagation(); openDualSyncConfigDialog(${group.id})" title="配置">⚙️</button>
                    <button class="btn btn-small" onclick="event.stopPropagation(); duplicateDualSyncGroup(${group.id})" title="复制">📄</button>
                    <button class="btn btn-small" onclick="event.stopPropagation(); deleteDualSyncGroup(${group.id})" title="删除">🗑️</button>
                </div>
            </div>
            
            <div class="dual-sync-group-status">
                <div class="dual-sync-side">
                    <div class="dual-sync-side-label side-a">🅰️ A方</div>
                    <div class="dual-sync-side-info">
                        <div>饿了么: <span class="store-name">${aElemeInfo}</span></div>
                        <div>牵牛花: <span class="store-name">${aQnhInfo}</span></div>
                    </div>
                </div>
                <div class="dual-sync-side">
                    <div class="dual-sync-side-label side-b">🅱️ B方</div>
                    <div class="dual-sync-side-info">
                        <div>饿了么: <span class="store-name">${bElemeInfo}</span></div>
                        <div>牵牛花: <span class="store-name">${bQnhInfo}</span></div>
                    </div>
                </div>
            </div>
            
            ${lastSyncInfo ? `<div class="last-sync-info">${lastSyncInfo}</div>` : ''}
            
            ${isRunning ? `
                <div class="sync-progress-bar">
                    <div class="progress-inner" style="width: ${state.progress || 0}%"></div>
                </div>
            ` : ''}
            
            <div class="dual-sync-group-controls">
                ${configComplete ? `
                    ${isRunning ? `
                        <button class="btn btn-danger" onclick="event.stopPropagation(); cancelDualSync(${group.id})">⏹️ 停止</button>
                    ` : isScheduled ? `
                        <button class="btn btn-danger-light" onclick="event.stopPropagation(); stopDualSyncScheduled(${group.id})">⏸️ 停止定时</button>
                    ` : `
                        <button class="btn btn-primary" onclick="event.stopPropagation(); startDualSyncFull(${group.id})">🔄 全量同步</button>
                        <button class="btn btn-success" onclick="event.stopPropagation(); startDualSyncScheduled(${group.id}, ${group.sync_interval || 10})">▶️ 启动定时</button>
                    `}
                ` : `
                    <button class="btn btn-warning" onclick="event.stopPropagation(); openDualSyncConfigDialog(${group.id})">⚠️ 完成配置</button>
                `}
            </div>
        </div>
    `;
}

// 选中双向同步组
function selectDualSyncGroup(groupId) {
    currentDualSyncGroupId = groupId;
    renderDualSyncGroups();
    // 重新渲染日志以高亮选中的组
    renderDualSyncLogs();
}

// 设置双向同步组运行状态
function setDualSyncGroupState(groupId, syncing, type = null) {
    if (syncing) {
        dualSyncRunningStates[groupId] = { syncing: true, type: type, progress: 0, message: '' };
    } else {
        delete dualSyncRunningStates[groupId];
    }
    renderDualSyncGroups();
}

// 更新双向同步进度
const DUAL_SYNC_PROGRESS_RENDER_THROTTLE_MS = 200;
let dualSyncProgressRenderTimer = null;
let dualSyncProgressLastRenderAt = 0;

function scheduleDualSyncGroupsRender(force = false) {
    const now = Date.now();

    if (force) {
        if (dualSyncProgressRenderTimer) {
            clearTimeout(dualSyncProgressRenderTimer);
            dualSyncProgressRenderTimer = null;
        }
        dualSyncProgressLastRenderAt = now;
        renderDualSyncGroups();
        return;
    }

    const elapsed = now - dualSyncProgressLastRenderAt;
    if (elapsed >= DUAL_SYNC_PROGRESS_RENDER_THROTTLE_MS && !dualSyncProgressRenderTimer) {
        dualSyncProgressLastRenderAt = now;
        renderDualSyncGroups();
        return;
    }

    if (dualSyncProgressRenderTimer) return;

    const waitMs = Math.max(0, DUAL_SYNC_PROGRESS_RENDER_THROTTLE_MS - elapsed);
    dualSyncProgressRenderTimer = setTimeout(() => {
        dualSyncProgressRenderTimer = null;
        dualSyncProgressLastRenderAt = Date.now();
        renderDualSyncGroups();
    }, waitMs);
}

function updateDualSyncProgress(groupId, progress, message) {
    const force = progress === 0 || progress === 100 || progress === -1;
    scheduleDualSyncGroupsRender(force);
    updateDualSyncLogProgressUI(groupId, progress, message);
}

function updateDualSyncLogProgressUI(groupId, progress, message) {
    const progressEl = document.getElementById(`dualSyncLogProgress_${groupId}`);
    if (!progressEl) return;

    const fillEl = progressEl.querySelector('.dual-sync-log-progress-inner');
    const textEl = progressEl.querySelector('.dual-sync-log-progress-text');
    if (!fillEl || !textEl) return;

    // 显示/隐藏逻辑：同步进行中显示；完成/失败也短暂显示（不刷屏）
    const shouldShow = progress !== null && progress !== undefined && progress !== -1;
    progressEl.style.display = shouldShow ? '' : 'none';

    if (progress === -1) {
        progressEl.style.display = 'none';
        return;
    }

    const safeProgress = Math.min(100, Math.max(0, Number(progress) || 0));
    fillEl.style.width = `${safeProgress}%`;

    const msg = message || '';
    textEl.textContent = msg ? `${safeProgress}% · ${msg}` : `${safeProgress}%`;
}

// 添加双向同步日志
function addDualSyncLog(groupId, level, message) {
    if (!dualSyncLogs[groupId]) {
        dualSyncLogs[groupId] = [];
    }
    
    const timestamp = new Date().toLocaleTimeString('zh-CN');
    dualSyncLogs[groupId].push({ timestamp, level, message });
    
    // 限制日志数量
    if (dualSyncLogs[groupId].length > 200) {
        dualSyncLogs[groupId].shift();
    }
    
    // 更新日志显示（所有组的日志都需要显示）
    renderDualSyncLogs(groupId);
}

// 加载双向同步组日志
async function loadDualSyncGroupLogs(groupId) {
    try {
        const logs = await ipcRenderer.invoke('dual-sync-get-logs', { groupId, limit: 100 });
        dualSyncLogs[groupId] = logs.map(log => ({
            timestamp: new Date(log.timestamp).toLocaleTimeString('zh-CN'),
            level: log.level,
            message: log.message
        }));
        renderDualSyncLogs(groupId);
    } catch (error) {
        console.error('加载双向同步日志失败:', error);
    }
}

// 渲染双向同步日志（渲染所有组的日志卡片，顺序与左侧组列表一致）
function renderDualSyncLogs(groupId) {
    const container = document.getElementById('dualSyncLogsContainer');
    if (!container) return;

    // 无组时展示占位
    if (!dualSyncGroups || dualSyncGroups.length === 0) {
        container.innerHTML = `
            <div class="no-logs">
                <p>暂无日志</p>
                <p style="font-size: 12px; color: #8c8c8c;">开始同步后将显示实时日志</p>
            </div>
        `;
        return;
    }

    // 日志面板顺序：与左侧组列表一致
    const orderedGroups = dualSyncGroups.slice();

    container.innerHTML = orderedGroups.map(group => {
        const gId = group.id;
        const groupName = group.name || `组 ${gId}`;
        const logList = dualSyncLogs[gId] || [];
        const isSelected = currentDualSyncGroupId === gId;
        const state = dualSyncRunningStates[gId] || {};
        const initialProgress = state.progress ?? 0;
        const initialMessage = state.message || '';
        const showProgress = state.syncing;

        const contentHtml = logList.length > 0
            ? logList.map(log => {
                // 检测 [!red] 标记，用红色显示
                let message = log.message;
                let messageStyle = '';
                if (message.startsWith('[!red]')) {
                    message = message.replace('[!red]', '');
                    messageStyle = 'color: #e57373;';
                }
                return `
                    <div class="log-line">
                        <span class="log-time">${log.timestamp}</span> |
                        <span class="log-level-${log.level}">${log.level.toUpperCase()}</span> |
                        <span style="${messageStyle}">${message}</span>
                    </div>
                `;
            }).join('')
            : `<div class="log-line" style="color: #8c8c8c;">暂无日志，开始同步后将在此显示</div>`;

        return `
            <div class="log-card ${isSelected ? 'selected' : ''}" data-group-id="${gId}">
                <div class="log-header">
                    <div class="log-title">📋 ${groupName}</div>
                    <div class="log-actions">
                        <button class="log-btn" onclick="clearDualSyncLogsForGroup(${gId})">清空</button>
                    </div>
                </div>
                <div class="log-content" id="dualSyncLogContent_${gId}">
                    <div class="dual-sync-log-progress" id="dualSyncLogProgress_${gId}" style="${showProgress ? '' : 'display:none;'}">
                        <div class="dual-sync-log-progress-bar">
                            <div class="dual-sync-log-progress-inner" style="width: ${Math.min(100, Math.max(0, Number(initialProgress) || 0))}%"></div>
                        </div>
                        <div class="dual-sync-log-progress-text">${initialMessage ? `${Math.min(100, Math.max(0, Number(initialProgress) || 0))}% · ${initialMessage}` : `${Math.min(100, Math.max(0, Number(initialProgress) || 0))}%`}</div>
                    </div>
                    ${contentHtml}
                </div>
            </div>
        `;
    }).join('');

    // 自动滚动到每个日志卡片的底部
    const logCards = container.querySelectorAll('.log-content');
    logCards.forEach(card => {
        card.scrollTop = card.scrollHeight;
    });
}

// 打开双向同步配置对话框
async function openDualSyncConfigDialog(groupId = null) {
    currentDualSyncGroupId = groupId;
    
    const dialog = document.getElementById('dualSyncConfigDialog');
    const title = document.getElementById('dualSyncConfigTitle');
    
    if (groupId) {
        title.textContent = '🔄 编辑双向同步组';
        
        // 加载组配置
        const group = await ipcRenderer.invoke('dual-sync-get-group', groupId);
        if (group) {
            document.getElementById('dualSyncGroupName').value = group.name || '';
            document.getElementById('dualSyncInterval').value = group.sync_interval || 10;
            
            // 更新A方状态显示
            updateDualSyncSideStatus('a', 'eleme', group.a_eleme_store_name, group.a_eleme_cookies_valid);
            updateDualSyncSideStatus('a', 'qnh', group.a_qnh_store_name, group.a_qnh_cookies_valid);
            
            // 更新B方状态显示
            updateDualSyncSideStatus('b', 'eleme', group.b_eleme_store_name, group.b_eleme_cookies_valid);
            updateDualSyncSideStatus('b', 'qnh', group.b_qnh_store_name, group.b_qnh_cookies_valid);
            
            // 如果A牵牛花已配置Cookie，显示门店选择（如果已有门店则显示）
            if (group.a_qnh_cookies_valid || group.a_qnh_store_id) {
                const aRow = document.getElementById('dualSyncAQnhStoreRow');
                const aSelect = document.getElementById('dualSyncAQnhStoreSelect');
                aRow.style.display = 'flex';
                
                // 如果有已选门店，先显示（格式：门店名称 (ID: xxx)）
                if (group.a_qnh_store_id) {
                    const displayName = group.a_qnh_store_name ? `${group.a_qnh_store_name} (ID: ${group.a_qnh_store_id})` : group.a_qnh_store_id;
                    aSelect.innerHTML = `<option value="">选择门店...</option><option value="${group.a_qnh_store_id}" data-name="${group.a_qnh_store_name || ''}" selected>${displayName}</option>`;
                }
            } else {
                document.getElementById('dualSyncAQnhStoreRow').style.display = 'none';
            }
            
            // 如果B牵牛花已配置Cookie，显示门店选择
            if (group.b_qnh_cookies_valid || group.b_qnh_store_id) {
                const bRow = document.getElementById('dualSyncBQnhStoreRow');
                const bSelect = document.getElementById('dualSyncBQnhStoreSelect');
                bRow.style.display = 'flex';
                
                if (group.b_qnh_store_id) {
                    const displayName = group.b_qnh_store_name ? `${group.b_qnh_store_name} (ID: ${group.b_qnh_store_id})` : group.b_qnh_store_id;
                    bSelect.innerHTML = `<option value="">选择门店...</option><option value="${group.b_qnh_store_id}" data-name="${group.b_qnh_store_name || ''}" selected>${displayName}</option>`;
                }
            } else {
                document.getElementById('dualSyncBQnhStoreRow').style.display = 'none';
            }
        }
    } else {
        title.textContent = '🔄 新增双向同步组';
        document.getElementById('dualSyncGroupName').value = '';
        document.getElementById('dualSyncInterval').value = 10;
        
        // 重置状态显示
        updateDualSyncSideStatus('a', 'eleme', null, false);
        updateDualSyncSideStatus('a', 'qnh', null, false);
        updateDualSyncSideStatus('b', 'eleme', null, false);
        updateDualSyncSideStatus('b', 'qnh', null, false);
        
        // 隐藏门店选择
        document.getElementById('dualSyncAQnhStoreRow').style.display = 'none';
        document.getElementById('dualSyncBQnhStoreRow').style.display = 'none';
        
        // 清空下拉框
        document.getElementById('dualSyncAQnhStoreSelect').innerHTML = '<option value="">选择门店...</option>';
        document.getElementById('dualSyncBQnhStoreSelect').innerHTML = '<option value="">选择门店...</option>';
    }
    
    // 修复焦点问题：先重置焦点状态，避免 confirm() 对话框导致的焦点残留
    document.body.focus();
    
    dialog.showModal();
    
    // 修复焦点问题：多次尝试设置焦点到组名称输入框
    const nameInput = document.getElementById('dualSyncGroupName');
    const setFocus = () => {
        if (nameInput && document.activeElement !== nameInput) {
            nameInput.focus();
            nameInput.select(); // 如果有内容则全选，方便修改
        }
    };
    
    // 立即尝试一次
    setFocus();
    // 延迟再尝试，确保对话框完全渲染
    setTimeout(setFocus, 50);
    setTimeout(setFocus, 150);
}

// 更新双向同步侧边状态显示
function updateDualSyncSideStatus(side, type, storeName, isValid) {
    const statusId = `dualSync${side.toUpperCase()}${type === 'eleme' ? 'Eleme' : 'Qnh'}Status`;
    const statusEl = document.getElementById(statusId);
    
    if (statusEl) {
        if (storeName) {
            statusEl.textContent = storeName;
            statusEl.className = 'config-value valid';
        } else if (isValid) {
            statusEl.textContent = type === 'qnh' ? '已验证，请选择门店' : '已验证';
            statusEl.className = 'config-value valid';
        } else {
            statusEl.textContent = '未配置';
            statusEl.className = 'config-value invalid';
        }
    }
}

// 关闭双向同步配置对话框
function closeDualSyncConfigDialog() {
    const dialog = document.getElementById('dualSyncConfigDialog');
    dialog.close();
}

// 保存双向同步配置
async function saveDualSyncConfig() {
    const name = document.getElementById('dualSyncGroupName').value.trim();
    const syncInterval = parseInt(document.getElementById('dualSyncInterval').value) || 10;
    
    if (!name) {
        alert('请输入组名称');
        return;
    }
    
    try {
        if (currentDualSyncGroupId) {
            // 更新
            await ipcRenderer.invoke('dual-sync-update-group', {
                groupId: currentDualSyncGroupId,
                updates: { name, sync_interval: syncInterval }
            });
        } else {
            // 新增
            const result = await ipcRenderer.invoke('dual-sync-add-group', {
                name,
                config: { sync_interval: syncInterval }
            });
            if (result.success) {
                currentDualSyncGroupId = result.groupId;
            } else {
                throw new Error(result.error);
            }
        }
        
        closeDualSyncConfigDialog();
        loadDualSyncGroups();
    } catch (error) {
        alert('保存失败: ' + error.message);
    }
}

// 配置双向同步Cookie
async function configureDualSyncCookie(side, type) {
    if (!currentDualSyncGroupId) {
        // 先保存组
        saveDualSyncConfigAndContinue(side, type);
        return;
    }
    
    currentDualSyncCookieConfig = { side, type };
    
    const dialog = document.getElementById('dualSyncCookieDialog');
    const title = document.getElementById('dualSyncCookieDialogTitle');
    const label = document.getElementById('dualSyncCookieDialogLabel');
    
    const sideLabel = side === 'a' ? 'A方' : 'B方';
    const typeLabel = type === 'eleme' ? '饿了么' : '牵牛花';
    
    title.textContent = `🍪 配置${sideLabel}${typeLabel}Cookie`;
    label.textContent = `${typeLabel}Cookie字符串：`;
    
    // 回显已保存的 Cookie
    let existingCookies = '';
    try {
        const group = await ipcRenderer.invoke('dual-sync-get-group', currentDualSyncGroupId);
        if (group) {
            // 根据 side 和 type 获取对应的 Cookie
            const cookieKey = `${side}_${type}_cookies`;
            existingCookies = group[cookieKey] || '';
        }
    } catch (error) {
        console.error('获取已保存Cookie失败:', error);
    }
    document.getElementById('dualSyncCookieInput').value = existingCookies;
    
    dialog.showModal();
}

// 保存配置后继续配置Cookie
async function saveDualSyncConfigAndContinue(side, type) {
    const name = document.getElementById('dualSyncGroupName').value.trim();
    const syncInterval = parseInt(document.getElementById('dualSyncInterval').value) || 10;
    
    if (!name) {
        alert('请先输入组名称');
        return;
    }
    
    try {
        const result = await ipcRenderer.invoke('dual-sync-add-group', {
            name,
            config: { sync_interval: syncInterval }
        });
        if (result.success) {
            currentDualSyncGroupId = result.groupId;
            configureDualSyncCookie(side, type);
        } else {
            throw new Error(result.error);
        }
    } catch (error) {
        alert('保存失败: ' + error.message);
    }
}

// 关闭双向同步Cookie对话框
function closeDualSyncCookieDialog() {
    const dialog = document.getElementById('dualSyncCookieDialog');
    dialog.close();
}

// 确认双向同步Cookie
async function confirmDualSyncCookie() {
    const cookies = document.getElementById('dualSyncCookieInput').value.trim();
    if (!cookies) {
        alert('请输入Cookie');
        return;
    }
    
    const { side, type } = currentDualSyncCookieConfig;
    const btn = document.querySelector('#dualSyncCookieDialog .btn-primary');
    btn.disabled = true;
    btn.textContent = '验证中...';
    
    try {
        let result;
        if (type === 'eleme') {
            result = await ipcRenderer.invoke(`dual-sync-validate-${side}-eleme`, {
                groupId: currentDualSyncGroupId,
                cookies
            });
            
            if (result.success) {
                updateDualSyncSideStatus(side, 'eleme', result.storeName, true);
                alert(`✅ ${side === 'a' ? 'A方' : 'B方'}饿了么验证成功\n门店: ${result.storeName}`);
            }
        } else {
            result = await ipcRenderer.invoke(`dual-sync-validate-${side}-qnh`, {
                groupId: currentDualSyncGroupId,
                cookies
            });
            
            if (result.success) {
                dualSyncQnhStores[side] = result.stores;
                updateDualSyncSideStatus(side, 'qnh', null, true);
                
                // 显示门店选择
                const selectId = `dualSync${side.toUpperCase()}QnhStoreSelect`;
                const rowId = `dualSync${side.toUpperCase()}QnhStoreRow`;
                const select = document.getElementById(selectId);
                const row = document.getElementById(rowId);
                
                select.innerHTML = '<option value="">选择门店...</option>' + 
                    result.stores.map(s => `<option value="${s.id}" data-name="${s.name}">${s.name} (ID: ${s.id})</option>`).join('');
                row.style.display = 'flex';
                
                alert(`✅ ${side === 'a' ? 'A方' : 'B方'}牵牛花验证成功\n请选择门店`);
            }
        }
        
        if (!result.success) {
            alert('❌ 验证失败: ' + result.error);
        } else {
            closeDualSyncCookieDialog();
        }
    } catch (error) {
        alert('验证失败: ' + error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '保存并验证';
    }
}

// 选择双向同步门店
async function selectDualSyncStore(side) {
    const selectId = `dualSync${side.toUpperCase()}QnhStoreSelect`;
    const select = document.getElementById(selectId);
    const storeId = select.value;
    // 从 data-name 属性获取纯门店名称（不含ID后缀）
    const selectedOption = select.options[select.selectedIndex];
    const storeName = selectedOption.dataset.name || selectedOption.text;
    
    if (!storeId) return;
    
    try {
        await ipcRenderer.invoke(`dual-sync-select-${side}-qnh-store`, {
            groupId: currentDualSyncGroupId,
            storeId,
            storeName
        });
        
        updateDualSyncSideStatus(side, 'qnh', storeName, true);
    } catch (error) {
        alert('选择门店失败: ' + error.message);
    }
}

// 刷新双向同步牵牛花门店列表
async function refreshDualSyncQnhStores(side) {
    if (!currentDualSyncGroupId) {
        alert('请先保存组配置');
        return;
    }
    
    // 获取当前组的Cookie
    const group = await ipcRenderer.invoke('dual-sync-get-group', currentDualSyncGroupId);
    const cookiesKey = `${side}_qnh_cookies`;
    const cookies = group[cookiesKey];
    
    if (!cookies) {
        alert('请先配置牵牛花Cookie');
        return;
    }
    
    try {
        // 重新验证Cookie获取门店列表
        const result = await ipcRenderer.invoke(`dual-sync-validate-${side}-qnh`, {
            groupId: currentDualSyncGroupId,
            cookies
        });
        
        if (result.success) {
            dualSyncQnhStores[side] = result.stores;
            
            // 更新下拉框
            const selectId = `dualSync${side.toUpperCase()}QnhStoreSelect`;
            const rowId = `dualSync${side.toUpperCase()}QnhStoreRow`;
            const select = document.getElementById(selectId);
            const row = document.getElementById(rowId);
            
            // 保留当前选中的门店
            const currentStoreId = group[`${side}_qnh_store_id`];
            
            select.innerHTML = '<option value="">选择门店...</option>' + 
                result.stores.map(s => `<option value="${s.id}" data-name="${s.name}" ${s.id === currentStoreId ? 'selected' : ''}>${s.name} (ID: ${s.id})</option>`).join('');
            row.style.display = 'flex';
            
            alert(`✅ 刷新成功，获取到 ${result.stores.length} 个门店`);
        } else {
            alert('❌ 刷新失败: ' + result.error);
        }
    } catch (error) {
        alert('刷新失败: ' + error.message);
    }
}

// 删除双向同步组
async function deleteDualSyncGroup(groupId) {
    if (!confirm('确定要删除此双向同步组吗？')) return;
    
    try {
        await ipcRenderer.invoke('dual-sync-delete-group', groupId);
        loadDualSyncGroups();
    } catch (error) {
        alert('删除失败: ' + error.message);
    }
}

// 复制双向同步组
async function duplicateDualSyncGroup(groupId) {
    try {
        const group = dualSyncGroups.find(g => g.id === groupId);
        if (!group) return;

        // 生成新名称
        let newName = `${group.name}（副本）`;
        let suffix = 2;
        while (dualSyncGroups.some(g => g.name === newName)) {
            newName = `${group.name}（副本${suffix}）`;
            suffix += 1;
        }

        const result = await ipcRenderer.invoke('dual-sync-duplicate-group', { groupId, newName });
        if (result.success) {
            await loadDualSyncGroups();
            alert('✅ 已复制同步组');
        } else {
            alert('❌ 复制失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        alert('❌ 复制失败: ' + error.message);
    }
}

// 启动双向全量同步
async function startDualSyncFull(groupId) {
    if (!confirm('全量同步会导出所有商品并更新两边的库存，可能需要5-15分钟，确定开始吗？')) return;
    
    // 自动选中该组，显示日志
    selectDualSyncGroup(groupId);
    
    try {
        setDualSyncGroupState(groupId, true, 'full');
        addDualSyncLog(groupId, 'info', '开始全量同步...');
        
        const result = await ipcRenderer.invoke('dual-sync-full', { groupId });
        
        if (result.status === 'success') {
            addDualSyncLog(groupId, 'info', `全量同步完成(A→B): 更新${result.updatesB}个商品`);
        } else if (result.status === 'cancelled') {
            addDualSyncLog(groupId, 'warn', '全量同步已取消');
        } else {
            addDualSyncLog(groupId, 'error', '全量同步失败: ' + result.error);
        }
    } catch (error) {
        addDualSyncLog(groupId, 'error', '全量同步异常: ' + error.message);
    } finally {
        setDualSyncGroupState(groupId, false);
        loadDualSyncGroups();
    }
}

// 启动双向定时同步
async function startDualSyncScheduled(groupId, intervalMinutes) {
    // 自动选中该组，显示日志
    selectDualSyncGroup(groupId);
    
    try {
        await ipcRenderer.invoke('dual-sync-start-scheduled', {
            groupId,
            intervalMinutes,
            runImmediately: true
        });
        
        dualSyncScheduledTasks[groupId] = true;
        renderDualSyncGroups();
        addDualSyncLog(groupId, 'info', `定时同步已启动，间隔: ${intervalMinutes}分钟`);
    } catch (error) {
        alert('启动定时同步失败: ' + error.message);
    }
}

// 停止双向定时同步
async function stopDualSyncScheduled(groupId) {
    if (!confirm('确定要停止定时同步吗？')) return;
    
    try {
        await ipcRenderer.invoke('dual-sync-stop-scheduled', { groupId });
        
        dualSyncScheduledTasks[groupId] = false;
        renderDualSyncGroups();
        addDualSyncLog(groupId, 'info', '定时同步已停止');
    } catch (error) {
        alert('停止定时同步失败: ' + error.message);
    }
}

// 取消双向同步
async function cancelDualSync(groupId) {
    try {
        await ipcRenderer.invoke('dual-sync-cancel', { groupId });
        addDualSyncLog(groupId, 'warn', '正在取消同步...');
    } catch (error) {
        alert('取消同步失败: ' + error.message);
    }
}

// 刷新双向同步日志（刷新所有组）
async function refreshDualSyncLogs() {
    for (const group of dualSyncGroups) {
        await loadDualSyncGroupLogs(group.id);
    }
}

// 清空双向同步日志（清空所有组）
async function clearDualSyncLogs() {
    for (const group of dualSyncGroups) {
        try {
            await ipcRenderer.invoke('dual-sync-clear-logs', { groupId: group.id });
            dualSyncLogs[group.id] = [];
        } catch (error) {
            console.error(`清空组 ${group.id} 日志失败:`, error);
        }
    }
    renderDualSyncLogs();
}

// 清空指定组的双向同步日志
async function clearDualSyncLogsForGroup(groupId) {
    try {
        await ipcRenderer.invoke('dual-sync-clear-logs', { groupId });
        dualSyncLogs[groupId] = [];
        renderDualSyncLogs();
    } catch (error) {
        console.error(`清空组 ${groupId} 日志失败:`, error);
    }
}

// 页面切换时加载双向同步数据
const originalSwitchPage = window.switchPage;
window.switchPage = function(pageName) {
    if (typeof originalSwitchPage === 'function') {
        originalSwitchPage(pageName);
    }
    
    if (pageName === 'dual-sync') {
        loadDualSyncGroups();
    }
};

// 暴露双向同步函数
window.loadDualSyncGroups = loadDualSyncGroups;
window.openDualSyncConfigDialog = openDualSyncConfigDialog;
window.closeDualSyncConfigDialog = closeDualSyncConfigDialog;
window.saveDualSyncConfig = saveDualSyncConfig;
window.configureDualSyncCookie = configureDualSyncCookie;
window.closeDualSyncCookieDialog = closeDualSyncCookieDialog;
window.confirmDualSyncCookie = confirmDualSyncCookie;
window.selectDualSyncStore = selectDualSyncStore;
window.refreshDualSyncQnhStores = refreshDualSyncQnhStores;
window.selectDualSyncGroup = selectDualSyncGroup;
window.deleteDualSyncGroup = deleteDualSyncGroup;
window.duplicateDualSyncGroup = duplicateDualSyncGroup;
window.startDualSyncFull = startDualSyncFull;
window.startDualSyncScheduled = startDualSyncScheduled;
window.stopDualSyncScheduled = stopDualSyncScheduled;
window.cancelDualSync = cancelDualSync;
window.refreshDualSyncLogs = refreshDualSyncLogs;
window.clearDualSyncLogs = clearDualSyncLogs;
window.clearDualSyncLogsForGroup = clearDualSyncLogsForGroup;
