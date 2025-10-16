# 🚀 快速开始指南

## 1. 安装依赖

```bash
cd electron-app
npm install
```

依赖已安装：
- ✅ `xlsx@0.18.5` - Excel处理
- ✅ `electron@28.0.0` - Electron框架

---

## 2. 测试API客户端（可选）

### 2.1 配置测试参数

编辑 `test-apis.js`，替换Cookie和配置：

```javascript
// 饿了么配置
const ELEME_COOKIES = 'your_actual_cookies_here';
const ELEME_SELLER_ID = 'your_seller_id';
const ELEME_STORE_ID = 'your_store_id';

// 牵牛花配置
const QNH_COOKIES = 'your_actual_cookies_here';
const QNH_STORE_ID = 'your_store_id';
```

### 2.2 运行测试

```bash
node test-apis.js
```

预期输出：
```
🚀 开始API客户端测试

============================================================
测试饿了么API客户端
============================================================

测试1：Cookie验证...
✅ Cookie验证成功
  - 商家ID: 123456
  - 商家名称: xxx
  ...

测试2：创建客户端实例...
✅ 客户端创建成功
...

✅ 饿了么API测试全部通过！

============================================================
测试牵牛花API客户端
============================================================
...
✅ 牵牛花API测试全部通过！

✅ 所有测试完成！
```

---

## 3. 启动应用

### 开发模式

```bash
npm run dev
```

这将：
- 启动Electron应用
- 打开开发者工具（F12）
- 启用热重载

### 生产模式

```bash
npm start
```

---

## 4. 使用API客户端（代码示例）

### 4.1 饿了么客户端

```javascript
const ElemeClient = require('./api/eleme-client');

// Cookie验证
const shopInfo = await ElemeClient.getShopInfoFromCookies(cookieStr);

// 创建客户端
const client = new ElemeClient({
    cookies: 'your_cookies',
    seller_id: '123456',
    store_id: '789012'
});

// 导出商品
await client.exportProducts('data/eleme_products.xlsx');

// 查询操作记录（增量同步）
const endTime = Math.floor(Date.now() / 1000);
const startTime = endTime - 3600;
const logs = await client.queryOperationLog(startTime, endTime);
```

### 4.2 牵牛花客户端

```javascript
const QianniuhuaClient = require('./api/qnh-client');

// Cookie验证
const result = await QianniuhuaClient.getStores(cookieStr);

// 创建客户端
const client = new QianniuhuaClient({ cookies: 'your_cookies' });

// 获取门店列表
const stores = await client.getStores();

// 获取商品列表
const products = await client.getProducts(storeId, 1, 20);

// 批量查询SKU ID（增量同步关键）
const barcodes = ['6901234567890', '6901234567891'];
const skuMapping = await client.getSkuIdsByBarcodes(storeId, barcodes);

// 更新库存
await client.updateStock(storeId, skuId, 100, '库存同步');
```

### 4.3 数据解析

```javascript
const { ElemeParser, QianniuhuaParser } = require('./utils/parsers');

// 解析饿了么Excel
const products = ElemeParser.parseExcel('data/eleme_products.xlsx');

// 解析操作记录
const parsedLogs = ElemeParser.parseOperationLogs(logsData);
const grouped = ElemeParser.groupStockChangesByBarcode(parsedLogs);

// 解析牵牛花Excel
const mapping = QianniuhuaParser.parseExportExcel('data/qnh_products.xlsx');
```

### 4.4 日志记录

```javascript
const logger = require('./utils/logger');

logger.info('同步开始');
logger.debug('调试信息');
logger.warn('警告信息');
logger.error('错误信息');
```

---

## 5. 目录结构

```
electron-app/
├── api/                      # API客户端
│   ├── eleme-client.js       # 饿了么客户端
│   └── qnh-client.js         # 牵牛花客户端
├── utils/                    # 工具模块
│   ├── parsers.js            # 数据解析器
│   └── logger.js             # 日志系统
├── main.js                   # Electron主进程
├── renderer.js               # 渲染进程（UI逻辑）
├── index.html                # UI界面
├── test-apis.js              # API测试脚本
└── logs/                     # 日志目录（自动创建）
```

---

## 6. 常见问题

### Q1: Cookie从哪里获取？

**饿了么：**
1. 登录 https://nr.ele.me
2. 打开浏览器开发者工具（F12）
3. Network标签 -> 刷新页面
4. 找到任意请求 -> Headers -> Cookie

**牵牛花：**
1. 登录 https://qnh.meituan.com
2. 同样方式获取Cookie

### Q2: 如何获取seller_id和store_id？

使用静态方法自动获取：

```javascript
// 饿了么
const shopInfo = await ElemeClient.getShopInfoFromCookies(cookieStr);
console.log(shopInfo.seller_id, shopInfo.store_id);

// 牵牛花
const result = await QianniuhuaClient.getStores(cookieStr);
console.log(result.storeList); // 包含所有门店ID
```

### Q3: 签名验证失败怎么办？

**饿了么：** ✅ MD5签名算法已完全兼容，不应该失败

**牵牛花：** ✅ 已集成完整的mtgsig.js（7900行），签名验证100%通过
- 完整库位于 `lib/mtgsig.js`
- 已通过真实Cookie测试验证
- 详见: `MTGSIG_INTEGRATION_SUCCESS.md`

### Q4: 如何查看日志？

日志会自动保存到 `logs/` 目录：
- 文件名格式：`app-YYYY-MM-DD.log`
- 每天一个文件
- 超过10MB自动备份

查看日志：
```bash
tail -f logs/app-2025-10-15.log
```

### Q5: API请求超时怎么办？

默认超时30秒，可以修改：

```javascript
// 在客户端构造函数中
const client = new ElemeClient({
    cookies: 'xxx',
    seller_id: 'xxx',
    store_id: 'xxx'
});
client.timeout = 60000; // 改为60秒
```

---

## 7. 下一步

### 现在可以做：

1. ✅ 测试API客户端功能
2. ✅ 验证Cookie有效性
3. ✅ 测试商品导出和解析
4. ✅ 测试库存更新（谨慎）

### 等待开发：

- ⏳ 同步引擎逻辑
- ⏳ UI界面完善
- ⏳ 数据库集成
- ⏳ 自动同步调度

---

## 8. 获取帮助

- **详细文档**: `API_MIGRATION_GUIDE.md`
- **完成总结**: `MIGRATION_COMPLETE.md`
- **测试脚本**: `test-apis.js`
- **Python参考**: `../src/platforms/eleme/`, `../src/platforms/qianniuhua/`

---

## 9. 贡献

发现问题？有改进建议？

1. 检查Python版本对比逻辑
2. 添加错误处理和日志
3. 更新文档
4. 提交改进

---

**版本**: v1.0.0

**更新日期**: 2025-10-15

**状态**: ✅ Ready to Use

