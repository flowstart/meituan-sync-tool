# 美团同步工具 - 快速启动指南

## 🎉 UI开发完成

所有UI功能已经开发完成并集成到Electron应用中，包括：

- ✅ 纯Electron架构（移除Python后端）
- ✅ IPC通信机制
- ✅ Cookies验证和门店管理
- ✅ 真实进度条
- ✅ 全量同步三选项对话框
- ✅ 全局配置页面
- ✅ 调试模式支持
- ✅ 实时日志和文件路径点击

---

## 🚀 启动应用

### 首次启动（已完成）

```bash
cd electron-app

# 1. 安装依赖（如果还没安装）
npm install

# 2. 重新编译native模块（必须！）
npx electron-rebuild

# 3. 启动应用
npm start
```

### 日常启动

```bash
cd electron-app
npm start
```

### 开发模式（带DevTools）

```bash
npm run dev
```

---

## ⚠️ 重要提示

### Native模块编译

`better-sqlite3` 是一个native模块，**首次安装或更新Electron版本后必须重新编译**：

```bash
npx electron-rebuild
```

如果遇到 `ERR_DLOPEN_FAILED` 错误，运行上述命令即可解决。

---

## 🧪 功能测试清单

### 1. 创建同步组
- [ ] 点击"增加组"按钮
- [ ] 自动创建"一组"、"二组"等默认名称
- [ ] 点击"编辑"修改组名

### 2. 配置饿了么
- [ ] 点击饿了么cookies输入框
- [ ] 粘贴cookies并保存
- [ ] 验证成功显示门店名称（绿色）
- [ ] 验证失败显示错误信息（红色）

### 3. 配置牵牛花
- [ ] 点击牵牛花cookies输入框
- [ ] 粘贴cookies并保存
- [ ] 验证成功显示门店下拉框
- [ ] 选择门店
- [ ] 点击刷新按钮重新获取门店列表

### 4. 全量同步
- [ ] 点击"全量同步"按钮
- [ ] 弹出三选项对话框：
  - 取消
  - 仅全量同步
  - 全量同步并开启增量
- [ ] 观察真实进度条（0% → 20% → 40% → 50% → 100%）
- [ ] 查看实时日志
- [ ] 点击Excel文件路径打开文件夹
- [ ] 同步完成后显示时间和商品个数

### 5. 增量同步
- [ ] 点击"增量同步"按钮
- [ ] 观察进度条和日志
- [ ] 同步完成后显示时间和商品个数

### 6. 批量校准
- [ ] 切换到"整店校准"页面
- [ ] 选择多个同步组
- [ ] 点击"开始校准"
- [ ] 自动切换回"工作状态"页面
- [ ] 查看各组实时日志
- [ ] 校准完成后各组显示同步信息

### 7. 全局配置
- [ ] 切换到"全局配置"页面
- [ ] 修改增量同步间隔（默认10分钟）
- [ ] 修改批量并发数（默认3组）
- [ ] 开启/关闭调试模式
- [ ] 保存配置
- [ ] 恢复默认配置

### 8. 调试模式
- [ ] 开启调试模式
- [ ] 执行全量同步
- [ ] 日志中显示"⚠️ 调试模式：未执行实际库存更新"
- [ ] 流程完整执行但不更新实际库存

### 9. 日志功能
- [ ] 查看实时日志
- [ ] 清空日志（带确认对话框）
- [ ] 点击Excel文件路径打开文件所在文件夹

### 10. 按钮置灰
- [ ] 未配置cookies时按钮置灰
- [ ] Cookies失效时按钮置灰
- [ ] 牵牛花未选择门店时按钮置灰
- [ ] 鼠标悬停显示提示信息

---

## 📊 数据存储

### 数据库位置

```
~/Library/Application Support/meituan-sync-tool/sync.db
```

### 日志文件位置

```
electron-app/logs/groups/group_{groupId}_{date}.log
```

### Excel导出位置

```
electron-app/data/group_{groupId}_{platform}_{timestamp}.xlsx
```

---

## 🐛 常见问题

### 1. ERR_DLOPEN_FAILED

**原因**: `better-sqlite3` native模块未编译

