# 数据库迁移和用户体验修复总结

## 修复时间
2025-10-15

---

## 问题1: 数据库表缺少字段

### 错误现象
```
❌ Cookie验证失败：no such column: eleme_store_name
❌ 获取门店列表失败：no such column: qnh_cookies_valid
```

### 根本原因
数据库表`sync_groups`在初始创建时缺少了以下4个字段：
- `eleme_store_name` - 饿了么门店名称
- `eleme_cookies_valid` - 饿了么Cookie有效性标志
- `qnh_store_name` - 牵牛花门店名称
- `qnh_cookies_valid` - 牵牛花Cookie有效性标志

### 修复方案：数据库自动迁移

实现了智能数据库迁移机制，自动检测并添加缺失的列，确保向后兼容。

#### 1. 添加迁移方法 `_migrateDatabase()`

```javascript
// electron-app/database/database.js
_migrateDatabase() {
    console.log('[Database] 开始数据库迁移检查...');
    
    try {
        // 检查 sync_groups 表的列
        const tableInfo = this.db.prepare("PRAGMA table_info(sync_groups)").all();
        const existingColumns = new Set(tableInfo.map(col => col.name));
        
        // 需要添加的列
        const columnsToAdd = [
            { name: 'eleme_store_name', type: 'TEXT' },
            { name: 'eleme_cookies_valid', type: 'INTEGER DEFAULT 0' },
            { name: 'qnh_store_name', type: 'TEXT' },
            { name: 'qnh_cookies_valid', type: 'INTEGER DEFAULT 0' }
        ];
        
        // 添加缺失的列
        for (const column of columnsToAdd) {
            if (!existingColumns.has(column.name)) {
                const sql = `ALTER TABLE sync_groups ADD COLUMN ${column.name} ${column.type}`;
                this.db.exec(sql);
                console.log(`[Database] ✅ 添加列: ${column.name}`);
            } else {
                console.log(`[Database] ⏭️  列已存在: ${column.name}`);
            }
        }
        
        console.log('[Database] 数据库迁移完成');
    } catch (error) {
        console.error('[Database] 数据库迁移失败:', error);
    }
}
```

#### 2. 在初始化时自动执行迁移

```javascript
// electron-app/database/database.js (第116-117行)
// 6. 数据库迁移：添加缺失的列（向后兼容）
this._migrateDatabase();
```

### 迁移特性

✅ **自动检测** - 使用SQLite的`PRAGMA table_info()`检测现有列  
✅ **安全添加** - 只添加不存在的列，不影响已有列  
✅ **向后兼容** - 旧数据库自动升级，新数据库跳过迁移  
✅ **错误容错** - 迁移失败不影响其他功能  
✅ **日志完整** - 每个步骤都有清晰的日志输出

### 控制台输出示例

**首次运行（需要迁移）**:
```
[Database] 开始数据库迁移检查...
[Database] ✅ 添加列: eleme_store_name
[Database] ✅ 添加列: eleme_cookies_valid
[Database] ✅ 添加列: qnh_store_name
[Database] ✅ 添加列: qnh_cookies_valid
[Database] 数据库迁移完成
```

**后续运行（列已存在）**:
```
[Database] 开始数据库迁移检查...
[Database] ⏭️  列已存在: eleme_store_name
[Database] ⏭️  列已存在: eleme_cookies_valid
[Database] ⏭️  列已存在: qnh_store_name
[Database] ⏭️  列已存在: qnh_cookies_valid
[Database] 数据库迁移完成
```

---

## 问题2: 错误提示不准确

### 问题描述
所有验证失败都显示"请检查Cookie是否正确或已过期"，即使是数据库错误或网络错误，具有误导性。

### 修复方案：智能错误提示

只有真正的认证问题才显示"请检查Cookie是否正确或已过期"。

#### 判断逻辑

```javascript
// electron-app/renderer.js
if (!result.success) {
    // 根据错误类型显示不同提示
    let errorMsg = `❌ Cookie验证失败：${result.error}`;
    
    // 只有认证相关错误才添加Cookie提示
    if (result.error && (
        result.error.includes('401') || 
        result.error.includes('403') || 
        result.error.includes('token') || 
        result.error.includes('登录')
    )) {
        errorMsg += '\n\n请检查Cookie是否正确或已过期。';
    }
    
    alert(errorMsg);
    return;
}
```

### 错误提示对比

#### 修复前（所有错误都一样）
```
❌ Cookie验证失败：no such column: eleme_store_name

请检查Cookie是否正确或已过期。
```

