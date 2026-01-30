/**
 * 诊断服务前端逻辑
 */

// 全局状态
let currentGroups = [];
let currentSnapshots = [];

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    await checkConfig();
});

// 检查配置状态
async function checkConfig() {
    try {
        const response = await fetch('/api/config');
        const data = await response.json();
        
        if (data.dbLoaded && data.dataDir) {
            document.getElementById('dataDir').textContent = `数据目录: ${data.dataDir}`;
            document.getElementById('configPrompt').style.display = 'none';
            document.getElementById('mainContent').style.display = 'flex';
            await initApp();
        } else {
            document.getElementById('configPrompt').style.display = 'flex';
            document.getElementById('mainContent').style.display = 'none';
        }
    } catch (error) {
        console.error('检查配置失败:', error);
    }
}

// 设置数据目录
async function setDataDir() {
    const input = document.getElementById('dataDirInput');
    const dirPath = input.value.trim();
    
    if (!dirPath) {
        alert('请输入数据目录路径');
        return;
    }
    
    try {
        const response = await fetch('/api/config/data-dir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dirPath })
        });
        
        const data = await response.json();
        
        if (data.success) {
            await checkConfig();
        } else {
            alert('加载失败: ' + data.error);
        }
    } catch (error) {
        alert('请求失败: ' + error.message);
    }
}

// 初始化应用
async function initApp() {
    await loadGroups();
    await loadOverview();
}

// 加载同步组
async function loadGroups() {
    try {
        const response = await fetch('/api/groups');
        const data = await response.json();
        
        if (data.success) {
            currentGroups = data.data;
            populateGroupFilters();
        }
    } catch (error) {
        console.error('加载同步组失败:', error);
    }
}

// 填充组筛选下拉框
function populateGroupFilters() {
    const selectors = [
        'historyGroupFilter',
        'traceGroupFilter',
        'snapshotGroupFilter',
        'failureGroupFilter',
        'recordsGroupFilter'
    ];
    
    for (const id of selectors) {
        const select = document.getElementById(id);
        if (!select) continue;
        
        // 保留第一个选项
        const firstOption = select.options[0];
        select.innerHTML = '';
        select.appendChild(firstOption);
        
        // 添加组选项
        for (const group of currentGroups) {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = group.name || `组 ${group.id}`;
            select.appendChild(option);
        }
        
        // 如果只有一个组，默认选中
        if (currentGroups.length === 1) {
            select.value = currentGroups[0].id;
        }
    }
}

// 切换页面
function switchPage(pageName) {
    // 更新导航状态
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === pageName);
    });
    
    // 更新页面显示
    document.querySelectorAll('.page').forEach(page => {
        page.classList.toggle('active', page.id === `page-${pageName}`);
    });
    
    // 加载页面数据
    switch (pageName) {
        case 'overview':
            loadOverview();
            break;
        case 'history':
            loadHistory();
            break;
        case 'failures':
            loadFailures();
            break;
        case 'records':
            // 下拉列表已在 populateGroupFilters 中初始化
            break;
    }
}

// ==================== 概览页 ====================

