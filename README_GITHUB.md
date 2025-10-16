# 美团同步工具 (Meituan Sync Tool)

饿了么到牵牛花库存同步桌面应用

## 功能特性

- ✅ 全量同步：从饿了么导出商品，同步到牵牛花
- ✅ 增量同步：根据操作记录增量更新库存
- ✅ 多组配置：支持多个门店独立配置
- ✅ 自动同步：支持定时自动增量同步
- ✅ 调试模式：测试同步流程不实际更新库存

## 技术栈

- Electron 28.0
- Node.js
- Better-SQLite3
- XLSX

## 安装

### 从源码运行

```bash
npm install
npm start
```

### 开发模式

```bash
npm run dev
```

### 打包

```bash
npm run build
```

## 自动化构建

本项目使用 GitHub Actions 自动构建 Windows 和 macOS 版本。

每次推送到 main 分支时，会自动触发构建，生成可执行文件。

## License

MIT

