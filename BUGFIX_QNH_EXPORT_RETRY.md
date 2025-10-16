# 牵牛花导出任务失败重试机制修复

## 问题描述

在全量同步过程中，牵牛花平台导出商品Excel任务如果失败（状态为"执行失败"），原有代码会继续轮询等待，导致：

1. **无意义的等待**：任务已失败，继续轮询不会成功，浪费时间
2. **无法重试**：失败后不会重新创建导出任务
3. **缺少回退方案**：没有备用方案来获取商品数据

### 终端日志示例

```
[QNH] 找到任务ID 41733561: 状态=执行失败
[QNH] 第1次查询: 任务状态=执行失败，已等待10秒
[QNH] 第2次查询: 任务状态=执行失败，已等待20秒
[QNH] 第3次查询: 任务状态=执行失败，已等待30秒
...（持续轮询直到超时）
```

---

## 解决方案

### 1. 识别失败状态并立即停止轮询

**修改文件**: `electron-app/api/qnh-client.js`

**修改位置**: `_exportProductsOnce` 方法中的任务状态判断

```javascript
// 原代码只检查 '处理失败'
} else if (status === '处理失败' || status === '已取消') {
    const errorMsg = taskStatus.handleResult || '未知错误';
    console.error(`[QNH] 导出任务失败: ${errorMsg}`);
    return null;
}

// 新代码增加 '执行失败' 状态
} else if (status === '处理失败' || status === '执行失败' || status === '已取消') {
    const errorMsg = taskStatus.handleResult || '未知错误';
    console.error(`[QNH] 导出任务${status}: ${errorMsg}`);
    console.error(`[QNH] 任务ID ${taskId} 失败，停止轮询`);
    return null; // 立即返回失败，不再继续轮询
}
```

**关键改进**:
- ✅ 增加对"执行失败"状态的识别
- ✅ 立即停止轮询，返回失败
- ✅ 清晰的日志提示

---

### 2. 实现自动重试机制（最多3次）

**修改文件**: `electron-app/api/qnh-client.js`

**改造思路**:
- 将原有的 `exportProducts` 方法重构为 `_exportProductsOnce`（单次导出）
- 新的 `exportProducts` 方法实现重试逻辑

```javascript
/**
 * 导出门店商品列表到Excel（支持重试）
 * @param {string} storeId - 门店ID
 * @param {string} exportPath - 导出文件路径（可选）
 * @param {number} maxRetries - 最大重试次数（默认3次）
 * @returns {Promise<string|null>} 导出文件路径，失败返回null
 */
async exportProducts(storeId, exportPath = null, maxRetries = 3) {
    if (!exportPath) {
        exportPath = `data/qnh_products_store_${storeId}.xlsx`;
    }

    // 重试逻辑
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[QNH] 导出商品 - 第${attempt}次尝试（共${maxRetries}次）`);
        
        const result = await this._exportProductsOnce(storeId, exportPath);
        
        if (result) {
            // 成功
            console.log(`[QNH] 导出成功（第${attempt}次尝试）`);
            return result;
        }
        
        // 失败，判断是否继续重试
        if (attempt < maxRetries) {
            console.warn(`[QNH] 导出失败，将重新尝试（${attempt}/${maxRetries}）`);
            await this._sleep(5000); // 等待5秒后重试
        } else {
            console.error(`[QNH] 导出失败，已达最大重试次数（${maxRetries}次）`);
        }
    }

    return null;
}
```

**关键特性**:
- ✅ 最多重试3次（可配置）
- ✅ 失败后等待5秒再重试（避免频繁请求）
- ✅ 任何一次成功立即返回
- ✅ 所有尝试失败后返回null

---

### 3. 实现分页接口回退方案

**修改文件**: `electron-app/core/sync-engine.js`

**修改位置**: `fullSync` 方法中的牵牛花商品获取逻辑

```javascript
// 步骤3: 导出牵牛花商品（支持重试）
const exportResult = await this.qnhClient.exportProducts(this.qnhStoreId, qnhPath, 3);

let qnhProducts = [];

if (exportResult) {
    // 导出成功，解析Excel
    this._log('info', `牵牛花商品导出完成: ${qnhPath}`);
    qnhProducts = QianniuhuaParser.parseExportExcel(qnhPath);
    this._log('info', `解析到 ${qnhProducts.length} 个牵牛花商品`);
} else {
    // 导出失败（3次重试后仍失败），使用分页接口作为回退方案
    this._log('warn', '⚠️ 牵牛花导出失败（已重试3次），切换到分页接口获取商品');
    this._updateProgress(30, '导出失败，使用分页接口...');
    
    // 使用分页接口获取商品映射
    const qnhMapping = await this.qnhClient.getProductsMapping(this.qnhStoreId, false);
    
    // 将映射转换为products格式（与Excel解析结果一致）
    qnhProducts = Object.entries(qnhMapping).map(([barcode, skuId]) => ({
        barcode: barcode,
        skuId: skuId,
        stock: 0 // 分页接口不返回库存，设为0
    }));
    
    this._log('info', `通过分页接口获取到 ${qnhProducts.length} 个牵牛花商品`);
}
```

**关键特性**:
- ✅ 导出成功：正常流程，解析Excel
- ✅ 导出失败：自动切换到分页接口
- ✅ 数据格式统一：回退方案返回与Excel解析相同的数据结构
- ✅ 用户友好：日志清晰提示切换原因

---

## 工作流程对比

### 修复前

```
1. 创建导出任务
2. 轮询任务状态
3. 发现"执行失败" → ❌ 继续轮询（无意义）
4. 持续轮询直到超时（5分钟）
5. 返回失败 → ❌ 无回退方案，同步失败
```

### 修复后

```
1. 创建导出任务（第1次尝试）
2. 轮询任务状态
3. 发现"执行失败" → ✅ 立即停止轮询
4. 等待5秒，创建新任务（第2次尝试）
5. 再次失败 → 等待5秒（第3次尝试）
6. 3次都失败 → ✅ 切换到分页接口
7. 使用分页接口获取商品映射
8. ✅ 同步继续进行
```

---

## 优势总结

### 1. **更快的失败检测**
- 识别到"执行失败"状态后立即停止轮询
- 不再浪费时间等待已失败的任务

### 2. **智能重试机制**
- 最多重试3次，每次间隔5秒
- 任何一次成功即可继续
- 大部分临时性问题可通过重试解决

### 3. **可靠的回退方案**
- 3次导出都失败后，自动使用分页接口
- 分页接口稳定性更高（逐页查询，不依赖异步任务）
- 保证同步流程不中断

### 4. **友好的日志输出**
```
[QNH] 导出商品 - 第1次尝试（共3次）
[QNH] 任务ID 41733561: 状态=执行失败
[QNH] 任务ID 41733561 失败，停止轮询
[QNH] 导出失败，将重新尝试（1/3）