#### 修复后（根据错误类型）

**数据库错误**:
```
❌ Cookie验证失败：no such column: eleme_store_name
```

**认证错误（401/403）**:
```
❌ Cookie验证失败：Unauthorized

请检查Cookie是否正确或已过期。
```

**网络错误**:
```
❌ Cookie验证失败：Network request failed
```

**Token过期**:
```
❌ Cookie验证失败：Token expired

请检查Cookie是否正确或已过期。
```

---

## 问题3: 缺少Loading状态

### 问题描述
点击「保存并验证」或「刷新门店」按钮后，等待网络请求的过程中没有任何Loading提示，用户不知道是否在执行。

### 修复方案：按钮Loading状态

#### 1. Cookie验证按钮Loading

```javascript
// electron-app/renderer.js (第791-796行)
// 显示Loading状态
const saveBtn = document.querySelector('#cookieDialog .btn-primary');
const originalBtnText = saveBtn.textContent;
saveBtn.disabled = true;
saveBtn.textContent = '验证中...';
saveBtn.style.opacity = '0.6';
```

**状态变化**:
```
正常: [保存并验证] (可点击)
  ↓
加载: [验证中...] (禁用，半透明)
  ↓
成功: 关闭对话框
失败: [保存并验证] (恢复可点击)
```

#### 2. 刷新门店按钮Loading

```javascript
// electron-app/renderer.js (第915-922行)
// 显示Loading状态
const card = document.querySelector(`[data-group-id="${groupId}"]`);
const refreshBtn = card.querySelector('.refresh-btn');
if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '⏳';  // 沙漏图标
    refreshBtn.style.opacity = '0.6';
}
```

**状态变化**:
```
正常: [🔄] (可点击)
  ↓
加载: [⏳] (禁用，半透明)
  ↓
成功/失败: [🔄] (恢复可点击)
```

#### 3. 状态恢复机制

确保在所有情况下都恢复按钮状态：

```javascript
// 失败时恢复
if (!result.success) {
    alert(errorMsg);
    
    // 恢复按钮状态
    saveBtn.disabled = false;
    saveBtn.textContent = originalBtnText;
    saveBtn.style.opacity = '1';
    return;
}

// 异常时恢复
} catch (error) {
    alert(`❌ 操作失败：${error.message}`);
    
    // 恢复按钮状态
    saveBtn.disabled = false;
    saveBtn.textContent = originalBtnText;
    saveBtn.style.opacity = '1';
}
```

---

## 用户体验改进对比

### 修复前

| 操作 | 问题 |
|------|------|
| 点击「保存并验证」 | ❌ 无Loading提示，用户不知道是否在执行 |
| 数据库错误 | ❌ 误导提示"请检查Cookie是否正确或已过期" |
| 点击「刷新门店」 | ❌ 无Loading提示 |
| 验证失败 | ❌ 按钮保持禁用状态 |

### 修复后

| 操作 | 改进 |
|------|------|
| 点击「保存并验证」 | ✅ 显示"验证中..."，按钮禁用半透明 |
| 数据库错误 | ✅ 准确显示错误信息，不误导用户 |
| 认证错误 | ✅ 明确提示"请检查Cookie是否正确或已过期" |
| 点击「刷新门店」 | ✅ 显示⏳图标，按钮禁用半透明 |
| 验证失败 | ✅ 按钮自动恢复可点击状态 |
| 异常退出 | ✅ 按钮自动恢复可点击状态 |

---

## 修改文件清单

### 1. electron-app/database/database.js

**修改内容**:
- ✅ 添加`_migrateDatabase()`方法（第130-169行）
- ✅ 在`_initDatabase()`中调用迁移方法（第116-117行）

**新增功能**:
- 自动检测并添加缺失的数据库列
- 向后兼容旧版本数据库
- 完整的迁移日志输出

### 2. electron-app/renderer.js

**修改内容**:
- ✅ `confirmCookie()`函数（第782-868行）
  - 添加Loading状态（验证中...）
  - 智能错误提示（区分认证错误和其他错误）
  - 状态恢复机制

- ✅ `refreshQnhStores()`函数（第907-968行）
  - 添加Loading状态（⏳图标）
  - 智能错误提示
  - 状态恢复机制

---

## 测试验证

### 测试场景1: 数据库迁移
1. ✅ 删除旧数据库文件
2. ✅ 启动应用，观察控制台输出
3. ✅ 验证是否添加了4个新列
4. ✅ 重启应用，验证迁移不会重复执行

