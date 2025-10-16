# Electron API 迁移指南

## 概述

本项目已成功将所有Python后端API迁移到Electron/Node.js，实现了纯前端架构。所有API调用现在直接在Electron应用中完成，无需Python后端服务。

## ✅ 已完成的迁移

### 1. 饿了么API客户端 (`api/eleme-client.js`)

**核心功能：**
- ✅ Cookie验证和门店信息获取
- ✅ MD5签名算法（完全兼容Python版本）
- ✅ 商品导出完整流程
- ✅ 操作日志查询（增量同步核心）

**API列表：**

| 方法 | 类型 | 说明 |
|------|------|------|
| `getShopInfoFromCookies(cookieStr)` | 静态 | Cookie验证 |
| `getShopUserInfo()` | 实例 | 获取商户信息 |
| `createExportJob()` | 实例 | 创建导出任务 |
| `getJobList(page, pageSize)` | 实例 | 获取任务列表 |
| `getJobStatus(jobId, maxWait, pollInterval)` | 实例 | 轮询任务状态 |
| `getDownloadUrl(downloadFileKey)` | 实例 | 获取下载链接 |
| `downloadFile(url, savePath)` | 实例 | 下载文件 |
| `exportProducts(savePath)` | 实例 | 完整导出流程 |
| `queryOperationLog(startTime, endTime, ...)` | 实例 | 查询操作记录 |

**使用示例：**

```javascript
const ElemeClient = require('./api/eleme-client');

// 方式1：静态方法 - Cookie验证
const shopInfo = await ElemeClient.getShopInfoFromCookies(cookieStr);
console.log(shopInfo.seller_id, shopInfo.store_id);

// 方式2：实例方法 - 完整功能
const client = new ElemeClient({
    cookies: 'your_cookie_string',
    seller_id: '123456',
    store_id: '789012'
});

// 导出商品
const job = await client.exportProducts('data/eleme_products.xlsx');

// 查询操作记录（增量同步）
const endTime = Math.floor(Date.now() / 1000);
const startTime = endTime - 3600; // 1小时前
const logs = await client.queryOperationLog(startTime, endTime);
```

---

### 2. 牵牛花API客户端 (`api/qnh-client.js`)

**核心功能：**
- ✅ Cookie验证和门店列表获取
- ✅ mtgsig签名算法（简化版，待验证）
- ✅ 商品查询（支持条形码过滤）
- ✅ 商品导出完整流程
- ✅ 库存更新（单商品/批量门店）
- ✅ 缓存机制

**API列表：**

| 方法 | 类型 | 说明 |
|------|------|------|
| `getStores(cookieStr)` | 静态 | Cookie验证，获取门店列表 |
| `getStores(forceRefresh)` | 实例 | 获取门店列表（带缓存） |
| `getProducts(storeId, page, pageSize, upcList)` | 实例 | 获取商品列表 |
| `getProductsMapping(storeId, useExport)` | 实例 | 全量商品映射 |
| `getSkuIdsByBarcodes(storeId, barcodes)` | 实例 | 批量查询SKU ID |
| `exportProducts(storeId, exportPath)` | 实例 | 导出商品到Excel |
| `updateStock(storeId, skuId, newQuantity, comment)` | 实例 | 更新单商品库存 |
| `batchUpdateStock(storeIds, barcode, newQuantity)` | 实例 | ⚠️ 已废弃（效率低） |
| ✅ `batchUpdateMultipleSkus(storeId, skuUpdates, comment)` | 实例 | **核心批量更新（10个SKU/次）** |
| ✅ `updateStockByBarcodes(storeId, barcodeQuantities, batchSize)` | 实例 | **单门店批量更新** |
| ✅ `batchUpdateStockOptimized(updates, batchSize, comment)` | 实例 | **多门店批量更新（最高效）** |

**使用示例：**

