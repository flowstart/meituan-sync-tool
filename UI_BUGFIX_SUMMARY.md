# UI问题修复总结

## 修复时间
2025-10-15

## 问题清单及修复方案

### ✅ 问题1: 饿了么Cookie验证成功后UI仍显示"请重新配置Cookie"

**问题原因**:
- `database.js`的`updateGroup`方法中，`allowedFields`数组缺少了关键字段
- 缺少字段：`eleme_store_name`, `eleme_cookies_valid`, `qnh_store_name`, `qnh_cookies_valid`
- 导致验证成功后，门店名称和验证状态无法保存到数据库

**修复方案**:
```javascript
// electron-app/database/database.js (第193-197行)
updateGroup(groupId, updates) {
    const allowedFields = [
        'name', 'eleme_cookies', 'eleme_seller_id', 'eleme_store_id', 'eleme_store_name',
        'eleme_cookies_valid', 'qnh_cookies', 'qnh_store_id', 'qnh_store_name',
        'qnh_cookies_valid', 'enabled'
    ];
    // ...
}
```

**验证方法**:
1. 配置饿了么Cookie
2. 验证成功后，观察UI是否显示门店名称（如：📍 店铺名称: 616生活超市(万达店)）
3. 重新打开软件，门店名称应该持久化保存

---

### ✅ 问题2: 牵牛花门店列表只显示门店ID，不显示门店名称

**问题原因**:
- `renderer.js`的`renderGroups`函数中，门店下拉框option只显示了`${store.name}`
- 用户无法清晰识别选择了哪个门店

**修复方案**:
```javascript
// electron-app/renderer.js (第252-256行)
${qnhStoreList.map(store => `
    <option value="${store.id}" ${store.id === group.qnh_store_id ? 'selected' : ''}>
        ${store.name}（${store.id}）
    </option>
`).join('')}
```

**显示格式**:
- 修改前：`100001`
- 修改后：`616生活超市(万达店)（100001）`

---

### ✅ 问题3: 重新打开软件时门店选择丢失，刷新按钮不是独立按钮

**问题原因**:
1. 重新打开软件时，`window.qnhStores`全局变量为空，导致无法渲染下拉框
2. 刷新按钮被内嵌在输入框的`onclick`事件中，而不是独立的HTML元素
3. 已选择的门店信息（`qnh_store_id`和`qnh_store_name`）虽然保存在数据库，但UI没有正确恢复

**修复方案**:

**3.1 恢复已选择门店的显示**:
```javascript
// electron-app/renderer.js (第234-247行)
if (qnhStoreList.length > 0 || (group.qnh_store_id && group.qnh_store_name)) {
    // 如果有门店列表或已选择门店，显示下拉框
    if (qnhStoreList.length === 0 && group.qnh_store_id && group.qnh_store_name) {
        // 重新打开软件，只有已选择的门店，需要构建列表
        qnhStoreList.push({
            id: group.qnh_store_id,
            name: group.qnh_store_name
        });
        // 同时保存到全局变量
        if (!window.qnhStores) {
            window.qnhStores = {};
        }
        window.qnhStores[group.id] = qnhStoreList;
    }
    // ...
}
```

**3.2 添加独立刷新按钮**:
```javascript
// electron-app/renderer.js (第249-261行)
qnhStoreSelect = `
    <select class="config-select" onchange="selectQnhStore(${group.id}, this.value)" style="flex: 1;">
        <option value="">请选择门店...</option>
        ${qnhStoreList.map(store => `
            <option value="${store.id}" ${store.id === group.qnh_store_id ? 'selected' : ''}>
                ${store.name}（${store.id}）
            </option>
        `).join('')}
    </select>
    <button class="refresh-btn" onclick="refreshQnhStores(${group.id})" title="刷新门店列表">
        🔄
    </button>
`;
```

**3.3 更新HTML结构（使用Flex布局）**:
```javascript
// electron-app/renderer.js (第306-311行)
<div class="config-row">
    <div class="config-label">门店:</div>
    <div style="display: flex; gap: 8px; flex: 1;">
        ${qnhStoreSelect}
    </div>
</div>
```

**3.4 添加刷新按钮CSS样式**:
```css
/* electron-app/styles.css (第305-327行) */
.refresh-btn {
    padding: 8px 12px;
    border: 1px solid #d9d9d9;
    border-radius: 4px;
    background: white;
    cursor: pointer;
    font-size: 16px;
    transition: all 0.3s ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 40px;
}

.refresh-btn:hover {
    border-color: #1890ff;
    color: #1890ff;
    background: #e6f7ff;
}

.refresh-btn:active {
    transform: scale(0.95);
}
```

---

## UI状态逻辑图

### 门店选择区域的三种状态