### 测试场景2: Cookie验证
1. ✅ 点击「保存并验证」，观察按钮变为"验证中..."
2. ✅ 验证成功后，对话框自动关闭
3. ✅ 验证失败（认证错误），显示Cookie提示
4. ✅ 验证失败（其他错误），不显示Cookie提示
5. ✅ 验证失败后，按钮恢复可点击状态

### 测试场景3: 刷新门店
1. ✅ 点击刷新按钮，观察图标变为⏳
2. ✅ 刷新成功后，按钮恢复为🔄
3. ✅ 刷新失败后，按钮恢复为🔄
4. ✅ 网络异常时，按钮也能正确恢复

---

## 关键代码片段

### SQLite列检测

```javascript
// 使用PRAGMA获取表结构
const tableInfo = this.db.prepare("PRAGMA table_info(sync_groups)").all();
// 输出示例:
// [
//   { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
//   { cid: 1, name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
//   ...
// ]

const existingColumns = new Set(tableInfo.map(col => col.name));
if (!existingColumns.has('eleme_store_name')) {
    // 列不存在，需要添加
}
```

### SQLite ALTER TABLE

```javascript
// 添加新列（SQLite语法）
ALTER TABLE sync_groups ADD COLUMN eleme_store_name TEXT
ALTER TABLE sync_groups ADD COLUMN eleme_cookies_valid INTEGER DEFAULT 0
```

### 认证错误检测

```javascript
// 检测常见的认证错误关键词
const isAuthError = error && (
    error.includes('401') ||      // HTTP 401 Unauthorized
    error.includes('403') ||      // HTTP 403 Forbidden
    error.includes('token') ||    // Token相关错误
    error.includes('登录')        // 登录失败
);
```

---

## 数据库字段说明

### sync_groups表（更新后）

| 字段名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `id` | INTEGER | - | 主键 |
| `name` | TEXT | - | 组名称 |
| `eleme_cookies` | TEXT | - | 饿了么Cookie |
| `eleme_seller_id` | TEXT | NULL | 饿了么卖家ID |
| `eleme_store_id` | TEXT | NULL | 饿了么门店ID |
| `eleme_store_name` | TEXT | NULL | 🆕 饿了么门店名称 |
| `eleme_cookies_valid` | INTEGER | 0 | 🆕 饿了么Cookie有效性 |
| `qnh_cookies` | TEXT | - | 牵牛花Cookie |
| `qnh_store_id` | TEXT | - | 牵牛花门店ID |
| `qnh_store_name` | TEXT | NULL | 🆕 牵牛花门店名称 |
| `qnh_cookies_valid` | INTEGER | 0 | 🆕 牵牛花Cookie有效性 |
| `enabled` | INTEGER | 1 | 是否启用 |
| `created_at` | TEXT | - | 创建时间 |
| `updated_at` | TEXT | - | 更新时间 |

---

## 未来扩展建议

### 1. 版本化迁移系统

```javascript
// 记录数据库版本
const DB_VERSION = 2;

_checkAndMigrate() {
    const currentVersion = this.db.prepare("PRAGMA user_version").get().user_version;
    
    if (currentVersion < 1) {
        this._migrateToV1();  // 添加store_name列
    }
    if (currentVersion < 2) {
        this._migrateToV2();  // 添加cookies_valid列
    }
    
    this.db.prepare(`PRAGMA user_version = ${DB_VERSION}`).run();
}
```

### 2. 迁移回滚机制

```javascript
_migrateWithRollback() {
    this.db.exec('BEGIN TRANSACTION');
    try {
        this._migrateDatabase();
        this.db.exec('COMMIT');
    } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
    }
}
```

### 3. 更友好的Loading UI

```javascript
// 使用Spinner组件替代简单文本
saveBtn.innerHTML = `
    <span class="spinner"></span>
    <span>验证中...</span>
`;
```

---

## 总结

本次修复解决了三个关键问题：

1. **数据库兼容性** - 实现了自动迁移机制，确保旧数据库平滑升级
2. **错误提示准确性** - 根据错误类型显示准确的提示信息，不误导用户
3. **用户体验** - 添加Loading状态，让用户清楚知道操作正在进行

所有修改均通过Linter检查，无错误或警告。

---

**修复完成时间**: 2025-10-15  
**开发者**: AI Assistant (Claude Sonnet 4.5)  
**影响范围**: 数据库层 + 前端UI

