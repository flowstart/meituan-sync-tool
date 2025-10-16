# 美团同步工具 - Electron版本

> 饿了么到牵牛花的库存自动同步系统

## 🎉 项目状态

**最新版本**: v2.0.0  
**完成度**: API迁移 ✅ 100% | 同步引擎 ✅ 100% | UI开发 ⏳ 待开始  
**最后更新**: 2025-10-15

---

## 📋 项目概述

本项目是一个完整的库存同步解决方案，支持从饿了么平台自动同步商品库存到美团牵牛花平台。

### 核心功能

- ✅ **全量同步**: 导出两个平台的商品Excel，比对库存差异，批量更新
- ✅ **增量同步**: 查询饿了么操作记录，解析库存变化，自动同步到牵牛花
- ✅ **多组管理**: 支持配置多个饿了么和牵牛花店铺组合
- ✅ **定时任务**: 自动定时执行增量同步，保持库存实时同步
- ✅ **日志隔离**: 每个组独立的日志文件和实时日志展示
- ✅ **批量优化**: 10个SKU一组批量更新，性能提升10倍

---

## 🏗️ 架构设计

```
┌─────────────────────────────────────────┐
│         UI 层 (Electron Renderer)        │
│   - 界面交互                              │
│   - 实时日志显示                          │
│   - IPC通信                              │
└──────────────────┬──────────────────────┘
                   │ IPC Events
┌──────────────────▼──────────────────────┐
│      Manager 层 (SyncManager)           │
│   - 多组调度                              │
│   - 并发控制 (3-5组)                      │
│   - 定时任务管理                          │
│   - 日志隔离 (文件+内存)                   │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│       Core 层 (SyncEngine)              │
│   - 单组全量同步                          │
│   - 单组增量同步                          │
│   - Excel比对                            │
│   - 批量更新 (10个SKU/批次)               │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────▼──────────────────────┐
│     Data 层 (Database + Matcher)        │
│   - SQLite数据库 (better-sqlite3)        │
│   - 商品匹配器                            │
│   - 数据持久化                            │
└─────────────────────────────────────────┘
```

---

## 📦 目录结构

```
electron-app/
├── api/                        # API客户端层
│   ├── eleme-client.js         # 饿了么API客户端 ✅
│   └── qnh-client.js           # 牵牛花API客户端 ✅
├── core/                       # 核心业务层
│   ├── product-matcher.js      # 商品匹配器 ✅
│   ├── sync-engine.js          # 同步引擎 ✅
│   └── sync-manager.js         # 同步管理器 ✅
├── database/                   # 数据层
│   └── database.js             # SQLite数据库 ✅
├── utils/                      # 工具层
│   ├── parsers.js              # 数据解析器 ✅
│   └── logger.js               # 日志工具 ✅
├── lib/                        # 第三方库
│   └── mtgsig.js               # 牵牛花签名算法 ✅
├── main.js                     # Electron主进程 ✅
├── renderer.js                 # Electron渲染进程 (待开发)
├── index.html                  # 主界面HTML (待开发)
├── styles.css                  # 样式文件 (待开发)
├── test-sync-complete.js       # 完整测试脚本 ✅
└── data/                       # 数据目录
    ├── sync.db                 # 生产数据库
    └── *.xlsx                  # Excel导出文件
```

---

## 🚀 快速开始

### 1. 安装依赖

```bash
cd electron-app
npm install
```

### 2. 配置

创建配置文件或通过UI界面添加组（开发中）：

```javascript
// 组配置示例
{
    name: '616生活超市(万达店)',
    elemeConfig: {
        cookies: 'your_eleme_cookies',
        seller_id: 'your_seller_id',
        store_id: 'your_store_id'
    },
    qnhConfig: {
        cookies: 'your_qnh_cookies',
        store_id: 'your_qnh_store_id'
    }
}
```

### 3. 运行测试

```bash
# 测试同步引擎（需要真实cookies）
node test-sync-complete.js

# 运行应用
npm start

# 开发模式（打开DevTools）
npm start -- --dev
```

---

## 📚 API使用示例

### Renderer进程中调用

```javascript
const { ipcRenderer } = require('electron');

// 1. 添加同步组
const result = await ipcRenderer.invoke('add-group', {
    name: '测试店铺',
    elemeConfig: { cookies: '...', seller_id: '...', store_id: '...' },
    qnhConfig: { cookies: '...', store_id: '...' }
});
const groupId = result.groupId;

// 2. 全量同步
await ipcRenderer.invoke('sync-group', {
    groupId: groupId,
    syncType: 'full'
});

// 3. 增量同步
await ipcRenderer.invoke('sync-group', {
    groupId: groupId,
    syncType: 'incremental',
    options: { timeRange: 3600 } // 1小时
});

// 4. 启动定时任务（每10分钟增量同步）
await ipcRenderer.invoke('start-scheduled-sync', {
    groupId: groupId,
    intervalMinutes: 10
});

// 5. 监听实时日志
ipcRenderer.on('sync-log', (event, logEntry) => {
    console.log(`[${logEntry.level}] ${logEntry.message}`);
});

// 6. 获取同步历史
const history = await ipcRenderer.invoke('get-sync-history', {
    groupId: groupId,
    limit: 20
});

// 7. 获取统计信息
const stats = await ipcRenderer.invoke('get-sync-stats', groupId);
```