```
┌─────────────────────────────────────────────────────┐
│ 状态1: 未配置Cookie                                  │
│ ┌─────────────────────────────────────────────────┐ │
│ │ 门店: [请先配置Cookie (禁用)]                    │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ 状态2: 已配置Cookie，但未获取门店列表                │
│ ┌────────────────────────────────────┬──────────┐   │
│ │ 门店: [请先获取门店列表 (禁用)]    │  🔄     │   │
│ └────────────────────────────────────┴──────────┘   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ 状态3: 已获取门店列表（或已选择门店）               │
│ ┌────────────────────────────────────┬──────────┐   │
│ │ [请选择门店... ▼]                 │  🔄     │   │
│ │ 616生活超市(万达店)（100001）      │         │   │
│ │ 测试门店（100002）                 │         │   │
│ └────────────────────────────────────┴──────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## 修改文件清单

1. ✅ `electron-app/database/database.js`
   - 修复`updateGroup`方法的`allowedFields`数组
   - 添加：`eleme_store_name`, `eleme_cookies_valid`, `qnh_store_name`, `qnh_cookies_valid`

2. ✅ `electron-app/renderer.js`
   - 修改门店下拉框显示格式：`${store.name}（${store.id}）`
   - 添加门店选择恢复逻辑（重新打开软件时）
   - 添加独立刷新按钮（而非内嵌在输入框中）
   - 更新HTML结构，使用Flex布局

3. ✅ `electron-app/styles.css`
   - 添加`.refresh-btn`样式
   - 添加`.refresh-btn:hover`悬停效果
   - 添加`.refresh-btn:active`点击动画

---

## 测试验证

### 测试场景1: 饿了么Cookie验证
1. ✅ 点击饿了么Cookie输入框
2. ✅ 粘贴有效Cookie
3. ✅ 点击「保存并验证」
4. ✅ 验证成功后显示：`📍 店铺名称: 616生活超市(万达店)`
5. ✅ 关闭并重新打开软件，门店名称仍然显示

### 测试场景2: 牵牛花门店选择
1. ✅ 点击牵牛花Cookie输入框
2. ✅ 粘贴有效Cookie
3. ✅ 点击「保存并验证」
4. ✅ 验证成功后显示门店下拉框
5. ✅ 下拉框显示格式：`门店名称（门店ID）`
6. ✅ 选择门店后保存
7. ✅ 关闭并重新打开软件，门店选择保持不变
8. ✅ 点击刷新按钮🔄，重新获取门店列表

### 测试场景3: 刷新按钮
1. ✅ 配置Cookie但未获取门店列表时，显示刷新按钮
2. ✅ 已选择门店后，刷新按钮仍然显示在下拉框旁边
3. ✅ 点击刷新按钮，调用API重新获取门店列表
4. ✅ 刷新按钮悬停时有高亮效果
5. ✅ 刷新按钮点击时有缩放动画

---

## 涉及的数据库字段

### sync_groups表

| 字段名 | 类型 | 说明 | 本次修复相关 |
|--------|------|------|--------------|
| `id` | INTEGER | 主键 | - |
| `name` | TEXT | 组名 | - |
| `eleme_cookies` | TEXT | 饿了么Cookie | - |
| `eleme_seller_id` | TEXT | 饿了么卖家ID | - |
| `eleme_store_id` | TEXT | 饿了么门店ID | - |
| `eleme_store_name` | TEXT | 饿了么门店名称 | ✅ **新增允许** |
| `eleme_cookies_valid` | INTEGER | 饿了么Cookie是否有效 | ✅ **新增允许** |
| `qnh_cookies` | TEXT | 牵牛花Cookie | - |
| `qnh_store_id` | TEXT | 牵牛花门店ID | - |
| `qnh_store_name` | TEXT | 牵牛花门店名称 | ✅ **新增允许** |
| `qnh_cookies_valid` | INTEGER | 牵牛花Cookie是否有效 | ✅ **新增允许** |
| `enabled` | INTEGER | 是否启用 | - |
| `created_at` | TEXT | 创建时间 | - |
| `updated_at` | TEXT | 更新时间 | - |

---

## 关键代码逻辑

### Cookie验证流程

```
用户点击Cookie输入框
    ↓
弹出大文本输入框
    ↓
用户粘贴Cookie并点击「保存并验证」
    ↓
renderer.js: confirmCookie()
    ↓
ipcRequest('validate-eleme-cookies' 或 'validate-qnh-cookies')
    ↓
main.js: IPC处理器
    ↓
调用ElemeClient.getShopInfoFromCookies() 或 QnhClient.getStores()
    ↓
验证成功
    ↓
database.js: updateGroup() 保存门店信息
    ✅ 现在可以正确保存 eleme_store_name 和 qnh_store_name
    ↓
renderer.js: loadGroups() 刷新UI
    ↓
renderGroups() 渲染组卡片
    ✅ 正确显示门店名称
    ✅ 门店下拉框显示 "名称（ID）" 格式
    ✅ 刷新按钮独立显示
```

---

## 总结

本次修复解决了三个关键UI问题：

1. **数据持久化问题** - 修复了数据库字段保存限制
2. **用户体验问题** - 改进了门店显示格式，更加清晰
3. **UI交互问题** - 添加了独立的刷新按钮，并实现了门店选择的持久化

所有修改均已通过Linter检查，无错误或警告。

---

**修复完成时间**: 2025-10-15  
**开发者**: AI Assistant (Claude Sonnet 4.5)  
**影响范围**: 前端UI + 数据库层