```javascript
const QianniuhuaClient = require('./api/qnh-client');

// 方式1：静态方法 - Cookie验证
const result = await QianniuhuaClient.getStores(cookieStr);
console.log(result.storeList);

// 方式2：实例方法 - 完整功能
const client = new QianniuhuaClient({
    cookies: 'your_cookie_string'
});

// 获取门店列表（带缓存）
const stores = await client.getStores();

// 获取商品列表（支持条形码过滤）
const products = await client.getProducts(storeId, 1, 20, ['6901234567890']);

// 批量查询SKU ID（增量同步关键）
const barcodes = ['6901234567890', '6901234567891'];
const skuMapping = await client.getSkuIdsByBarcodes(storeId, barcodes);

// ⚠️ 旧版：效率低（已废弃）
await client.updateStock(storeId, skuId, 100, '库存同步');

// ✅ 新版：批量更新多个SKU（10个一次请求，10倍提速！）
const skuUpdates = [
    { skuId: 'sku001', newQuantity: 100 },
    { skuId: 'sku002', newQuantity: 200 },
    // ... 最多10个
];
await client.batchUpdateMultipleSkus(storeId, skuUpdates, '批量同步');

// ✅ 新版：单门店批量更新（自动分组）
const updates = [
    { barcode: '6901234567890', quantity: 100 },
    { barcode: '6901234567891', quantity: 200 }
];
await client.updateStockByBarcodes(storeId, updates, 10);

// ✅ 新版：多门店批量更新（最高效，并发处理）
const multiStoreUpdates = [
    { storeId: 'store1', barcode: '6901234567890', newQuantity: 100 },
    { storeId: 'store2', barcode: '6901234567891', newQuantity: 200 }
];
const result = await client.batchUpdateStockOptimized(multiStoreUpdates, 10);
console.log(`同步成功: ${result.success}/${result.total}`);
```

**详细文档**: 见 `BATCH_UPDATE_GUIDE.md`

---

### 3. 数据解析器 (`utils/parsers.js`)

**ElemeParser：**
- ✅ `parseExcel(filePath)` - 解析饿了么商品Excel
- ✅ `parseOperationLog(opLog)` - 解析单条操作记录
- ✅ `parseStockChange(opContent)` - 提取库存变化
- ✅ `parseOperationLogs(logsData)` - 批量解析操作记录
- ✅ `groupStockChangesByBarcode(parsedLogs)` - 按条形码分组

**QianniuhuaParser：**
- ✅ `parseExportExcel(excelPath)` - 解析牵牛花商品Excel

**使用示例：**

```javascript
const { ElemeParser, QianniuhuaParser } = require('./utils/parsers');

// 解析饿了么Excel
const products = ElemeParser.parseExcel('data/eleme_products.xlsx');
console.log(products[0].name, products[0].stock);

// 解析操作记录
const logsData = await elemeClient.queryOperationLog(startTime, endTime);
const parsedLogs = ElemeParser.parseOperationLogs(logsData);
const grouped = ElemeParser.groupStockChangesByBarcode(parsedLogs);

// 解析牵牛花Excel
const mapping = QianniuhuaParser.parseExportExcel('data/qnh_products.xlsx');
console.log(mapping['6901234567890']); // 输出: skuId
```

---

### 4. 日志系统 (`utils/logger.js`)

**功能：**
- ✅ 多级别日志：debug, info, warn, error
- ✅ 控制台输出（带颜色）
- ✅ 文件记录（按日期分割）
- ✅ 日志轮转（超过10MB自动备份）

**使用示例：**

```javascript
const logger = require('./utils/logger');

logger.debug('调试信息');
logger.info('普通信息');
logger.warn('警告信息');
logger.error('错误信息');

// 设置日志级别
logger.setLogLevel('debug');

// 创建自定义Logger
const { createLogger } = require('./utils/logger');
const customLogger = createLogger({
    logLevel: 'debug',
    enableFile: true,
    logDir: 'my-logs'
});
```

---

## 📦 依赖管理

### 已添加的依赖

```json
{
  "dependencies": {
    "xlsx": "^0.18.5"
  }
}
```

### 已移除的依赖

```json
{
  "dependencies": {
    "socket.io-client": "^4.5.4"  // ❌ 已移除（不再需要Python后端）
  }
}
```

### 安装依赖

```bash
cd electron-app
npm install
```

---

## 🚀 运行和测试

### 开发环境运行

```bash
cd electron-app
npm run dev
```

### API测试

```bash
# 修改 test-apis.js 中的Cookie和配置
node test-apis.js
```

### 打包（后续）

```bash
npm run build
```

---

