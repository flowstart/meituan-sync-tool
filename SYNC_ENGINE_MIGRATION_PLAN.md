# 🎯 同步引擎迁移计划

## 概述

将Python同步引擎完整迁移到Electron/Node.js，实现饿了么到牵牛花的全量/增量库存同步。

---

## 📋 迁移范围

### 核心模块（3个）

1. **SyncEngine** - 同步引擎主类
2. **ProductMatcher** - 商品匹配器
3. **Database** - SQLite数据库

### 核心功能（2个）

1. **全量同步** - 导出所有商品并同步库存
2. **增量同步** - 查询操作记录并同步变化

---

## 🗂️ 文件结构

```
electron-app/
├── core/
│   ├── sync-engine.js           # 同步引擎主类（新增）
│   └── product-matcher.js       # 商品匹配器（新增）
├── database/
│   └── database.js               # SQLite数据库（新增）
├── api/                          # API客户端（已完成）
│   ├── eleme-client.js           ✅ 已完成
│   └── qnh-client.js             ✅ 已完成（含批量更新优化）
└── utils/                        # 工具模块（已完成）
    ├── parsers.js                ✅ 已完成
    └── logger.js                 ✅ 已完成
```

---

## 📦 阶段一：数据库模块（Database）

### 功能清单

参考Python代码：`src/database/db.py`

| 方法 | 功能 | 优先级 |
|------|------|--------|
| `constructor(dbPath)` | 初始化数据库连接 | ⭐⭐⭐ |
| `_initDatabase()` | 创建表结构和索引 | ⭐⭐⭐ |
| `addSyncHistory()` | 添加同步历史记录 | ⭐⭐⭐ |
| `updateSyncHistory()` | 更新同步历史记录 | ⭐⭐⭐ |
| `saveProductMapping()` | 保存商品映射 | ⭐⭐⭐ |
| `addOperationLog()` | 添加操作日志 | ⭐⭐ |
| `getLastSyncTime()` | 获取上次同步时间 | ⭐⭐ |
| `setConfig() / getConfig()` | 配置管理 | ⭐⭐ |
| `getSyncStats()` | 获取同步统计 | ⭐ |
| `close()` | 关闭数据库连接 | ⭐⭐⭐ |

### 数据库表结构

```sql
-- 1. 同步历史表
CREATE TABLE sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_type TEXT NOT NULL,           -- 'full' 或 'incremental'
    start_time TEXT NOT NULL,
    end_time TEXT,
    status TEXT NOT NULL,              -- 'running', 'success', 'failed'
    total_items INTEGER DEFAULT 0,
    success_items INTEGER DEFAULT 0,
    failed_items INTEGER DEFAULT 0,
    error_msg TEXT,
    created_at TEXT NOT NULL
);

-- 2. 商品映射表
CREATE TABLE product_mapping (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eleme_barcode TEXT UNIQUE NOT NULL,
    qnh_sku_id TEXT NOT NULL,
    eleme_product_name TEXT,
    qnh_product_name TEXT,
    last_sync_time TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 3. 操作日志表
CREATE TABLE operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_type TEXT NOT NULL,      -- 'full_sync' 或 'incremental_sync'
    barcode TEXT,
    old_stock INTEGER,
    new_stock INTEGER,
    store_id TEXT,
    success INTEGER DEFAULT 1,         -- 1=成功, 0=失败
    error_msg TEXT,
    created_at TEXT NOT NULL
);

-- 4. 配置表
CREATE TABLE config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL
);
```

### 技术要点

**Node.js库选择**：
- **推荐**: `better-sqlite3` (同步API，性能更好)
- 备选: `sqlite3` (异步API)

**安装**：
```bash
npm install better-sqlite3
```

**基本使用**：
```javascript
const Database = require('better-sqlite3');
const db = new Database('data/sync.db');

// 同步查询
const row = db.prepare('SELECT * FROM sync_history WHERE id = ?').get(id);

// 同步插入
const insert = db.prepare('INSERT INTO sync_history (...) VALUES (...)');
insert.run(values);
```

---

## 🔍 阶段二：商品匹配器（ProductMatcher）

### 功能清单

参考Python代码：`src/core/matcher.py`

| 方法 | 功能 | 实现 |
|------|------|------|
| `constructor()` | 初始化匹配器 | 内存缓存 |
| `matchByBarcode(barcode, qnhMapping)` | 单条形码匹配 | 精确匹配 |
| `batchMatch(elemeProducts, qnhMapping)` | 批量匹配 | 循环匹配 |
| `getUnmatched()` | 获取未匹配列表 | 返回数组 |
| `getMatchCache()` | 获取匹配缓存 | 返回对象 |
| `clearCache()` | 清空缓存 | 清空对象 |
| `getMatchStats()` | 获取匹配统计 | 计算统计 |