---

## 🎯 核心功能

### 1. 全量同步

**流程**:
1. 导出饿了么商品Excel
2. 导出牵牛花商品Excel
3. 比对两个Excel，找出库存不一致的商品
4. 批量更新牵牛花库存（10个SKU一组）

**特点**:
- ✅ 只更新库存不一致的商品
- ✅ 批量更新，性能提升10倍
- ✅ 详细的操作日志

### 2. 增量同步

**流程**:
1. 查询饿了么操作记录（支持分页）
2. 解析库存变化
3. 根据条形码批量查询牵牛花SKU
4. 批量更新牵牛花库存

**特点**:
- ✅ 自动获取上次同步时间
- ✅ 支持分页查询操作记录
- ✅ 快速同步，适合定时任务

### 3. 多组管理

**功能**:
- 支持配置多个饿了么和牵牛花店铺组合
- 每个组独立管理、独立同步
- 支持多组并发同步（3-5组）
- 错峰启动，避免API限流

### 4. 定时任务

**功能**:
- 每个组独立定时任务
- 可配置同步间隔（默认10分钟）
- 自动执行增量同步
- 实时状态通知

---

## ⚡ 性能优化

### 批量更新优化

**对比**:
- 旧版（Python）: 100个商品 = 100次请求 = ~50秒
- 新版（JavaScript）: 100个商品 = 10次请求 = ~5秒
- **性能提升: 10倍！**

### 并发控制

- 多组同步最多3-5组并发
- 错峰启动：每组延时10秒
- 单组内串行执行保证数据一致性

### 延时策略

| 操作 | 延时 | 说明 |
|------|------|------|
| 批量更新间隔 | 500ms | 避免API限流 |
| 分页查询间隔 | 300ms | 避免频繁请求 |
| 错峰启动间隔 | 10秒 | 多组并发控制 |

---

## 📊 数据库设计

### 表结构

1. **sync_groups** - 同步组配置
   - 存储饿了么和牵牛花的配置信息

2. **sync_history** - 同步历史记录
   - 记录每次同步的时间、类型、结果

3. **product_mapping** - 商品映射关系
   - 存储饿了么条形码到牵牛花SKU的映射

4. **operation_log** - 操作日志
   - 详细记录每个商品的操作结果

5. **config** - 全局配置
   - 存储系统配置参数

---

## 🧪 测试

### 运行测试

```bash
# 完整测试（包含数据库、匹配器、同步引擎、同步管理器）
node test-sync-complete.js

# 语法检查
node -c database/database.js
node -c core/product-matcher.js
node -c core/sync-engine.js
node -c core/sync-manager.js
node -c main.js
```

### 测试结果

```
✅ 数据库模块测试通过（100%）
✅ 商品匹配器测试通过（75%匹配率）
✅ 同步管理器测试通过（定时任务、日志管理）
⚠️ 同步引擎需要真实cookies验证
```

---

## 📖 文档

- [SYNC_ENGINE_COMPLETE.md](./SYNC_ENGINE_COMPLETE.md) - 同步引擎完整报告
- [API_MIGRATION_GUIDE.md](./API_MIGRATION_GUIDE.md) - API迁移指南
- [BATCH_UPDATE_GUIDE.md](./BATCH_UPDATE_GUIDE.md) - 批量更新指南
- [MIGRATION_COMPLETE.md](./MIGRATION_COMPLETE.md) - 迁移完成总结
- [QUICK_START.md](./QUICK_START.md) - 快速开始指南

---

## 🔧 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Node.js | v14+ | JavaScript运行环境 |
| Electron | v27+ | 桌面应用框架 |
| better-sqlite3 | latest | SQLite数据库（同步API） |
| xlsx | ^0.18.5 | Excel文件处理 |
| winston | (utils) | 日志系统 |

---

## 🎯 下一步计划

### UI开发（高优先级）

- [ ] 组管理界面（添加/编辑/删除组）
- [ ] 同步控制界面（全量/增量同步按钮）
- [ ] 实时日志展示
- [ ] 同步历史记录查询
- [ ] 统计图表展示

### 功能增强（中优先级）

- [ ] 定时任务持久化（重启后自动恢复）
- [ ] 同步结果桌面通知
- [ ] 导出同步报告（Excel/PDF）
- [ ] 错误重试机制（失败自动重试）
- [ ] 数据备份和恢复

### 部署准备（低优先级）

- [ ] 应用图标和资源
- [ ] 打包配置（electron-builder）
- [ ] 自动更新机制
- [ ] 安装程序制作

---

## 🐛 已知问题

1. **定时任务持久化**: 应用重启后定时任务丢失，需手动重新启动
2. **日志文件管理**: 日志文件无限增长，需要实现自动清理
3. **错误重试**: 单次失败不会自动重试，需要手动重新执行

---

## 👥 贡献

欢迎提交Issue和Pull Request！

---

## 📄 许可证

MIT License

---

## 📧 联系方式

如有问题，请联系项目维护者。

---

**🎉 同步引擎迁移已完成！现在可以开始UI开发了。**