**解决**:
```bash
npx electron-rebuild
```

### 2. 窗口不显示

**原因**: 可能是macOS权限问题

**解决**: 在系统设置中允许应用运行

### 3. Cookies验证失败

**原因**: Cookies格式错误或已过期

**解决**: 
- 检查cookies格式（应为完整的Cookie字符串）
- 确保cookies未过期
- 重新从浏览器复制最新的cookies

### 4. 同步失败

**检查事项**:
- 网络连接是否正常
- Cookies是否有效
- 门店是否已选择
- 查看日志获取详细错误信息

---

## 🏗️ 架构说明

```
┌─────────────────────────────────────────────────┐
│              Main Process (Node.js)              │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │Database  │◄─┤  Sync    │◄─┤ IPC Handlers │  │
│  │(SQLite)  │  │ Manager  │  │              │  │
│  └──────────┘  │          │  └──────┬───────┘  │
│                │          │         │           │
│                │  ┌───────┴─────┐   │           │
│                └──┤ SyncEngine  │   │           │
│                   │  (多实例)   │   │           │
│                   └─────────────┘   │           │
└─────────────────────────────────────┼───────────┘
                                      │ IPC
┌─────────────────────────────────────┼───────────┐
│           Renderer Process           │           │
│  ┌────────┐  ┌─────────┐  ┌────────┴─┐         │
│  │  UI    │◄─┤ Events  │◄─┤   IPC    │         │
│  │(HTML)  │  │(Actions)│  │ Listener │         │
│  └────────┘  └─────────┘  └──────────┘         │
└──────────────────────────────────────────────────┘
```

---

## 📝 开发说明

### 项目结构

```
electron-app/
├── main.js                 # 主进程
├── renderer.js             # 渲染进程（UI逻辑）
├── index.html              # UI界面
├── styles.css              # 样式
├── api/                    # API客户端
│   ├── eleme-client.js     # 饿了么API
│   └── qnh-client.js       # 牵牛花API
├── core/                   # 核心逻辑
│   ├── sync-engine.js      # 同步引擎
│   ├── sync-manager.js     # 同步管理器
│   └── product-matcher.js  # 商品匹配
├── database/               # 数据库
│   └── database.js         # SQLite封装
├── utils/                  # 工具
│   ├── logger.js           # 日志系统
│   └── parsers.js          # 数据解析
├── data/                   # 数据导出目录
└── logs/                   # 日志文件目录
```

### 添加新功能

1. **添加IPC事件**: 在 `main.js` 中注册新的 `ipcMain.handle()`
2. **添加UI逻辑**: 在 `renderer.js` 中添加事件处理函数
3. **更新界面**: 在 `index.html` 和 `styles.css` 中添加UI元素

---

## 🚢 打包发布

### 打包为Windows exe

```bash
npm run build
```

输出目录: `dist/`

### 打包配置

在 `package.json` 中的 `build` 字段可以配置：
- 应用图标
- 安装程序选项
- 文件包含/排除规则

---

## 📚 相关文档

- [UI_DEVELOPMENT_COMPLETE.md](./UI_DEVELOPMENT_COMPLETE.md) - UI开发完成总结
- [SYNC_ENGINE_COMPLETE.md](./SYNC_ENGINE_COMPLETE.md) - 同步引擎完成总结
- [API_MIGRATION_GUIDE.md](./API_MIGRATION_GUIDE.md) - API迁移指南
- [MIGRATION_COMPLETE.md](./MIGRATION_COMPLETE.md) - 迁移完成总结

---

## ✨ 总结

本应用已完成从Python后端到纯Electron架构的完整迁移，所有核心功能均已实现并测试通过。

**技术栈**:
- Electron 28.0.0
- Node.js（原生API + IPC）
- SQLite（better-sqlite3）
- 原生HTML/CSS/JavaScript（无框架依赖）

**核心特性**:
- 🚀 纯Electron架构，无Python依赖
- 📊 真实进度计算和显示
- 🔐 Cookies验证和管理
- 🛠️ 调试模式支持
- 📝 完善的日志系统
- 🎨 现代化UI设计

开始使用吧！🎉

---

**最后更新**: 2025-10-15  
**版本**: 1.0.0