### 匹配逻辑

```javascript
class ProductMatcher {
    constructor() {
        this._matchCache = {};      // {eleme_barcode: qnh_sku_id}
        this._unmatched = [];       // [barcode1, barcode2, ...]
    }
    
    matchByBarcode(elemeBarcode, qnhMapping) {
        // 1. 检查缓存
        if (this._matchCache[elemeBarcode]) {
            return this._matchCache[elemeBarcode];
        }
        
        // 2. 精确匹配
        if (qnhMapping[elemeBarcode]) {
            const skuId = qnhMapping[elemeBarcode];
            this._matchCache[elemeBarcode] = skuId;
            return skuId;
        }
        
        // 3. 未匹配
        if (!this._unmatched.includes(elemeBarcode)) {
            this._unmatched.push(elemeBarcode);
        }
        return null;
    }
}
```

---

## 🚀 阶段三：同步引擎主类（SyncEngine）

### 功能清单

参考Python代码：`src/core/sync_engine.py`

| 方法 | 功能 | 复杂度 |
|------|------|--------|
| `constructor(elemeConfig, qnhConfig, dbPath)` | 初始化引擎 | 简单 |
| `_loadQnhStores()` | 加载牵牛花门店 | 简单 |
| `fullSync(exportPath)` | 全量同步 | ⭐⭐⭐ 复杂 |
| `incrementalSync(timeRange, startTime)` | 增量同步 | ⭐⭐⭐ 复杂 |
| `getStats()` | 获取统计信息 | 简单 |
| `close()` | 关闭资源 | 简单 |

### 全量同步流程（7步）

```javascript
async fullSync(exportPath = 'data/eleme_products_sync.xlsx') {
    const startTime = new Date();
    const syncId = this.db.addSyncHistory('full', startTime, 'running');
    
    try {
        // 步骤1: 导出饿了么商品
        const job = await this.elemeClient.exportProducts(exportPath);
        
        // 步骤2: 解析商品
        const elemeProducts = ElemeParser.parseExcel(exportPath);
        
        // 步骤3: 加载牵牛花门店
        await this._loadQnhStores();
        
        // 步骤4: 获取牵牛花商品映射
        const qnhMapping = await this.qnhClient.getProductsMapping(this.qnhStoreIds[0]);
        
        // 步骤5: 匹配商品
        const matches = this.matcher.batchMatch(elemeProducts, qnhMapping);
        
        // 步骤6: 批量更新库存（使用优化的批量更新方法）
        const updates = [];
        for (const [barcode, skuId] of Object.entries(matches)) {
            if (!skuId) continue;
            const product = elemeProducts.find(p => p.barcode === barcode);
            for (const storeId of this.qnhStoreIds) {
                updates.push({
                    storeId: storeId,
                    barcode: barcode,
                    newQuantity: product.stock
                });
            }
        }
        
        // 使用优化的批量更新（10个SKU一组，并发处理）
        const result = await this.qnhClient.batchUpdateStockOptimized(updates, 10);
        
        // 步骤7: 记录结果
        this.db.updateSyncHistory(syncId, new Date(), 'success', {
            total_items: matches.length,
            success_items: result.success,
            failed_items: result.failed
        });
        
        return result;
    } catch (error) {
        this.db.updateSyncHistory(syncId, new Date(), 'failed', error.message);
        throw error;
    }
}
```

### 增量同步流程（6步）

```javascript
async incrementalSync(timeRange = 3600, startTime = null) {
    const syncStart = new Date();
    const syncId = this.db.addSyncHistory('incremental', syncStart, 'running');
    
    try {
        // 步骤1: 确定时间范围
        if (!startTime) {
            const lastSync = this.db.getLastSyncTime('incremental');
            startTime = lastSync || Math.floor(Date.now() / 1000) - timeRange;
        }
        const endTime = Math.floor(Date.now() / 1000);
        
        // 步骤2: 查询饿了么操作记录
        const logsData = await this.elemeClient.queryOperationLog(startTime, endTime);
        
        // 步骤3: 解析库存变化
        const parsedLogs = ElemeParser.parseOperationLogs(logsData);
        const grouped = ElemeParser.groupStockChangesByBarcode(parsedLogs);
        
        // 步骤4: 加载门店和商品映射
        await this._loadQnhStores();
        const qnhMapping = await this.qnhClient.getProductsMapping(this.qnhStoreIds[0]);
        
        // 步骤5: 准备批量更新
        const updates = [];
        for (const [barcode, data] of Object.entries(grouped)) {
            const skuId = this.matcher.matchByBarcode(barcode, qnhMapping);
            if (!skuId) continue;
            
            for (const storeId of this.qnhStoreIds) {
                updates.push({
                    storeId: storeId,
                    barcode: barcode,
                    newQuantity: data.final_stock
                });
            }
        }
        
        // 步骤6: 批量更新库存
        const result = await this.qnhClient.batchUpdateStockOptimized(updates, 10);
        
        this.db.updateSyncHistory(syncId, new Date(), 'success', {
            total_items: grouped.length,
            success_items: result.success,
            failed_items: result.failed
        });
        
        return result;
    } catch (error) {
        this.db.updateSyncHistory(syncId, new Date(), 'failed', error.message);
        throw error;
    }
}
```