[QNH] 导出商品 - 第2次尝试（共3次）
...

[QNH] 导出失败，已达最大重试次数（3次）
[SyncEngine] ⚠️ 牵牛花导出失败（已重试3次），切换到分页接口获取商品
[QNH] 使用分页接口获取商品映射...
[QNH] 门店 12345 共获取 523 个商品映射（通过分页）
[SyncEngine] 通过分页接口获取到 523 个牵牛花商品
```

---

## 性能对比

### 场景1：导出任务临时失败，第2次重试成功

| 指标 | 修复前 | 修复后 |
|-----|-------|-------|
| 检测失败时间 | 5分钟（超时） | 10秒（立即停止轮询） |
| 重试次数 | 0次（直接失败） | 2次尝试 |
| 总耗时 | 5分钟 + 手动重新同步 | ~30秒 |
| 用户体验 | ❌ 同步失败，需手动重试 | ✅ 自动成功 |

### 场景2：导出任务持续失败，切换到分页接口

| 指标 | 修复前 | 修复后 |
|-----|-------|-------|
| 检测失败时间 | 5分钟 × 1次 = 5分钟 | 10秒 × 3次 = 30秒 |
| 回退方案 | ❌ 无，同步失败 | ✅ 分页接口 |
| 分页查询时间 | - | ~2-5分钟（取决于商品数量） |
| 总耗时 | 5分钟（失败） | ~3-5.5分钟（成功） |
| 用户体验 | ❌ 同步失败，需排查问题 | ✅ 自动成功 |

---

## 测试建议

### 1. 正常场景测试
```bash
# 导出任务第1次就成功
✅ 验证正常流程不受影响
✅ 日志显示"第1次尝试"成功
```

### 2. 临时失败场景测试
```bash
# 模拟：第1次失败，第2次成功
✅ 验证重试机制生效
✅ 验证5秒延迟
✅ 验证日志清晰提示重试次数
```

### 3. 持续失败场景测试
```bash
# 模拟：3次导出都失败
✅ 验证停止重试（不超过3次）
✅ 验证自动切换到分页接口
✅ 验证分页接口能正常获取数据
✅ 验证同步流程继续执行
```

### 4. 边界情况测试
```bash
# 测试各种失败状态
✅ "执行失败" → 立即停止轮询
✅ "处理失败" → 立即停止轮询
✅ "已取消" → 立即停止轮询
✅ 超时 → 返回失败，触发重试
```

---

## 相关文件

| 文件 | 修改内容 |
|-----|---------|
| `electron-app/api/qnh-client.js` | ✅ 添加重试逻辑<br>✅ 识别"执行失败"状态<br>✅ 重构为`_exportProductsOnce` |
| `electron-app/core/sync-engine.js` | ✅ 检测导出失败<br>✅ 切换到分页接口回退方案 |

---

## 后续优化建议

1. **配置化重试次数**
   - 将重试次数和延迟时间添加到全局配置
   - 允许用户根据网络环境调整

2. **监控和告警**
   - 统计导出失败频率
   - 持续失败时发送通知给用户

3. **缓存优化**
   - 分页接口获取的数据可缓存
   - 下次导出失败时可直接使用缓存（如在时效内）

4. **导出任务调试**
   - 记录失败任务的详细错误信息
   - 帮助定位牵牛花平台的问题根源

---

## 总结

本次修复解决了牵牛花导出任务失败时的核心问题：

1. ✅ **快速失败检测** - 识别"执行失败"状态，立即停止无意义的轮询
2. ✅ **智能重试机制** - 最多3次重试，解决临时性问题
3. ✅ **可靠回退方案** - 分页接口确保数据获取不中断
4. ✅ **友好用户体验** - 自动化处理，清晰日志，减少人工干预

从"导出失败→同步中断"变为"导出失败→自动重试→回退到分页→同步成功"，极大提升了系统的健壮性和可用性。

---

**修复完成时间**: 2025-10-15  
**修复者**: AI Assistant (Claude Sonnet 4.5)  
**测试状态**: ✅ 代码审查通过，无linter错误，待功能测试

