# 📦 批量库存更新指南

## 概述

新增了**高效批量更新**方法，支持**一次请求更新多个SKU**，大幅提升同步效率。

---

## 🆕 新增方法

### 1. `batchUpdateMultipleSkus()` - 核心批量更新

**功能**: 一次请求更新多个SKU（最核心的优化）

**参数**:
```javascript
storeId: string              // 门店ID
skuUpdates: Array<Object>    // SKU更新列表
  [{
    skuId: 'xxx',           // SKU ID
    newQuantity: 100,       // 新库存
    comment: '备注'          // 可选
  }]
comment: string              // 整体备注（可选）
```

**使用示例**:
```javascript
const QianniuhuaClient = require('./api/qnh-client');
const client = new QianniuhuaClient({ cookies: 'xxx' });

// 一次请求更新10个SKU
const skuUpdates = [
    { skuId: 'sku001', newQuantity: 100 },
    { skuId: 'sku002', newQuantity: 200 },
    { skuId: 'sku003', newQuantity: 150 },
    // ... 最多10个
];

const success = await client.batchUpdateMultipleSkus('storeId', skuUpdates, '批量同步');
```

---

### 2. `updateStockByBarcodes()` - 单门店批量更新

**功能**: 更新单个门店的多个商品（自动分组，10个一批）

**参数**:
```javascript
storeId: string                    // 门店ID
barcodeQuantities: Array<Object>   // 条形码和数量列表
  [{
    barcode: '6901234567890',     // 条形码
    quantity: 100,                // 新库存
    comment: '备注'                // 可选
  }]
batchSize: number                  // 每批SKU数量（默认10）
```

**使用示例**:
```javascript
// 更新单个门店的50个商品
const updates = [
    { barcode: '6901234567890', quantity: 100 },
    { barcode: '6901234567891', quantity: 200 },
    // ... 50个商品
];

const result = await client.updateStockByBarcodes('storeId', updates, 10);

console.log(result);
// {
//   total: 50,           // 总数
//   found: 48,           // 找到的
//   notFound: 2,         // 未找到的
//   success: 48,         // 成功
//   failed: 0,           // 失败
//   notFoundBarcodes: ['xxx', 'yyy']
// }
```

---

### 3. `batchUpdateStockOptimized()` - 多门店批量更新

**功能**: 更新多个门店的多个商品（并发处理，最高效）

**参数**:
```javascript
updates: Array<Object>      // 更新列表
  [{
    storeId: 'xxx',        // 门店ID
    barcode: 'xxx',        // 条形码
    newQuantity: 100,      // 新库存
    comment: '备注'         // 可选
  }]
batchSize: number           // 每批SKU数量（默认10）
comment: string             // 整体备注（可选）
```

**使用示例**:
```javascript
// 更新5个门店的100个商品
const updates = [
    { storeId: 'store1', barcode: '6901234567890', newQuantity: 100 },
    { storeId: 'store1', barcode: '6901234567891', newQuantity: 200 },
    { storeId: 'store2', barcode: '6901234567890', newQuantity: 150 },
    // ... 100个更新
];

const result = await client.batchUpdateStockOptimized(updates, 10);

console.log(result);
// {
//   total: 100,
//   success: 95,
//   failed: 5,
//   details: {
//     'store1': { total: 40, success: 40, failed: 0 },
//     'store2': { total: 30, success: 28, failed: 2 },
//     // ...
//   }
// }
```

---

## 📊 性能对比

### 场景：更新1个门店的100个商品

| 方法 | 请求次数 | 签名计算 | 耗时 | 效率 |
|------|---------|---------|------|------|
| 旧版 `updateStock()` 循环 | **100次** | 100次 | ~50秒 | 😢 极慢 |
| 旧版 `batchUpdateStock()` | **100次** | 100次 | ~50秒 | 😢 极慢 |
| ✅ **`updateStockByBarcodes()`** | **10次** | 10次 | ~5秒 | 🚀 **10倍提速** |

### 场景：更新5个门店的100个商品（每门店20个）

| 方法 | 请求次数 | 签名计算 | 耗时 | 效率 |
|------|---------|---------|------|------|
| 旧版顺序执行 | **500次** | 500次 | ~250秒 | 😢 极慢 |
| ✅ **`batchUpdateStockOptimized()`** | **50次** | 50次 | ~25秒 | 🚀 **10倍提速** |

---

## 💡 使用建议

### 1. 单门店更新 → 使用 `updateStockByBarcodes()`

```javascript
// 适用场景：同步单个门店的库存
const updates = products.map(p => ({
    barcode: p.barcode,
    quantity: p.stock
}));

await client.updateStockByBarcodes(storeId, updates, 10);
```

### 2. 多门店更新 → 使用 `batchUpdateStockOptimized()`

```javascript
// 适用场景：同步多个门店的库存
const updates = [];
for (const store of stores) {
    for (const product of products) {
        updates.push({
            storeId: store.id,
            barcode: product.barcode,
            newQuantity: product.stock
        });
    }
}

await client.batchUpdateStockOptimized(updates, 10);
```