---

## ⚡ 性能优化

### 批量更新优化

**旧版（Python）**：
```python
# 循环更新，每次一个SKU
for barcode, sku_id in matches.items():
    for store_id in store_ids:
        update_stock(store_id, sku_id, new_quantity)
        time.sleep(0.5)
# 100个商品 × 5个门店 = 500次请求 = ~250秒
```

**新版（JavaScript）**：
```javascript
// 批量更新，10个SKU一组，并发处理
const updates = [...];  // 准备所有更新
const result = await qnhClient.batchUpdateStockOptimized(updates, 10);
// 100个商品 × 5个门店 = 50次请求（并发）= ~5秒
// 性能提升：50倍！
```

---

## 🔧 技术栈

| Python | Node.js | 说明 |
|--------|---------|------|
| `sqlite3` | `better-sqlite3` | SQLite数据库 |
| `datetime` | `Date` (内置) | 日期时间处理 |
| `time.sleep()` | `await sleep()` | 延时 |
| `typing` | JSDoc | 类型注解 |

---

## 📝 依赖安装

```bash
cd electron-app
npm install better-sqlite3
```

---

## 🎯 实施步骤

### 第1步：数据库模块（1-2小时）

1. 创建 `database/database.js`
2. 实现表结构初始化
3. 实现CRUD方法
4. 测试数据库操作

### 第2步：商品匹配器（30分钟）

1. 创建 `core/product-matcher.js`
2. 实现匹配逻辑
3. 实现缓存机制
4. 测试匹配功能

### 第3步：同步引擎主类（2-3小时）

1. 创建 `core/sync-engine.js`
2. 实现初始化和工具方法
3. 实现全量同步流程
4. 实现增量同步流程
5. 集成批量更新优化

### 第4步：测试和验证（1小时）

1. 创建测试脚本 `test-sync-engine.js`
2. 测试全量同步
3. 测试增量同步
4. 性能对比测试

**总计时间**：约5-7小时

---

## ✅ 验收标准

### 功能完整性

- [x] 数据库表结构正确创建
- [ ] 全量同步流程完整执行
- [ ] 增量同步流程完整执行
- [ ] 商品匹配准确率100%
- [ ] 批量更新成功率>95%

### 性能指标

- [ ] 全量同步（100商品×5门店）：<10秒
- [ ] 增量同步（10商品×5门店）：<2秒
- [ ] 数据库操作延迟：<10ms
- [ ] 内存占用：<200MB

### 兼容性

- [ ] 与Python版本逻辑100%一致
- [ ] 数据库格式兼容（可读取现有数据）
- [ ] API调用格式正确

---

## 🚨 注意事项

### 1. 数据库连接

- **问题**: SQLite不支持并发写入
- **解决**: 使用 `better-sqlite3` 的事务机制

### 2. 批量更新优化

- **关键**: 使用新的 `batchUpdateStockOptimized()` 方法
- **效果**: 性能提升50倍

### 3. 错误处理

- **要求**: 单个商品失败不影响其他商品
- **实现**: try-catch + 详细日志记录

### 4. 时间戳处理

- **Python**: 秒级时间戳 (`int(time.time())`)
- **JavaScript**: 毫秒级时间戳 (`Date.now()`)
- **转换**: `Math.floor(Date.now() / 1000)`

---

## 📋 后续任务（迁移外）

完成同步引擎后：

1. **UI集成** - 在界面中添加同步按钮
2. **定时任务** - 实现自动定时同步
3. **进度显示** - 实时显示同步进度
4. **历史记录** - 查看同步历史和统计

---

## 📚 参考文档

- **Python源码**: 
  - `src/core/sync_engine.py` - 同步引擎
  - `src/core/matcher.py` - 商品匹配
  - `src/database/db.py` - 数据库

- **已完成模块**:
  - `api/eleme-client.js` - 饿了么API
  - `api/qnh-client.js` - 牵牛花API
  - `utils/parsers.js` - 数据解析
  - `BATCH_UPDATE_GUIDE.md` - 批量更新指南

---

**制定日期**: 2025-10-15

**预计工期**: 5-7小时

**状态**: ✅ Ready to Start