## 🔧 与Python版本的对比

| 功能 | Python | JavaScript | 状态 |
|------|--------|-----------|------|
| 饿了么Cookie验证 | ✅ | ✅ | ✅ 完全兼容 |
| 饿了么MD5签名 | ✅ | ✅ | ✅ 算法一致 |
| 饿了么商品导出 | ✅ | ✅ | ✅ 功能完整 |
| 饿了么操作日志 | ✅ | ✅ | ✅ 功能完整 |
| 牵牛花Cookie验证 | ✅ | ✅ | ✅ 完全兼容 |
| 牵牛花mtgsig签名 | ✅ (完整版) | ✅ (完整版) | ✅ **已验证通过** |
| 牵牛花商品查询 | ✅ | ✅ | ✅ 功能完整 |
| 牵牛花商品导出 | ✅ | ✅ | ✅ 功能完整 |
| 牵牛花库存更新 | ✅ | ✅ | ✅ 功能完整 |
| Excel解析 | ✅ pandas/openpyxl | ✅ xlsx | ✅ 功能等效 |
| HTTP请求 | ✅ requests | ✅ https (内置) | ✅ 功能等效 |

---

## ⚠️ 注意事项

### 1. 牵牛花mtgsig签名 ✅

**状态**: ✅ 已完成集成并验证通过

已集成完整的mtgsig.js签名库（7900行），所有API调用正常：
- ✅ Cookie验证成功
- ✅ 门店列表获取成功  
- ✅ 商品查询成功
- ✅ 签名验证100%通过

**技术要点**: 
- 完整库位于 `lib/mtgsig.js`
- 已处理Node.js原生对象兼容性（Buffer, global等）
- 详见: `MTGSIG_INTEGRATION_SUCCESS.md`

### 2. Cookie有效期

Cookie会过期，需要定期更新。建议在UI中添加Cookie刷新功能。

### 3. 请求限流

避免频繁请求导致封号，建议：
- 导出任务轮询间隔：5-10秒
- 批量更新库存间隔：0.5秒
- 单次批量查询：≤50条

### 4. 错误处理

所有API方法都会抛出异常，需要适当的try-catch处理：

```javascript
try {
    const result = await client.exportProducts(savePath);
} catch (error) {
    logger.error('导出失败:', error);
    // 处理错误
}
```

---

## 📋 下一步计划

### 阶段五：同步引擎逻辑迁移

- [ ] 创建 `SyncEngine` 类
- [ ] 实现全量同步流程
- [ ] 实现增量同步流程
- [ ] 产品匹配逻辑
- [ ] 数据库操作（SQLite）

### 阶段六：UI界面完善

- [ ] 配置管理页面
- [ ] 同步控制页面
- [ ] 历史记录页面
- [ ] 实时日志显示

### 阶段七：数据库和日志系统集成

- [ ] SQLite数据库封装
- [ ] 同步历史记录
- [ ] 商品映射缓存
- [ ] 操作日志记录

### 阶段八：打包和分发

- [ ] Electron打包配置
- [ ] 生成Windows安装包
- [ ] 自动更新机制

---

## 📚 相关文件

- **API客户端**
  - `api/eleme-client.js` - 饿了么API客户端
  - `api/qnh-client.js` - 牵牛花API客户端
  
- **工具模块**
  - `utils/parsers.js` - 数据解析器
  - `utils/logger.js` - 日志系统
  
- **主进程**
  - `main.js` - Electron主进程（已简化）
  
- **测试**
  - `test-apis.js` - API测试脚本
  
- **Python参考**
  - `../src/platforms/eleme/` - 饿了么Python实现（参考用）
  - `../src/platforms/qianniuhua/` - 牵牛花Python实现（参考用）

---

## 🤝 贡献

如发现问题或有改进建议，请：
1. 对照Python版本验证逻辑
2. 检查API响应格式
3. 添加必要的错误处理
4. 更新相关文档

---

## 📝 更新日志

### v1.0.0 (2025-10-15)

- ✅ 完成饿了么API客户端迁移
- ✅ 完成牵牛花API客户端迁移
- ✅ 完成数据解析器模块
- ✅ 完成日志系统
- ✅ 移除Python后端依赖
- ✅ 简化Electron主进程