### 3. 已知SKU ID → 直接使用 `batchUpdateMultipleSkus()`

```javascript
// 适用场景：已知SKU ID，无需查询映射
const skuUpdates = [
    { skuId: 'sku001', newQuantity: 100 },
    { skuId: 'sku002', newQuantity: 200 }
];

await client.batchUpdateMultipleSkus(storeId, skuUpdates);
```

---

## ⚙️ 参数调优

### batchSize（每批SKU数量）

**推荐值**: 10

- **太小**（如5）: 请求次数多，效率低
- **太大**（如50）: 可能超时或被限流
- **最佳**（10-15）: 平衡效率和稳定性

**测试不同batchSize**:
```javascript
// 测试 batchSize = 5
await client.updateStockByBarcodes(storeId, updates, 5);

// 测试 batchSize = 10（推荐）
await client.updateStockByBarcodes(storeId, updates, 10);

// 测试 batchSize = 15
await client.updateStockByBarcodes(storeId, updates, 15);
```

### 请求间隔

**默认**: 500ms（0.5秒）

修改方法：
```javascript
// 在 batchUpdateMultipleSkus() 方法中
// 找到: await this._sleep(500);
// 改为: await this._sleep(1000); // 1秒间隔
```

---

## 🔧 集成到同步引擎

### 全量同步优化

```javascript
async function fullSync(elemeProducts, stores) {
    // 准备批量更新数据
    const updates = [];
    for (const store of stores) {
        for (const product of elemeProducts) {
            updates.push({
                storeId: store.id,
                barcode: product.barcode,
                newQuantity: product.stock
            });
        }
    }
    
    // 批量更新（10个SKU一组）
    const result = await qnhClient.batchUpdateStockOptimized(updates, 10);
    
    console.log(`全量同步完成: ${result.success}/${result.total}`);
}
```

### 增量同步优化

```javascript
async function incrementalSync(stockChanges, stores) {
    // 准备批量更新数据（只更新变化的商品）
    const updates = [];
    for (const store of stores) {
        for (const change of stockChanges) {
            updates.push({
                storeId: store.id,
                barcode: change.barcode,
                newQuantity: change.finalStock
            });
        }
    }
    
    // 批量更新
    const result = await qnhClient.batchUpdateStockOptimized(updates, 10);
    
    console.log(`增量同步完成: ${result.success}/${result.total}`);
}
```

---

## 📈 效率提升总结

### 优化前（旧版）

```
更新100个商品 × 5个门店 = 500次请求
每次请求 ~0.5秒
总耗时: ~250秒（4分钟）
```

### 优化后（新版）

```
按门店分组 → 5个门店并发
每门店100商品 ÷ 10（批量）= 10次请求
每门店耗时: ~5秒
总耗时: ~5秒（并发处理）

提速: 250秒 → 5秒 = 50倍！
```

---

## ⚠️ 注意事项

1. **请求限流**: 避免过快请求导致封号
   - 批次间延迟：500ms（已设置）
   - 建议batchSize不超过15

2. **错误处理**: 单个批次失败不影响其他批次
   - 返回详细的成功/失败统计
   - 记录未找到的条形码

3. **内存占用**: 大量更新时注意内存
   - 建议分批处理（如1000个一批）
   - 处理完一批再处理下一批

4. **商品映射缓存**: 会自动缓存，提升效率
   - 首次查询会较慢（获取映射）
   - 后续更新使用缓存，极快

---

## 🎯 最佳实践

```javascript
// 1. 创建客户端
const client = new QianniuhuaClient({ cookies: 'xxx' });

// 2. 准备更新数据（从饿了么同步过来）
const updates = elemeProducts.map(product => ({
    storeId: targetStoreId,
    barcode: product.barcode,
    newQuantity: product.stock
}));

// 3. 批量更新（自动分组、并发处理）
const result = await client.batchUpdateStockOptimized(updates, 10);

// 4. 处理结果
if (result.failed > 0) {
    console.error(`有 ${result.failed} 个更新失败`);
    console.log('失败详情:', result.details);
}

console.log(`同步成功率: ${(result.success / result.total * 100).toFixed(2)}%`);
```

---

## 📋 API方法对比表

| 方法 | 场景 | 效率 | 推荐度 |
|------|------|------|--------|
| `updateStock()` | 单个SKU | ⭐ 慢 | ❌ 不推荐 |
| `batchUpdateStock()` | 多门店单商品 | ⭐ 慢 | ❌ 已废弃 |
| ✅ `batchUpdateMultipleSkus()` | 单门店多SKU | ⭐⭐⭐⭐⭐ 极快 | ✅ **推荐** |
| ✅ `updateStockByBarcodes()` | 单门店多商品 | ⭐⭐⭐⭐⭐ 极快 | ✅ **推荐** |
| ✅ `batchUpdateStockOptimized()` | 多门店多商品 | ⭐⭐⭐⭐⭐ 极快 | ✅ **最推荐** |

---

**更新日期**: 2025-10-15

**版本**: v1.1.0 - Batch Update Optimization

