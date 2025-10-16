# 修复：新增组按钮置灰状态

## 问题描述

用户反馈：新增组在没有配置cookies时，"增量同步"和"全量同步"按钮应该是置灰（禁用）状态。

## 问题原因

在`renderer.js`的`renderGroups()`函数中，同步按钮没有根据组的配置状态动态设置`disabled`属性。

## 解决方案

### 1. 添加`canSync()`辅助函数

```javascript
/**
 * 检查组是否可以同步
 * @param {Object} group - 组对象
 * @returns {boolean} 是否可以同步
 */
function canSync(group) {
    // 检查饿了么cookies是否配置
    const hasElemeCookies = group.eleme_cookies && group.eleme_cookies.trim() !== '';
    
    // 检查牵牛花cookies是否配置
    const hasQnhCookies = group.qnh_cookies && group.qnh_cookies.trim() !== '';
    
    // 检查牵牛花门店是否选择
    const hasQnhStore = group.qnh_store_id && group.qnh_store_id.trim() !== '';
    
    // 只有三个条件都满足才可以同步
    return hasElemeCookies && hasQnhCookies && hasQnhStore;
}
```

### 2. 更新同步按钮HTML

在`renderGroups()`函数中，为同步按钮添加动态`disabled`属性：

```html
<button class="action-btn primary" 
        onclick="startIncrementalSync(${group.id})"
        ${!canSync(group) ? 'disabled title="请先完成饿了么Cookie、牵牛花Cookie和门店配置"' : ''}>
    ▶️ 增量同步
</button>

<button class="action-btn success" 
        onclick="startFullSync(${group.id})"
        ${!canSync(group) ? 'disabled title="请先完成饿了么Cookie、牵牛花Cookie和门店配置"' : ''}>
    🔄 全量同步
</button>
```

### 3. 增强CSS禁用样式

在`styles.css`中优化`:disabled`状态的视觉效果：

```css
.action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    background: #f5f5f5 !important;
    color: #bfbfbf !important;
    border-color: #d9d9d9 !important;
}

.action-btn:disabled:hover {
    background: #f5f5f5 !important;
    color: #bfbfbf !important;
    border-color: #d9d9d9 !important;
}
```

## 置灰条件

按钮将在以下情况下被禁用：

1. ❌ 饿了么cookies未配置或为空
2. ❌ 牵牛花cookies未配置或为空
3. ❌ 牵牛花门店未选择

只有当**三个条件都满足**时，按钮才会启用。

## 用户体验改进

1. **视觉反馈**: 禁用按钮显示为灰色，透明度降低至40%
2. **鼠标提示**: 悬停在禁用按钮上时显示提示信息
3. **防止误操作**: 禁用状态下按钮无法点击
4. **明确原因**: 提示信息清晰说明需要完成哪些配置

## 测试场景

### 场景1：新建空组
- 操作：点击"➕ 新增组"
- 预期：两个同步按钮均为禁用状态
- 提示：悬停显示"请先完成饿了么Cookie、牵牛花Cookie和门店配置"

### 场景2：仅配置饿了么
- 操作：配置饿了么cookies并验证成功
- 预期：两个同步按钮仍为禁用状态
- 原因：牵牛花cookies和门店未配置

### 场景3：配置饿了么和牵牛花，但未选门店
- 操作：配置两个平台的cookies
- 预期：两个同步按钮仍为禁用状态
- 原因：牵牛花门店未选择

### 场景4：完成所有配置
- 操作：配置cookies并选择门店
- 预期：两个同步按钮恢复正常可点击状态
- 效果：按钮颜色恢复，可以正常执行同步

## 修改文件清单

- ✅ `electron-app/renderer.js` - 添加`canSync()`函数和按钮disabled属性
- ✅ `electron-app/styles.css` - 增强`.action-btn:disabled`样式

## 状态

✅ **已修复并测试通过**

---

**修复时间**: 2025-10-15  
**修复者**: AI Assistant  
**验证者**: 用户反馈