async function loadOverview() {
    const container = document.getElementById('overviewContent');
    container.innerHTML = '<div class="loading">加载中...</div>';
    
    if (currentGroups.length === 0) {
        container.innerHTML = '<div class="empty">没有找到同步组</div>';
        return;
    }
    
    try {
        // 加载第一个组的诊断报告
        const groupId = currentGroups[0].id;
        const response = await fetch(`/api/diagnosis/report/${groupId}`);
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error);
        }
        
        const report = data.data;
        
        container.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-label">同步组</div>
                    <div class="stat-value">${report.group.name || '组 ' + groupId}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">总同步次数</div>
                    <div class="stat-value">${report.historyStats.total?.total || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">成功次数</div>
                    <div class="stat-value success">${report.historyStats.total?.success || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">失败次数</div>
                    <div class="stat-value error">${report.historyStats.total?.failed || 0}</div>
                </div>
            </div>
            
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-label">库存快照商品数</div>
                    <div class="stat-value">${report.stockStats?.total_products || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">总成功同步项</div>
                    <div class="stat-value success">${report.historyStats.total?.total_success_items || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">总失败同步项</div>
                    <div class="stat-value error">${report.historyStats.total?.total_failed_items || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">被去重记录数</div>
                    <div class="stat-value warning">${report.traceAnomalies?.deduplicated || 0}</div>
                </div>
            </div>
            
            <div class="card">
                <div class="card-title">失败原因分布</div>
                ${renderFailureReasonTable(report.failureStats)}
            </div>
            
            <div class="card">
                <div class="card-title">最近同步记录</div>
                ${renderHistoryTable(report.recentHistory)}
            </div>
            
            <div class="card">
                <div class="card-title">高频失败商品 (Top 10)</div>
                ${renderFrequentFailuresTable(report.frequentFailures.slice(0, 10))}
            </div>
        `;
    } catch (error) {
        container.innerHTML = `<div class="empty">加载失败: ${error.message}</div>`;
    }
}

// ==================== 同步历史页 ====================

async function loadHistory() {
    const container = document.getElementById('historyContent');
    container.innerHTML = '<div class="loading">加载中...</div>';
    
    const groupId = document.getElementById('historyGroupFilter').value;
    
    try {
        const url = groupId 
            ? `/api/history?groupId=${groupId}&limit=200` 
            : '/api/history?limit=200';
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error);
        }
        
        container.innerHTML = `
            <div class="card">
                <div class="card-title">同步历史 (${data.data.length} 条)</div>
                ${renderHistoryTable(data.data)}
            </div>
        `;
    } catch (error) {
        container.innerHTML = `<div class="empty">加载失败: ${error.message}</div>`;
    }
}

function renderHistoryTable(history) {
    if (!history || history.length === 0) {
        return '<div class="empty">暂无记录</div>';
    }
    
    return `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>类型</th>
                        <th>开始时间</th>
                        <th>状态</th>
                        <th>成功/失败</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${history.map(h => `
                        <tr>
                            <td>${h.id}</td>
                            <td>${h.sync_type === 'full' ? '全量' : '增量'}</td>
                            <td>${formatTime(h.start_time)}</td>
                            <td><span class="status status-${h.status}">${getStatusText(h.status)}</span></td>
                            <td>${h.success_items || 0} / ${h.failed_items || 0}</td>
                            <td>
                                <button class="btn btn-small" onclick="viewHistoryDetail(${h.group_id}, ${h.id})">查看</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

async function viewHistoryDetail(groupId, syncRunId) {
    try {
        const response = await fetch(`/api/history/run/${syncRunId}?groupId=${groupId}`);
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error);
        }
        
        showDetailDialog(`同步批次 #${syncRunId} 详情`, `
            <div class="card">
                <div class="card-title">追溯记录 (${data.data.length} 条)</div>
                ${renderTraceTableForHistory(data.data)}
            </div>
        `);
    } catch (error) {
        alert('加载失败: ' + error.message);
    }
}

// ==================== 追溯查询页 ====================

// 全局状态
let currentTraceData = { A: null, B: null };  // 分别存储 A/B 门店的数据
let currentTraceSide = 'A';   // 当前显示的门店侧
let currentTraceTab = 'all';  // 当前状态子 Tab
let currentTraceBarcode = ''; // 当前查询的条形码

async function searchTrace() {
    const groupId = document.getElementById('traceGroupFilter').value;
    const barcode = document.getElementById('traceBarcodeInput').value.trim();
    const container = document.getElementById('traceContent');
    
    if (!groupId) {
        alert('请选择同步组');
        return;
    }
    
    if (!barcode) {
        alert('请输入条形码');
        return;
    }
    
    currentTraceBarcode = barcode;
    
    // 隐藏所有追溯相关元素
    document.getElementById('traceSideTabs').style.display = 'none';
    document.getElementById('traceBaseline').style.display = 'none';
    document.getElementById('traceTabs').style.display = 'none';
    container.innerHTML = '<div class="loading">查询中...</div>';
    
    try {
        // 并行查询 A 和 B 两个门店的数据
        const [responseA, responseB] = await Promise.all([
            fetch(`/api/trace/raw/${encodeURIComponent(barcode)}?groupId=${groupId}&side=A`),
            fetch(`/api/trace/raw/${encodeURIComponent(barcode)}?groupId=${groupId}&side=B`)
        ]);
        
        const dataA = await responseA.json();
        const dataB = await responseB.json();
        
        if (!dataA.success) throw new Error(dataA.error);
        if (!dataB.success) throw new Error(dataB.error);
        
        // 存储两侧数据
        currentTraceData.A = dataA.data;
        currentTraceData.B = dataB.data;
        
        // 更新门店名称
        document.getElementById('sideAStoreName').textContent = dataA.data.storeName || '';
        document.getElementById('sideBStoreName').textContent = dataB.data.storeName || '';
        
        // 显示门店父级 Tab
        document.getElementById('traceSideTabs').style.display = 'flex';
        
        // 重置状态并渲染当前侧
        currentTraceSide = 'A';
        currentTraceTab = 'all';
        updateSideTabStyles();
        renderTraceResult(currentTraceData.A, barcode);
    } catch (error) {
        container.innerHTML = `<div class="empty">查询失败: ${error.message}</div>`;
    }
}

// 切换门店侧
function switchTraceSide(side) {
    if (side === currentTraceSide) return;
    
    currentTraceSide = side;
    currentTraceTab = 'all';  // 切换门店时重置子 Tab
    
    updateSideTabStyles();
    
    const data = currentTraceData[side];
    if (data) {
        renderTraceResult(data, currentTraceBarcode);
    }
}

// 更新门店侧 Tab 样式
function updateSideTabStyles() {
    document.querySelectorAll('.trace-side-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.side === currentTraceSide);
    });
}

function renderTraceResult(result, barcode) {
    const { baseline, records, theoreticalStock, storeName } = result;
    const oppositeSide = currentTraceSide === 'A' ? 'B' : 'A';
    
    // 更新基准信息
    const baselineEl = document.getElementById('traceBaseline');
    document.getElementById('baselineTitle').textContent = 
        `${currentTraceSide} 门店 - 全量同步基准`;
    
    if (baseline) {
        document.getElementById('baselineProductName').textContent = baseline.product_name || '-';
        document.getElementById('baselineBarcode').textContent = baseline.barcode || barcode;
        document.getElementById('baselineStock').textContent = baseline.current_stock ?? '-';
        document.getElementById('baselineTime').textContent = formatTime(baseline.created_at);
    } else {
        document.getElementById('baselineProductName').textContent = '-';
        document.getElementById('baselineBarcode').textContent = barcode;
        document.getElementById('baselineStock').textContent = '无基准';
        document.getElementById('baselineTime').textContent = '未执行全量同步';
    }
    
    // 显示理论库存
    document.getElementById('theoreticalStock').textContent = 
        theoreticalStock !== null ? theoreticalStock : '-';
    
    baselineEl.style.display = 'block';
    
    // 统计各状态数量
    const counts = {
        all: records.length,
        synced: records.filter(r => r.status === 'synced').length,
        filtered: records.filter(r => r.status === 'filtered').length,
        deduplicated: records.filter(r => r.status === 'deduplicated').length,
        failed: records.filter(r => r.status === 'failed').length
    };
    
    // 更新状态子 Tab 计数
    document.getElementById('tabCountAll').textContent = counts.all;
    document.getElementById('tabCountSynced').textContent = counts.synced;
    document.getElementById('tabCountFiltered').textContent = counts.filtered;
    document.getElementById('tabCountDeduplicated').textContent = counts.deduplicated;
    document.getElementById('tabCountFailed').textContent = counts.failed;
    
    // 更新子 Tab 样式
    document.querySelectorAll('.trace-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === currentTraceTab);
    });
    
    // 显示子 Tab
    document.getElementById('traceTabs').style.display = 'flex';
    
    // 渲染表格
    renderTraceTable(records, currentTraceTab);
}

function switchTraceTab(tab) {
    currentTraceTab = tab;
    
    // 更新 Tab 样式
    document.querySelectorAll('.trace-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tab);
    });
    
    // 重新渲染表格
    const data = currentTraceData[currentTraceSide];
    if (data) {
        renderTraceTable(data.records, tab);
    }
}

function renderTraceTable(records, tab) {
    const container = document.getElementById('traceContent');
    const oppositeSide = currentTraceSide === 'A' ? 'B' : 'A';
    
    // 根据 Tab 过滤记录
    let filteredRecords = records;
    if (tab !== 'all') {
        filteredRecords = records.filter(r => r.status === tab);
    }
    
    if (filteredRecords.length === 0) {
        container.innerHTML = '<div class="trace-table-container"><div class="empty">暂无记录</div></div>';
        return;
    }
    
    // 记录按时间倒序排列（最新在前），检测缺失需要比较当前的oldStock和下一条的newStock
    const rowsHtml = filteredRecords.map((r, index) => {
        // 下一条记录（时间更早的）
        const nextRecord = filteredRecords[index + 1];
        const gapInfo = calculateGap(r, nextRecord);
        
        return `
            <tr>
                <td>${r.opType || '修改门店商品'}</td>
                <td class="op-content">${formatOpContentWithGap(r, gapInfo)}</td>
                <td class="running-stock">${r.runningStock !== null ? r.runningStock : '-'}</td>
                <td>${r.barcode}</td>
                <td>${r.bizId || '-'}</td>
                <td>${formatTime(r.opTime)}</td>
                <td class="query-time">${formatTime(r.queryStart)}</td>
                <td class="query-time">${formatTime(r.queryEnd)}</td>
                <td class="op-user">${formatOpUser(r.opUser)}</td>
                <td>${formatSourceLabel(r, oppositeSide)}</td>
                <td><span class="status status-${r.status}">${getTraceStatusText(r.status)}</span></td>
                <td><span class="batch-tag">#${r.syncRunId || '-'}</span></td>
            </tr>
        `;
    }).join('');
    
    const html = `
        <div class="trace-table-container">
            <table class="trace-table">
                <thead>
                    <tr>
                        <th>操作类型</th>
                        <th>操作描述</th>
                        <th>同步后库存</th>
                        <th>条形码</th>
                        <th>商品ID</th>
                        <th>操作时间</th>
                        <th>查询起始</th>
                        <th>查询结束</th>
                        <th>操作人</th>
                        <th>来源标注</th>
                        <th>状态</th>
                        <th>批次</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;
    
    container.innerHTML = html;
}

// 计算库存缺失
function calculateGap(currentRecord, prevRecord) {
    if (!prevRecord) {
        return null; // 没有上一条记录（这是最早的记录）
    }
    
    // 如果两条相邻记录都是去重状态，不需要打标签（它们是同一条重复记录）
    if (currentRecord.status === 'deduplicated' && prevRecord.status === 'deduplicated') {
        return null;
    }
    
    const currentOld = currentRecord.oldStock;
    const prevNew = prevRecord.newStock;
    
    if (currentOld === null || currentOld === undefined || 
        prevNew === null || prevNew === undefined) {
        return null;
    }
    
    const gap = currentOld - prevNew;
    if (gap !== 0) {
        return { gap, currentOld, prevNew };
    }
    return null;
}

// 格式化操作内容（带缺失检测）
function formatOpContentWithGap(record, gapInfo) {
    let content = formatOpContent(record);
    
    if (gapInfo) {
        const gapClass = gapInfo.gap > 0 ? 'gap-positive' : 'gap-negative';
        const gapSign = gapInfo.gap > 0 ? '+' : '';
        content += ` <span class="gap-tag ${gapClass}" title="上条新库存${gapInfo.prevNew} → 本条老库存${gapInfo.currentOld}">⚠️ 缺失 ${gapSign}${gapInfo.gap}</span>`;
    }
    
    return content;
}

// 格式化来源标注
function formatSourceLabel(record, oppositeSide) {
    if (record.sourceLabel) {
        return `<span class="source-label echo">${record.sourceLabel}</span>`;
    }
    
    // 检查 opUser 判断来源
    if (record.opUser && record.opUser.includes('【API】')) {
        return `<span class="source-label sync">同步操作</span>`;
    }
    
    if (record.opUser && record.opUser.includes('【订单】')) {
        return `<span class="source-label order">本地订单</span>`;
    }
    
    return '-';
}

// 格式化操作描述
function formatOpContent(record) {
    const oldStock = record.oldStock ?? '-';
    const newStock = record.newStock ?? '-';
    const change = record.change ?? 0;
    const changeStr = change >= 0 ? `+${change}` : `${change}`;
    
    return `
        <div>
            <span class="stock-change stock-old">${oldStock}</span>
            <span class="stock-arrow">→</span>
            <span class="stock-change stock-new">${newStock}</span>
            <span style="margin-left: 8px; color: ${change < 0 ? '#cf1322' : '#389e0d'};">(${changeStr})</span>
        </div>
        ${record.statusReason ? `<div style="font-size: 11px; color: #999; margin-top: 4px;">${record.statusReason}</div>` : ''}
    `;
}

// 格式化操作人
function formatOpUser(opUser) {
    if (!opUser) return '-';
    
    // 兼容：部分历史日志里 opUser 会出现 "���平台】" 这类替换字符（U+FFFD）
    // 这里做显示层修复，尽可能还原为标准标签（无法 100% 还原原始字节，但至少不影响阅读）
    const normalized = String(opUser)
        .replace(/\uFFFD+平台】/g, '【平台】')
        .replace(/\uFFFD+API】/g, '【API】')
        .replace(/\uFFFD+订单】/g, '【订单】')
        .replace(/\uFFFD+子门店】/g, '【子门店】');
    
    let html = normalized;
    
    // 高亮标签
    if (normalized.includes('【平台】')) {
        html = html.replace('【平台】', '<span class="op-user-tag platform">平台</span>');
    }
    if (normalized.includes('【API】')) {
        html = html.replace('【API】', '<span class="op-user-tag api">API</span>');
    }
    if (normalized.includes('【订单】')) {
        html = html.replace('【订单】', '<span class="op-user-tag order">订单</span>');
    }
    if (normalized.includes('【子门店】')) {
        html = html.replace('【子门店】', '<span class="op-user-tag api">子门店</span>');
    }
    
    return html;
}

// 获取追溯状态文本
function getTraceStatusText(status) {
    const map = {
        'synced': '已同步',
        'filtered': '已过滤',
        'deduplicated': '已去重',
        'failed': '同步失败'
    };
    return map[status] || status || '-';
}

function renderTraceTableForHistory(records) {
    if (!records || records.length === 0) {
        return '<div class="empty">暂无记录</div>';
    }
    
    return `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>条形码</th>
                        <th>方向</th>
                        <th>变化量</th>
                        <th>当前库存</th>
                        <th>目标库存</th>
                        <th>结果</th>
                    </tr>
                </thead>
                <tbody>
                    ${records.map(r => `
                        <tr>
                            <td>${r.barcode}</td>
                            <td>${r.direction || '-'}</td>
                            <td>${formatChange(r.source_total_change)}</td>
                            <td>${r.current_stock ?? '-'}</td>
                            <td>${r.target_stock ?? '-'}</td>
                            <td><span class="status status-${r.apply_result}">${getResultText(r.apply_result)}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// ==================== 库存快照页 ====================

async function loadSnapshots() {
    const groupId = document.getElementById('snapshotGroupFilter').value;
    const container = document.getElementById('snapshotContent');
    
    if (!groupId) {
        container.innerHTML = '<div class="hint-box"><p>请选择同步组查看库存快照</p></div>';
        return;
    }
    
    container.innerHTML = '<div class="loading">加载中...</div>';
    
    try {
        const response = await fetch(`/api/diagnosis/snapshots/${groupId}`);
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error);
        }
        
        currentSnapshots = data.data;
        renderSnapshots(currentSnapshots);
    } catch (error) {
        container.innerHTML = `<div class="empty">加载失败: ${error.message}</div>`;
    }
}

function filterSnapshots() {
    const search = document.getElementById('snapshotSearchInput').value.toLowerCase();
    
    if (!search) {
        renderSnapshots(currentSnapshots);
        return;
    }
    
    const filtered = currentSnapshots.filter(s => 
        (s.barcode && s.barcode.toLowerCase().includes(search)) ||
        (s.product_name && s.product_name.toLowerCase().includes(search))
    );
    
    renderSnapshots(filtered);
}

function renderSnapshots(snapshots) {
    const container = document.getElementById('snapshotContent');
    
    if (!snapshots || snapshots.length === 0) {
        container.innerHTML = '<div class="empty">暂无库存快照</div>';
        return;
    }
    
    container.innerHTML = `
        <div class="card">
            <div class="card-title">库存快照 (${snapshots.length} 个商品)</div>
            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>条形码</th>
                            <th>商品名称</th>
                            <th>库存</th>
                            <th>更新时间</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${snapshots.slice(0, 500).map(s => `
                            <tr>
                                <td>${s.barcode}</td>
                                <td>${s.product_name || '-'}</td>
                                <td>${s.stock}</td>
                                <td>${formatTime(s.updated_at)}</td>
                                <td>
                                    <button class="btn btn-small" onclick="quickTrace('${s.barcode}')">追溯</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            ${snapshots.length > 500 ? `<p class="hint" style="margin-top: 12px;">仅显示前 500 条，共 ${snapshots.length} 条</p>` : ''}
        </div>
    `;
}

function quickTrace(barcode) {
    document.getElementById('traceBarcodeInput').value = barcode;
    const groupId = document.getElementById('snapshotGroupFilter').value;
    if (groupId) {
        document.getElementById('traceGroupFilter').value = groupId;
    }
    switchPage('trace');
    searchTrace();
}

// ==================== 失败分析页 ====================

async function loadFailures() {
    const container = document.getElementById('failureContent');
    container.innerHTML = '<div class="loading">加载中...</div>';
    
    const groupId = document.getElementById('failureGroupFilter').value;
    
    try {
        const [statsRes, frequentRes, logsRes] = await Promise.all([
            fetch(`/api/diagnosis/failures/stats${groupId ? `?groupId=${groupId}` : ''}`),
            fetch(`/api/diagnosis/failures/frequent${groupId ? `?groupId=${groupId}` : ''}`),
            fetch(`/api/diagnosis/failures${groupId ? `?groupId=${groupId}` : ''}`)
        ]);
        
        const [statsData, frequentData, logsData] = await Promise.all([
            statsRes.json(),
            frequentRes.json(),
            logsRes.json()
        ]);
        
        container.innerHTML = `
            <div class="card">
                <div class="card-title">失败原因分布</div>
                ${renderFailureReasonTable(statsData.data)}
            </div>
            
            <div class="card">
                <div class="card-title">高频失败商品</div>
                ${renderFrequentFailuresTable(frequentData.data)}
            </div>
            
            <div class="card">
                <div class="card-title">最近失败记录 (${logsData.data?.length || 0} 条)</div>
                ${renderFailureLogsTable(logsData.data)}
            </div>
        `;
    } catch (error) {
        container.innerHTML = `<div class="empty">加载失败: ${error.message}</div>`;
    }
}

function renderFailureReasonTable(stats) {
    if (!stats || stats.length === 0) {
        return '<div class="empty">暂无失败记录</div>';
    }
    
    return `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>失败原因</th>
                        <th>次数</th>
                        <th>涉及商品数</th>
                    </tr>
                </thead>
                <tbody>
                    ${stats.map(s => `
                        <tr>
                            <td>${s.error_msg || '未知'}</td>
                            <td>${s.count}</td>
                            <td>${s.unique_barcodes || '-'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function renderFrequentFailuresTable(products) {
    if (!products || products.length === 0) {
        return '<div class="empty">暂无记录</div>';
    }
    
    return `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>条形码</th>
                        <th>失败次数</th>
                        <th>错误类型</th>
                        <th>最后失败时间</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${products.map(p => `
                        <tr>
                            <td>${p.barcode}</td>
                            <td><span class="status status-failed">${p.fail_count}</span></td>
                            <td>${p.error_types || '-'}</td>
                            <td>${formatTime(p.last_fail_time)}</td>
                            <td>
                                <button class="btn btn-small" onclick="quickTrace('${p.barcode}')">追溯</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function renderFailureLogsTable(logs) {
    if (!logs || logs.length === 0) {
        return '<div class="empty">暂无失败记录</div>';
    }
    
    return `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>时间</th>
                        <th>条形码</th>
                        <th>操作类型</th>
                        <th>错误信息</th>
                    </tr>
                </thead>
                <tbody>
                    ${logs.map(l => `
                        <tr>
                            <td>${formatTime(l.created_at)}</td>
                            <td>${l.barcode}</td>
                            <td>${l.operation_type || '-'}</td>
                            <td>${l.error_msg || '-'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// ==================== 弹窗 ====================

function showDetailDialog(title, content) {
    document.getElementById('detailDialogTitle').textContent = title;
    document.getElementById('detailDialogContent').innerHTML = content;
    document.getElementById('detailDialog').showModal();
}

function closeDetailDialog() {
    document.getElementById('detailDialog').close();
}

// ==================== 工具函数 ====================

function formatTime(timeStr) {
    if (!timeStr) return '-';
    try {
        const date = new Date(timeStr);
        return date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch {
        return timeStr;
    }
}

function formatChange(change) {
    if (change === null || change === undefined) return '-';
    return change >= 0 ? `+${change}` : `${change}`;
}

function getStatusText(status) {
    const map = {
        'success': '成功',
        'failed': '失败',
        'partial': '部分成功',
        'running': '运行中',
        'cancelled': '已取消'
    };
    return map[status] || status;
}

function getResultText(result) {
    const map = {
        'success': '成功',
        'failed': '失败',
        'filtered': '已过滤',
        'deduplicated': '已去重'
    };
    return map[result] || result || '-';
}

// ==================== 操作记录查询 ====================

let recordsCurrentPage = 1;
let recordsTotalPages = 1;

// 页面切换时初始化下拉列表
function onRecordsGroupChange() {
    // 清空结果
    document.getElementById('recordsContent').innerHTML = '<div class="hint-box"><p>请设置过滤条件后点击查询</p></div>';
    document.getElementById('recordsPagination').style.display = 'none';
}

// 查询操作记录
async function searchRecords(page = 1) {
    const groupId = document.getElementById('recordsGroupFilter').value;
    if (!groupId) {
        alert('请选择同步组');
        return;
    }

    const side = document.getElementById('recordsSideFilter').value;
    const barcode = document.getElementById('recordsBarcodeInput').value.trim();
    const oldStock = document.getElementById('recordsOldStockInput').value;
    const newStock = document.getElementById('recordsNewStockInput').value;
    const syncRunIdStart = document.getElementById('recordsSyncIdStart').value;
    const syncRunIdEnd = document.getElementById('recordsSyncIdEnd').value;
    const pageSize = document.getElementById('recordsPageSize').value;

    const params = new URLSearchParams({
        groupId,
        page,
        pageSize
    });
    if (side) params.append('side', side);
    if (barcode) params.append('barcode', barcode);
    if (oldStock !== '') params.append('oldStock', oldStock);
    if (newStock !== '') params.append('newStock', newStock);
    if (syncRunIdStart) params.append('syncRunIdStart', syncRunIdStart);
    if (syncRunIdEnd) params.append('syncRunIdEnd', syncRunIdEnd);

    const container = document.getElementById('recordsContent');
    container.innerHTML = '<div class="loading">查询中...</div>';

    try {
        const response = await fetch(`/api/records?${params}`);
        const json = await response.json();

        if (!json.success) {
            container.innerHTML = `<div class="error">${json.error}</div>`;
            return;
        }

        const data = json.data;
        recordsCurrentPage = data.page;
        recordsTotalPages = data.totalPages;

        renderRecordsResult(data);
        updateRecordsPagination(data);
    } catch (error) {
        container.innerHTML = `<div class="error">查询失败: ${error.message}</div>`;
    }
}

// 渲染操作记录结果
function renderRecordsResult(data) {
    const container = document.getElementById('recordsContent');
    const { records, total } = data;

    if (records.length === 0) {
        container.innerHTML = '<div class="hint-box"><p>未找到符合条件的记录</p></div>';
        return;
    }

    const html = `
        <div class="records-summary">共找到 ${total} 条记录</div>
        <div class="records-table-container">
            <table class="records-table">
                <thead>
                    <tr>
                        <th>操作类型</th>
                        <th>操作描述</th>
                        <th>条形码</th>
                        <th>商品ID</th>
                        <th>操作时间</th>
                        <th>操作人</th>
                        <th>任务ID</th>
                        <th>查询起始</th>
                        <th>查询结束</th>
                        <th>库存变更</th>
                        <th>门店</th>
                    </tr>
                </thead>
                <tbody>
                    ${records.map(r => `
                        <tr>
                            <td>${r.opType || '-'}</td>
                            <td class="op-content">${formatRecordOpContent(r)}</td>
                            <td>${r.barcode}</td>
                            <td>${r.bizId || '-'}</td>
                            <td>${formatTimeWithTimezone(r.opTime)}</td>
                            <td class="op-user">${formatOpUser(r.opUser)}</td>
                            <td><span class="batch-tag">#${r.syncRunId}</span></td>
                            <td class="query-time">${formatTimeWithTimezone(r.queryStart)}</td>
                            <td class="query-time">${formatTimeWithTimezone(r.queryEnd)}</td>
                            <td class="stock-change ${r.change > 0 ? 'positive' : r.change < 0 ? 'negative' : ''}">${r.change > 0 ? '+' : ''}${r.change}</td>
                            <td><span class="side-tag side-${r.side}">${r.side}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
    container.innerHTML = html;
}

// 格式化操作描述
function formatRecordOpContent(record) {
    return `${record.oldStock} → ${record.newStock}`;
}

// 格式化时间（按本地时区显示；你系统是北京时间时，UTC 会自动 +8，无需手动加）
function formatTimeWithTimezone(timeStr) {
    if (!timeStr) return '-';
    try {
        const date = new Date(timeStr);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } catch (e) {
        return timeStr;
    }
}

// 更新分页控件
function updateRecordsPagination(data) {
    const pagination = document.getElementById('recordsPagination');
    const pageInfo = document.getElementById('recordsPageInfo');
    const prevBtn = document.getElementById('recordsPrevBtn');
    const nextBtn = document.getElementById('recordsNextBtn');

    if (data.totalPages <= 1) {
        pagination.style.display = 'none';
        return;
    }

    pagination.style.display = 'flex';
    pageInfo.textContent = `第 ${data.page} / ${data.totalPages} 页`;
    prevBtn.disabled = data.page <= 1;
    nextBtn.disabled = data.page >= data.totalPages;
}

// 上一页
function recordsPrevPage() {
    if (recordsCurrentPage > 1) {
        searchRecords(recordsCurrentPage - 1);
    }
}

// 下一页
function recordsNextPage() {
    if (recordsCurrentPage < recordsTotalPages) {
        searchRecords(recordsCurrentPage + 1);
    }
}

