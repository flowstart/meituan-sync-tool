/**
 * 数据库模块 - SQLite数据库管理
 * 使用 better-sqlite3 实现同步操作
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { toLocalISOString } = require('../utils/time-utils');

class SyncDatabase {
    /**
     * 初始化数据库
     * @param {string} dbPath - 数据库文件路径
     */
    constructor(dbPath = 'data/sync.db') {
        // 确保data目录存在
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.dbPath = dbPath;
        this.db = new Database(dbPath);
        
        // 启用外键约束
        this.db.pragma('foreign_keys = ON');
        
        this._initDatabase();
        
        console.log(`[Database] 数据库初始化完成: ${dbPath}`);
    }

    /**
     * 初始化数据库表结构
     * @private
     */
    _initDatabase() {
        // 1. 同步组配置表（新增）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sync_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                eleme_cookies TEXT NOT NULL,
                eleme_seller_id TEXT,
                eleme_store_id TEXT,
                qnh_cookies TEXT NOT NULL,
                qnh_store_id TEXT NOT NULL,
                last_full_export_time TEXT,
                last_incr_query_started_at TEXT,
                last_full_sync_time TEXT,
                last_full_sync_count INTEGER,
                last_incr_sync_time TEXT,
                last_incr_sync_count INTEGER,
                enabled INTEGER DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);

        // 2. 同步历史表（增加group_id）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sync_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                sync_type TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT,
                status TEXT NOT NULL,
                total_items INTEGER DEFAULT 0,
                success_items INTEGER DEFAULT 0,
                failed_items INTEGER DEFAULT 0,
                error_msg TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (group_id) REFERENCES sync_groups(id) ON DELETE CASCADE
            )
        `);

        // 3. 商品映射表（增加group_id）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS product_mapping (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                eleme_barcode TEXT NOT NULL,
                qnh_sku_id TEXT NOT NULL,
                eleme_product_name TEXT,
                qnh_product_name TEXT,
                last_sync_time TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(group_id, eleme_barcode),
                FOREIGN KEY (group_id) REFERENCES sync_groups(id) ON DELETE CASCADE
            )
        `);

        // 4. 操作日志表（增加group_id）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS operation_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                operation_type TEXT NOT NULL,
                barcode TEXT,
                old_stock INTEGER,
                new_stock INTEGER,
                store_id TEXT,
                success INTEGER DEFAULT 1,
                error_msg TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (group_id) REFERENCES sync_groups(id) ON DELETE CASCADE
            )
        `);

        // 4.1 双向同步操作日志表（独立表，外键指向 dual_sync_groups）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS dual_operation_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                operation_type TEXT NOT NULL,
                barcode TEXT,
                old_stock INTEGER,
                new_stock INTEGER,
                store_id TEXT,
                success INTEGER DEFAULT 1,
                error_msg TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (group_id) REFERENCES dual_sync_groups(id) ON DELETE CASCADE
            )
        `);

        // 5. 配置表（全局配置）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                description TEXT,
                updated_at TEXT NOT NULL
            )
        `);

        // 6. 双向同步组配置表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS dual_sync_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                -- A侧饿了么配置
                a_eleme_cookies TEXT,
                a_eleme_seller_id TEXT,
                a_eleme_store_id TEXT,
                a_eleme_store_name TEXT,
                a_eleme_cookies_valid INTEGER DEFAULT 0,
                -- A侧牵牛花配置
                a_qnh_cookies TEXT,
                a_qnh_store_id TEXT,
                a_qnh_store_name TEXT,
                a_qnh_cookies_valid INTEGER DEFAULT 0,
                -- B侧饿了么配置
                b_eleme_cookies TEXT,
                b_eleme_seller_id TEXT,
                b_eleme_store_id TEXT,
                b_eleme_store_name TEXT,
                b_eleme_cookies_valid INTEGER DEFAULT 0,
                -- B侧牵牛花配置
                b_qnh_cookies TEXT,
                b_qnh_store_id TEXT,
                b_qnh_store_name TEXT,
                b_qnh_cookies_valid INTEGER DEFAULT 0,
                -- 同步配置
                sync_interval INTEGER DEFAULT 10,
                enabled INTEGER DEFAULT 1,
                -- 同步状态
                last_full_sync_time TEXT,
                last_full_sync_count INTEGER,
                last_incr_sync_time TEXT,
                last_incr_sync_count INTEGER,
                last_a_query_time TEXT,
                last_b_query_time TEXT,
                -- 时间戳
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);

        // 7. 双向同步历史表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS dual_sync_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                sync_type TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT,
                status TEXT NOT NULL,
                a_changes INTEGER DEFAULT 0,
                b_changes INTEGER DEFAULT 0,
                total_items INTEGER DEFAULT 0,
                success_items INTEGER DEFAULT 0,
                failed_items INTEGER DEFAULT 0,
                error_msg TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (group_id) REFERENCES dual_sync_groups(id) ON DELETE CASCADE
            )
        `);

        // 8. 双向同步库存快照表（用于记录同步后的库存值）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS dual_sync_stock_snapshot (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                barcode TEXT NOT NULL,
                product_name TEXT,
                last_known_stock INTEGER,
                last_sync_time TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(group_id, barcode),
                FOREIGN KEY (group_id) REFERENCES dual_sync_groups(id) ON DELETE CASCADE
            )
        `);

        // 8.1 双向同步：写入指纹记录表（用于过滤工具同步回流的饿了么 API 操作记录）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS dual_sync_applied_change (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                sync_run_id INTEGER,
                direction TEXT,
                dest_side TEXT NOT NULL, -- A / B，表示该写入会回流到哪一侧的饿了么操作记录
                barcode TEXT NOT NULL,
                old_stock INTEGER,
                new_stock INTEGER,
                applied_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (group_id) REFERENCES dual_sync_groups(id) ON DELETE CASCADE
            )
        `);

        // 8.2 双向同步：记录“已经消费过的源事件”，避免回溯窗口内重复消费
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS dual_sync_consumed_event (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                sync_run_id INTEGER,
                source_side TEXT NOT NULL, -- A / B，表示源记录来自哪一侧饿了么
                direction TEXT,
                event_key TEXT NOT NULL,
                record_type TEXT,
                barcode TEXT NOT NULL,
                biz_id TEXT,
                ele_biz_id TEXT,
                old_stock INTEGER,
                new_stock INTEGER,
                change_amount INTEGER,
                op_time TEXT NOT NULL,
                consumed_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(group_id, source_side, event_key),
                FOREIGN KEY (group_id) REFERENCES dual_sync_groups(id) ON DELETE CASCADE
            )
        `);

        // 8.3 双向同步：断点续跑（增量写入 pending 列表）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS dual_sync_pending_change (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                sync_run_id INTEGER NOT NULL,
                direction_code TEXT NOT NULL, -- 'A->B' / 'B->A'
                dest_side TEXT NOT NULL,      -- 'A' / 'B'
                barcode TEXT NOT NULL,
                delta INTEGER NOT NULL,
                source_events_json TEXT,
                status TEXT NOT NULL DEFAULT 'pending', -- pending/applied/failed
                error_msg TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(group_id, sync_run_id, direction_code, barcode),
                FOREIGN KEY (group_id) REFERENCES dual_sync_groups(id) ON DELETE CASCADE
            )
        `);

        // 8.4 双向同步：追溯记录表（用于排查库存不一致问题）
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS dual_sync_trace (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                sync_run_id INTEGER NOT NULL,
                sync_type TEXT NOT NULL,
                direction TEXT,
                barcode TEXT NOT NULL,
                product_name TEXT,
                source_records_count INTEGER,
                source_total_change INTEGER,
                was_filtered INTEGER DEFAULT 0,
                was_deduplicated INTEGER DEFAULT 0,
                filter_reason TEXT,
                current_stock INTEGER,
                target_stock INTEGER,
                apply_result TEXT,
                error_msg TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (group_id) REFERENCES dual_sync_groups(id) ON DELETE CASCADE
            )
        `);

        // 9. 数据库迁移：添加缺失的列（向后兼容）
        this._migrateDatabase();

        // 创建索引
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_sync_history_group ON sync_history(group_id);
            CREATE INDEX IF NOT EXISTS idx_sync_history_time ON sync_history(start_time);
            CREATE INDEX IF NOT EXISTS idx_product_mapping_group ON product_mapping(group_id);
            CREATE INDEX IF NOT EXISTS idx_product_mapping_barcode ON product_mapping(eleme_barcode);
            CREATE INDEX IF NOT EXISTS idx_operation_log_group ON operation_log(group_id);
            CREATE INDEX IF NOT EXISTS idx_operation_log_time ON operation_log(created_at);
            CREATE INDEX IF NOT EXISTS idx_dual_operation_log_group ON dual_operation_log(group_id);
            CREATE INDEX IF NOT EXISTS idx_dual_operation_log_time ON dual_operation_log(created_at);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_history_group ON dual_sync_history(group_id);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_history_time ON dual_sync_history(start_time);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_stock_group ON dual_sync_stock_snapshot(group_id);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_stock_barcode ON dual_sync_stock_snapshot(barcode);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_applied_change_group_side_time ON dual_sync_applied_change(group_id, dest_side, applied_at);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_applied_change_fingerprint ON dual_sync_applied_change(group_id, dest_side, barcode, old_stock, new_stock);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_consumed_event_group_side_time ON dual_sync_consumed_event(group_id, source_side, op_time);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_consumed_event_group_side_key ON dual_sync_consumed_event(group_id, source_side, event_key);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_pending_group_run_status ON dual_sync_pending_change(group_id, sync_run_id, status);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_pending_group_status ON dual_sync_pending_change(group_id, status);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_trace_barcode ON dual_sync_trace(group_id, barcode, created_at);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_trace_run ON dual_sync_trace(group_id, sync_run_id);
            CREATE INDEX IF NOT EXISTS idx_dual_sync_trace_type ON dual_sync_trace(group_id, sync_type, created_at);
        `);
    }

    /**
     * 数据库迁移：添加缺失的列
     * @private
     */
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
                { name: 'qnh_cookies_valid', type: 'INTEGER DEFAULT 0' },
                { name: 'last_full_export_time', type: 'TEXT' },
                { name: 'last_incr_query_started_at', type: 'TEXT' },
                { name: 'last_full_sync_time', type: 'TEXT' },
                { name: 'last_full_sync_count', type: 'INTEGER' },
                { name: 'last_incr_sync_time', type: 'TEXT' },
                { name: 'last_incr_sync_count', type: 'INTEGER' }
            ];
            
            // 添加缺失的列
            for (const column of columnsToAdd) {
                if (!existingColumns.has(column.name)) {
                    try {
                        const sql = `ALTER TABLE sync_groups ADD COLUMN ${column.name} ${column.type}`;
                        this.db.exec(sql);
                        console.log(`[Database] ✅ 添加列: ${column.name}`);
                    } catch (error) {
                        console.error(`[Database] ❌ 添加列失败 (${column.name}):`, error.message);
                    }
                } else {
                    console.log(`[Database] ⏭️  列已存在: ${column.name}`);
                }
            }

            // 检查 dual_sync_groups 表的列（双向同步专用）
            const dualTableInfo = this.db.prepare("PRAGMA table_info(dual_sync_groups)").all();
            const dualExistingColumns = new Set(dualTableInfo.map(col => col.name));

            const dualColumnsToAdd = [
                { name: 'last_a_apply_start_time', type: 'TEXT' },
                { name: 'last_a_apply_end_time', type: 'TEXT' },
                { name: 'last_b_apply_start_time', type: 'TEXT' },
                { name: 'last_b_apply_end_time', type: 'TEXT' },
                // 全量同步基线时间（用于增量回溯边界保护）
                { name: 'full_sync_a_baseline_time', type: 'TEXT' },
                { name: 'full_sync_b_baseline_time', type: 'TEXT' }
            ];

            for (const column of dualColumnsToAdd) {
                if (!dualExistingColumns.has(column.name)) {
                    try {
                        const sql = `ALTER TABLE dual_sync_groups ADD COLUMN ${column.name} ${column.type}`;
                        this.db.exec(sql);
                        console.log(`[Database] ✅ 添加列(dual): ${column.name}`);
                    } catch (error) {
                        console.error(`[Database] ❌ 添加列失败(dual) (${column.name}):`, error.message);
                    }
                } else {
                    console.log(`[Database] ⏭️  列已存在(dual): ${column.name}`);
                }
            }

            // dual_sync_history 增量断点：记录本轮查询窗口（便于取消后恢复并最终推进 query_time）
            const dualHistoryInfo = this.db.prepare("PRAGMA table_info(dual_sync_history)").all();
            const dualHistoryCols = new Set(dualHistoryInfo.map(col => col.name));
            const dualHistoryColumnsToAdd = [
                { name: 'a_query_start_time', type: 'TEXT' },
                { name: 'a_query_end_time', type: 'TEXT' },
                { name: 'b_query_start_time', type: 'TEXT' },
                { name: 'b_query_end_time', type: 'TEXT' }
            ];
            for (const column of dualHistoryColumnsToAdd) {
                if (!dualHistoryCols.has(column.name)) {
                    try {
                        const sql = `ALTER TABLE dual_sync_history ADD COLUMN ${column.name} ${column.type}`;
                        this.db.exec(sql);
                        console.log(`[Database] ✅ 添加列(dual_history): ${column.name}`);
                    } catch (error) {
                        console.error(`[Database] ❌ 添加列失败(dual_history) (${column.name}):`, error.message);
                    }
                }
            }

            const pendingInfo = this.db.prepare("PRAGMA table_info(dual_sync_pending_change)").all();
            const pendingCols = new Set(pendingInfo.map(col => col.name));
            if (!pendingCols.has('source_events_json')) {
                try {
                    this.db.exec(`ALTER TABLE dual_sync_pending_change ADD COLUMN source_events_json TEXT`);
                    console.log('[Database] ✅ 添加列(pending): source_events_json');
                } catch (error) {
                    console.error('[Database] ❌ 添加列失败(pending) (source_events_json):', error.message);
                }
            }
            
            console.log('[Database] 数据库迁移完成');
        } catch (error) {
            console.error('[Database] 数据库迁移失败:', error);
        }
    }

    // ==================== 组管理 ====================

    /**
     * 添加同步组
     * @param {string} name - 组名称
     * @param {Object} elemeConfig - 饿了么配置
     * @param {Object} qnhConfig - 牵牛花配置
     * @returns {number} 组ID
     */
    addGroup(name, elemeConfig, qnhConfig) {
        const now = toLocalISOString();
        const stmt = this.db.prepare(`
            INSERT INTO sync_groups (
                name, eleme_cookies, eleme_seller_id, eleme_store_id,
                qnh_cookies, qnh_store_id, enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            name,
            elemeConfig.cookies,
            elemeConfig.seller_id || null,
            elemeConfig.store_id || null,
            qnhConfig.cookies,
            qnhConfig.store_id,
            1,
            now,
            now
        );

        console.log(`[Database] 添加组: ${name} (ID: ${result.lastInsertRowid})`);
        return result.lastInsertRowid;
    }

    /**
     * 复制同步组（用于快速创建相同Cookies的组，仅需修改牵牛花门店）
     * @param {number} sourceGroupId - 源组ID
     * @param {string|null} newName - 新组名（可选，不传则使用“源名称（副本）”）
     * @returns {number} 新组ID
     */
    duplicateGroup(sourceGroupId, newName = null) {
        const source = this.getGroup(sourceGroupId);
        if (!source) {
            throw new Error(`源组不存在: ${sourceGroupId}`);
        }

        // 生成新名称
        let name = newName && newName.trim() ? newName.trim() : `${source.name}（副本）`;
        const now = toLocalISOString();

        // 插入新记录（保留Cookies与饿了么门店，清空牵牛花门店，状态字段复位）
        const stmt = this.db.prepare(`
            INSERT INTO sync_groups (
                name,
                eleme_cookies, eleme_seller_id, eleme_store_id, eleme_store_name, eleme_cookies_valid,
                qnh_cookies, qnh_store_id, qnh_store_name, qnh_cookies_valid,
                last_full_sync_time, last_full_sync_count,
                last_incr_sync_time, last_incr_sync_count,
                enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            name,
            source.eleme_cookies || '',
            source.eleme_seller_id || null,
            source.eleme_store_id || null,
            source.eleme_store_name || null,
            source.eleme_cookies_valid ? 1 : 0,
            source.qnh_cookies || '',
            '', // 清空牵牛花门店ID，需用户选择
            null, // 清空牵牛花门店名称
            source.qnh_cookies_valid ? 1 : 0,
            null,
            null,
            null,
            null,
            1,
            now,
            now
        );

        console.log(`[Database] 复制组: ${sourceGroupId} -> 新ID: ${result.lastInsertRowid}`);
        return result.lastInsertRowid;
    }

    /**
     * 获取指定组信息
     * @param {number} groupId - 组ID
     * @returns {Object|null} 组信息
     */
    getGroup(groupId) {
        const stmt = this.db.prepare('SELECT * FROM sync_groups WHERE id = ?');
        return stmt.get(groupId);
    }

    /**
     * 获取所有组
     * @param {boolean} enabledOnly - 是否只返回启用的组
     * @returns {Array<Object>} 组列表
     */
    getAllGroups(enabledOnly = false) {
        let sql = 'SELECT * FROM sync_groups';
        if (enabledOnly) {
            sql += ' WHERE enabled = 1';
        }
        sql += ' ORDER BY created_at DESC';
        
        const stmt = this.db.prepare(sql);
        return stmt.all();
    }

    /**
     * 更新组信息
     * @param {number} groupId - 组ID
     * @param {Object} updates - 更新字段
     */
    updateGroup(groupId, updates) {
        const allowedFields = [
            'name', 'eleme_cookies', 'eleme_seller_id', 'eleme_store_id', 'eleme_store_name',
            'eleme_cookies_valid', 'qnh_cookies', 'qnh_store_id', 'qnh_store_name',
            'qnh_cookies_valid', 'enabled',
            // 上次同步摘要字段
            'last_full_export_time', 'last_incr_query_started_at',
            'last_full_sync_time', 'last_full_sync_count',
            'last_incr_sync_time', 'last_incr_sync_count'
        ];
        
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (fields.length === 0) {
            return;
        }
        
        fields.push('updated_at = ?');
        values.push(toLocalISOString());
        values.push(groupId);
        
        const sql = `UPDATE sync_groups SET ${fields.join(', ')} WHERE id = ?`;
        const stmt = this.db.prepare(sql);
        stmt.run(...values);
        
        console.log(`[Database] 更新组: ${groupId}`);
    }

    /**
     * 删除组（级联删除相关数据）
     * @param {number} groupId - 组ID
     */
    deleteGroup(groupId) {
        const stmt = this.db.prepare('DELETE FROM sync_groups WHERE id = ?');
        stmt.run(groupId);
        console.log(`[Database] 删除组: ${groupId}`);
    }

    // ==================== 同步历史 ====================

    /**
     * 添加同步历史记录
     * @param {number} groupId - 组ID
     * @param {string} syncType - 同步类型 (full/incremental)
     * @param {Date} startTime - 开始时间
     * @param {string} status - 状态 (running/success/failed)
     * @returns {number} 记录ID
     */
    addSyncHistory(groupId, syncType, startTime, status = 'running') {
        const stmt = this.db.prepare(`
            INSERT INTO sync_history (
                group_id, sync_type, start_time, status, created_at
            ) VALUES (?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            groupId,
            syncType,
            toLocalISOString(startTime),
            status,
            toLocalISOString()
        );

        return result.lastInsertRowid;
    }

    /**
     * 更新同步历史记录
     * @param {number} recordId - 记录ID
     * @param {Object} updates - 更新字段
     */
    updateSyncHistory(recordId, updates) {
        const fields = [];
        const values = [];
        
        const fieldMap = {
            endTime: 'end_time',
            status: 'status',
            totalItems: 'total_items',
            successItems: 'success_items',
            failedItems: 'failed_items',
            errorMsg: 'error_msg'
        };
        
        for (const [key, dbField] of Object.entries(fieldMap)) {
            if (updates[key] !== undefined) {
                fields.push(`${dbField} = ?`);
                if (key === 'endTime' && updates[key] instanceof Date) {
                    values.push(toLocalISOString(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        }
        
        if (fields.length === 0) {
            return;
        }
        
        values.push(recordId);
        
        const sql = `UPDATE sync_history SET ${fields.join(', ')} WHERE id = ?`;
        const stmt = this.db.prepare(sql);
        stmt.run(...values);
    }

    /**
     * 获取组的同步历史
     * @param {number} groupId - 组ID
     * @param {number} limit - 限制数量
     * @returns {Array<Object>} 历史记录列表
     */
    getGroupSyncHistory(groupId, limit = 50) {
        const stmt = this.db.prepare(`
            SELECT * FROM sync_history
            WHERE group_id = ?
            ORDER BY start_time DESC
            LIMIT ?
        `);
        return stmt.all(groupId, limit);
    }

    /**
     * 获取最近的同步历史
     * @param {number} limit - 限制数量
     * @returns {Array<Object>} 历史记录列表
     */
    getRecentSyncHistory(limit = 100) {
        const stmt = this.db.prepare(`
            SELECT h.*, g.name as group_name
            FROM sync_history h
            LEFT JOIN sync_groups g ON h.group_id = g.id
            ORDER BY h.start_time DESC
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    // ==================== 商品映射 ====================

    /**
     * 保存商品映射
     * @param {number} groupId - 组ID
     * @param {string} elemeBarcode - 饿了么条形码
     * @param {string} qnhSkuId - 牵牛花SKU ID
     * @param {string} elemeProductName - 饿了么商品名
     * @param {string} qnhProductName - 牵牛花商品名
     */
    saveProductMapping(groupId, elemeBarcode, qnhSkuId, elemeProductName = null, qnhProductName = null) {
        const now = toLocalISOString();
        
        const stmt = this.db.prepare(`
            INSERT INTO product_mapping (
                group_id, eleme_barcode, qnh_sku_id, eleme_product_name, qnh_product_name,
                last_sync_time, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(group_id, eleme_barcode) DO UPDATE SET
                qnh_sku_id = excluded.qnh_sku_id,
                eleme_product_name = excluded.eleme_product_name,
                qnh_product_name = excluded.qnh_product_name,
                last_sync_time = excluded.last_sync_time,
                updated_at = excluded.updated_at
        `);

        stmt.run(
            groupId,
            elemeBarcode,
            qnhSkuId,
            elemeProductName,
            qnhProductName,
            now,
            now,
            now
        );
    }

    /**
     * 获取组的商品映射
     * @param {number} groupId - 组ID
     * @returns {Object} 映射对象 {barcode: skuId}
     */
    getGroupMappings(groupId) {
        const stmt = this.db.prepare(`
            SELECT eleme_barcode, qnh_sku_id
            FROM product_mapping
            WHERE group_id = ?
        `);
        
        const rows = stmt.all(groupId);
        const mapping = {};
        for (const row of rows) {
            mapping[row.eleme_barcode] = row.qnh_sku_id;
        }
        return mapping;
    }

    /**
     * 获取组的所有商品映射（详细信息）
     * @param {number} groupId - 组ID
     * @returns {Array<Object>} 映射列表
     */
    getGroupMappingsDetailed(groupId) {
        const stmt = this.db.prepare(`
            SELECT * FROM product_mapping
            WHERE group_id = ?
            ORDER BY updated_at DESC
        `);
        return stmt.all(groupId);
    }

    // ==================== 操作日志 ====================

    /**
     * 添加操作日志
     * @param {number} groupId - 组ID
     * @param {string} operationType - 操作类型
     * @param {string} barcode - 条形码
     * @param {number} oldStock - 旧库存
     * @param {number} newStock - 新库存
     * @param {string} storeId - 门店ID
     * @param {boolean} success - 是否成功
     * @param {string} errorMsg - 错误信息
     */
    addOperationLog(groupId, operationType, barcode, oldStock, newStock, storeId, success = true, errorMsg = null) {
        const stmt = this.db.prepare(`
            INSERT INTO operation_log (
                group_id, operation_type, barcode, old_stock, new_stock,
                store_id, success, error_msg, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            groupId,
            operationType,
            barcode,
            oldStock,
            newStock,
            storeId,
            success ? 1 : 0,
            errorMsg,
            toLocalISOString()
        );
    }

    /**
     * 添加双向同步操作日志（仅失败记录也可写入）
     * @param {number} groupId - 双向同步组ID
     * @param {string} operationType - 操作类型
     * @param {string} barcode - 条形码
     * @param {number|null} oldStock - 旧库存
     * @param {number|null} newStock - 新库存
     * @param {string} storeId - 门店ID
     * @param {boolean} success - 是否成功
     * @param {string|null} errorMsg - 错误信息
     */
    addDualOperationLog(groupId, operationType, barcode, oldStock, newStock, storeId, success = true, errorMsg = null) {
        const stmt = this.db.prepare(`
            INSERT INTO dual_operation_log (
                group_id, operation_type, barcode, old_stock, new_stock,
                store_id, success, error_msg, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            groupId,
            operationType,
            barcode,
            oldStock,
            newStock,
            storeId,
            success ? 1 : 0,
            errorMsg,
            toLocalISOString()
        );
    }

    /**
     * 获取组的操作日志（仅失败记录）
     * @param {number} groupId - 组ID
     * @param {number} limit - 限制数量
     * @returns {Array<Object>} 日志列表
     */
    getGroupLogs(groupId, limit = 100) {
        const stmt = this.db.prepare(`
            SELECT * FROM operation_log
            WHERE group_id = ? AND success = 0
            ORDER BY created_at DESC
            LIMIT ?
        `);
        return stmt.all(groupId, limit);
    }

    /**
     * 获取最近的操作日志（仅失败记录）
     * @param {number} limit - 限制数量
     * @returns {Array<Object>} 日志列表
     */
    getRecentLogs(limit = 100) {
        const stmt = this.db.prepare(`
            SELECT l.*, g.name as group_name
            FROM operation_log l
            LEFT JOIN sync_groups g ON l.group_id = g.id
            WHERE l.success = 0
            ORDER BY l.created_at DESC
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    /**
     * 获取最近失败日志（单向 + 双向，合并）
     * @param {number} limit - 限制数量
     * @returns {Array<Object>} 日志列表
     */
    getRecentFailedLogsCombined(limit = 100) {
        const stmt = this.db.prepare(`
            SELECT *
            FROM (
                SELECT
                    l.id,
                    l.group_id,
                    l.operation_type,
                    l.barcode,
                    l.old_stock,
                    l.new_stock,
                    l.store_id,
                    l.success,
                    l.error_msg,
                    l.created_at AS created_at,
                    g.name AS group_name
                FROM operation_log l
                LEFT JOIN sync_groups g ON l.group_id = g.id
                WHERE l.success = 0
                UNION ALL
                SELECT
                    dl.id,
                    dl.group_id,
                    dl.operation_type,
                    dl.barcode,
                    dl.old_stock,
                    dl.new_stock,
                    dl.store_id,
                    dl.success,
                    dl.error_msg,
                    dl.created_at AS created_at,
                    dg.name AS group_name
                FROM dual_operation_log dl
                LEFT JOIN dual_sync_groups dg ON dl.group_id = dg.id
                WHERE dl.success = 0
            )
            ORDER BY created_at DESC
            LIMIT ?
        `);
        return stmt.all(limit);
    }

    // ==================== 配置管理 ====================

    /**
     * 设置配置
     * @param {string} key - 配置键
     * @param {string} value - 配置值
     * @param {string} description - 描述
     */
    setConfig(key, value, description = null) {
        const stmt = this.db.prepare(`
            INSERT INTO config (key, value, description, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                description = excluded.description,
                updated_at = excluded.updated_at
        `);

        stmt.run(key, value, description, toLocalISOString());
    }

    /**
     * 获取配置
     * @param {string} key - 配置键
     * @param {string} defaultValue - 默认值
     * @returns {string|null} 配置值
     */
    getConfig(key, defaultValue = null) {
        const stmt = this.db.prepare('SELECT value FROM config WHERE key = ?');
        const row = stmt.get(key);
        return row ? row.value : defaultValue;
    }

    /**
     * 获取上次同步时间
     * @param {number} groupId - 组ID
     * @param {string} syncType - 同步类型 (full/incremental)
     * @returns {Date|null} 上次同步时间
     */
    getLastSyncTime(groupId, syncType = null) {
        // 使用 end_time 作为“上次完成时间”，避免按 start_time 造成边界遗漏
        let sql = `
            SELECT end_time FROM sync_history
            WHERE group_id = ? AND status = 'success' AND end_time IS NOT NULL
        `;
        const params = [groupId];
        
        if (syncType) {
            sql += ' AND sync_type = ?';
            params.push(syncType);
        }
        
        sql += ' ORDER BY end_time DESC LIMIT 1';
        
        const stmt = this.db.prepare(sql);
        const row = stmt.get(...params);
        
        return row ? new Date(row.end_time) : null;
    }

    /**
     * 获取同步统计信息
     * @param {number} groupId - 组ID（可选）
     * @returns {Object} 统计信息
     */
    getSyncStats(groupId = null) {
        let sql = `
            SELECT 
                COUNT(*) as total_syncs,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
                SUM(total_items) as total_items,
                SUM(success_items) as success_items,
                SUM(failed_items) as failed_items
            FROM sync_history
        `;
        
        const params = [];
        if (groupId !== null) {
            sql += ' WHERE group_id = ?';
            params.push(groupId);
        }
        
        const stmt = this.db.prepare(sql);
        const stats = stmt.get(...params);
        
        return {
            totalSyncs: stats.total_syncs || 0,
            successCount: stats.success_count || 0,
            failedCount: stats.failed_count || 0,
            totalItems: stats.total_items || 0,
            successItems: stats.success_items || 0,
            failedItems: stats.failed_items || 0,
            successRate: stats.total_syncs > 0 ? (stats.success_count / stats.total_syncs * 100).toFixed(2) + '%' : '0%'
        };
    }

    /**
     * 关闭数据库连接
     */
    close() {
        this.db.close();
        console.log('[Database] 数据库连接已关闭');
    }

    // ==================== 双向同步组管理 ====================

    /**
     * 添加双向同步组
     * @param {string} name - 组名称
     * @param {Object} config - 配置对象
     * @returns {number} 组ID
     */
    addDualSyncGroup(name, config = {}) {
        const now = toLocalISOString();
        const stmt = this.db.prepare(`
            INSERT INTO dual_sync_groups (
                name,
                a_eleme_cookies, a_eleme_seller_id, a_eleme_store_id, a_eleme_store_name,
                a_qnh_cookies, a_qnh_store_id, a_qnh_store_name,
                b_eleme_cookies, b_eleme_seller_id, b_eleme_store_id, b_eleme_store_name,
                b_qnh_cookies, b_qnh_store_id, b_qnh_store_name,
                sync_interval, enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            name,
            config.a_eleme_cookies || '',
            config.a_eleme_seller_id || null,
            config.a_eleme_store_id || null,
            config.a_eleme_store_name || null,
            config.a_qnh_cookies || '',
            config.a_qnh_store_id || null,
            config.a_qnh_store_name || null,
            config.b_eleme_cookies || '',
            config.b_eleme_seller_id || null,
            config.b_eleme_store_id || null,
            config.b_eleme_store_name || null,
            config.b_qnh_cookies || '',
            config.b_qnh_store_id || null,
            config.b_qnh_store_name || null,
            config.sync_interval || 10,
            1,
            now,
            now
        );

        console.log(`[Database] 添加双向同步组: ${name} (ID: ${result.lastInsertRowid})`);
        return result.lastInsertRowid;
    }

    /**
     * 获取双向同步组
     * @param {number} groupId - 组ID
     * @returns {Object|null} 组信息
     */
    getDualSyncGroup(groupId) {
        const stmt = this.db.prepare('SELECT * FROM dual_sync_groups WHERE id = ?');
        return stmt.get(groupId);
    }

    /**
     * 获取所有双向同步组
     * @param {boolean} enabledOnly - 是否只返回启用的组
     * @returns {Array<Object>} 组列表
     */
    getAllDualSyncGroups(enabledOnly = false) {
        let sql = 'SELECT * FROM dual_sync_groups';
        if (enabledOnly) {
            sql += ' WHERE enabled = 1';
        }
        sql += ' ORDER BY created_at DESC';
        
        const stmt = this.db.prepare(sql);
        return stmt.all();
    }

    /**
     * 更新双向同步组
     * @param {number} groupId - 组ID
     * @param {Object} updates - 更新字段
     */
    updateDualSyncGroup(groupId, updates) {
        const allowedFields = [
            'name',
            'a_eleme_cookies', 'a_eleme_seller_id', 'a_eleme_store_id', 'a_eleme_store_name', 'a_eleme_cookies_valid',
            'a_qnh_cookies', 'a_qnh_store_id', 'a_qnh_store_name', 'a_qnh_cookies_valid',
            'b_eleme_cookies', 'b_eleme_seller_id', 'b_eleme_store_id', 'b_eleme_store_name', 'b_eleme_cookies_valid',
            'b_qnh_cookies', 'b_qnh_store_id', 'b_qnh_store_name', 'b_qnh_cookies_valid',
            'sync_interval', 'enabled',
            'last_full_sync_time', 'last_full_sync_count',
            'last_incr_sync_time', 'last_incr_sync_count',
            'last_a_query_time', 'last_b_query_time',
            // 工具写入窗口（用于过滤饿了么回流 API 操作记录）
            'last_a_apply_start_time', 'last_a_apply_end_time',
            'last_b_apply_start_time', 'last_b_apply_end_time',
            // 全量同步基线时间（用于对账和增量回溯边界保护）
            'full_sync_a_baseline_time', 'full_sync_b_baseline_time'
        ];
        
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updates)) {
            if (allowedFields.includes(key)) {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (fields.length === 0) {
            return;
        }
        
        fields.push('updated_at = ?');
        values.push(toLocalISOString());
        values.push(groupId);
        
        const sql = `UPDATE dual_sync_groups SET ${fields.join(', ')} WHERE id = ?`;
        const stmt = this.db.prepare(sql);
        stmt.run(...values);
        
        console.log(`[Database] 更新双向同步组: ${groupId}`);
    }

    /**
     * 删除双向同步组（级联删除相关数据）
     * @param {number} groupId - 组ID
     */
    deleteDualSyncGroup(groupId) {
        const stmt = this.db.prepare('DELETE FROM dual_sync_groups WHERE id = ?');
        stmt.run(groupId);
        console.log(`[Database] 删除双向同步组: ${groupId}`);
    }

    /**
     * 复制双向同步组
     * @param {number} sourceGroupId - 源组ID
     * @param {string|null} newName - 新组名
     * @returns {number} 新组ID
     */
    duplicateDualSyncGroup(sourceGroupId, newName = null) {
        const source = this.getDualSyncGroup(sourceGroupId);
        if (!source) {
            throw new Error(`源组不存在: ${sourceGroupId}`);
        }

        const finalName = newName || `${source.name}（副本）`;
        const now = toLocalISOString();

        const stmt = this.db.prepare(`
            INSERT INTO dual_sync_groups (
                name,
                a_eleme_cookies, a_eleme_seller_id, a_eleme_store_id, a_eleme_store_name, a_eleme_cookies_valid,
                a_qnh_cookies, a_qnh_store_id, a_qnh_store_name, a_qnh_cookies_valid,
                b_eleme_cookies, b_eleme_seller_id, b_eleme_store_id, b_eleme_store_name, b_eleme_cookies_valid,
                b_qnh_cookies, b_qnh_store_id, b_qnh_store_name, b_qnh_cookies_valid,
                sync_interval, enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            finalName,
            source.a_eleme_cookies, source.a_eleme_seller_id, source.a_eleme_store_id, source.a_eleme_store_name, source.a_eleme_cookies_valid,
            source.a_qnh_cookies, source.a_qnh_store_id, source.a_qnh_store_name, source.a_qnh_cookies_valid,
            source.b_eleme_cookies, source.b_eleme_seller_id, source.b_eleme_store_id, source.b_eleme_store_name, source.b_eleme_cookies_valid,
            source.b_qnh_cookies, source.b_qnh_store_id, source.b_qnh_store_name, source.b_qnh_cookies_valid,
            source.sync_interval, 1, now, now
        );

        console.log(`[Database] 复制双向同步组: ${sourceGroupId} -> 新ID: ${result.lastInsertRowid}`);
        return result.lastInsertRowid;
    }

    // ==================== 双向同步历史 ====================

    /**
     * 添加双向同步历史记录
     * @param {number} groupId - 组ID
     * @param {string} syncType - 同步类型 (full/incremental)
     * @param {Date} startTime - 开始时间
     * @param {string} status - 状态
     * @returns {number} 记录ID
     */
    addDualSyncHistory(groupId, syncType, startTime, status = 'running') {
        const stmt = this.db.prepare(`
            INSERT INTO dual_sync_history (
                group_id, sync_type, start_time, status, created_at
            ) VALUES (?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            groupId,
            syncType,
            toLocalISOString(startTime),
            status,
            toLocalISOString()
        );

        return result.lastInsertRowid;
    }

    /**
     * 更新双向同步历史记录
     * @param {number} recordId - 记录ID
     * @param {Object} updates - 更新字段
     */
    updateDualSyncHistory(recordId, updates) {
        const fields = [];
        const values = [];
        
        const fieldMap = {
            endTime: 'end_time',
            status: 'status',
            aChanges: 'a_changes',
            bChanges: 'b_changes',
            totalItems: 'total_items',
            successItems: 'success_items',
            failedItems: 'failed_items',
            errorMsg: 'error_msg',
            aQueryStartTime: 'a_query_start_time',
            aQueryEndTime: 'a_query_end_time',
            bQueryStartTime: 'b_query_start_time',
            bQueryEndTime: 'b_query_end_time'
        };
        
        for (const [key, dbField] of Object.entries(fieldMap)) {
            if (updates[key] !== undefined) {
                fields.push(`${dbField} = ?`);
                if (key === 'endTime' && updates[key] instanceof Date) {
                    values.push(toLocalISOString(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        }
        
        if (fields.length === 0) {
            return;
        }
        
        values.push(recordId);
        
        const sql = `UPDATE dual_sync_history SET ${fields.join(', ')} WHERE id = ?`;
        const stmt = this.db.prepare(sql);
        stmt.run(...values);
    }

    // ==================== 双向同步：断点续跑 pending 列表 ====================

    /**
     * 批量写入 pending 变更（断点续跑）
     * @param {number} groupId
     * @param {number} syncRunId - dual_sync_history.id
     * @param {string} directionCode - 'A->B' / 'B->A'
     * @param {string} destSide - 'A' / 'B'
     * @param {Array<{barcode: string, delta: number, sourceEvents?: Array}>} items
     */
    addDualSyncPendingChanges(groupId, syncRunId, directionCode, destSide, items) {
        if (!items || items.length === 0) return;
        const now = toLocalISOString();

        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO dual_sync_pending_change (
                group_id, sync_run_id, direction_code, dest_side,
                barcode, delta, source_events_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `);

        const transaction = this.db.transaction((rows) => {
            for (const row of rows) {
                stmt.run(
                    groupId,
                    syncRunId,
                    directionCode,
                    destSide,
                    row.barcode,
                    row.delta,
                    row.sourceEvents ? JSON.stringify(row.sourceEvents) : null,
                    now,
                    now
                );
            }
        });
        transaction(items);
    }

    /**
     * 获取某个 run 的 pending 变更
     */
    getDualSyncPendingChanges(groupId, syncRunId, directionCode = null, status = 'pending') {
        let sql = `
            SELECT direction_code, dest_side, barcode, delta, source_events_json, status
            FROM dual_sync_pending_change
            WHERE group_id = ? AND sync_run_id = ? AND status = ?
        `;
        const params = [groupId, syncRunId, status];
        if (directionCode) {
            sql += ` AND direction_code = ?`;
            params.push(directionCode);
        }
        sql += ` ORDER BY id ASC`;
        return this.db.prepare(sql).all(...params).map(row => ({
            ...row,
            sourceEvents: row.source_events_json ? JSON.parse(row.source_events_json) : []
        }));
    }

    /**
     * 获取最近一个仍有 pending 的 run（用于恢复）
     */
    getLatestDualSyncPendingRunId(groupId) {
        const row = this.db.prepare(`
            SELECT sync_run_id, COUNT(1) AS c
            FROM dual_sync_pending_change
            WHERE group_id = ? AND status = 'pending'
            GROUP BY sync_run_id
            ORDER BY sync_run_id DESC
            LIMIT 1
        `).get(groupId);
        return row ? row.sync_run_id : null;
    }

    /**
     * 将一批条形码标记为 applied
     */
    markDualSyncPendingApplied(groupId, syncRunId, directionCode, barcodes) {
        if (!barcodes || barcodes.length === 0) return;
        const now = toLocalISOString();
        const placeholders = barcodes.map(() => '?').join(',');
        const sql = `
            UPDATE dual_sync_pending_change
            SET status = 'applied', updated_at = ?, error_msg = NULL
            WHERE group_id = ? AND sync_run_id = ? AND direction_code = ?
              AND status = 'pending'
              AND barcode IN (${placeholders})
        `;
        this.db.prepare(sql).run(now, groupId, syncRunId, directionCode, ...barcodes);
    }

    /**
     * 将条形码标记为 failed（不会再重试，避免一直卡在 pending）
     */
    markDualSyncPendingFailed(groupId, syncRunId, directionCode, barcodes, errorMsg = 'failed') {
        if (!barcodes || barcodes.length === 0) return;
        const now = toLocalISOString();
        const placeholders = barcodes.map(() => '?').join(',');
        const sql = `
            UPDATE dual_sync_pending_change
            SET status = 'failed', updated_at = ?, error_msg = ?
            WHERE group_id = ? AND sync_run_id = ? AND direction_code = ?
              AND status = 'pending'
              AND barcode IN (${placeholders})
        `;
        this.db.prepare(sql).run(now, errorMsg, groupId, syncRunId, directionCode, ...barcodes);
    }

    /**
     * 清理某个 run 的 pending 表（全部 applied 后）
     */
    clearDualSyncPendingRun(groupId, syncRunId) {
        this.db.prepare(`
            DELETE FROM dual_sync_pending_change
            WHERE group_id = ? AND sync_run_id = ?
        `).run(groupId, syncRunId);
    }

    // ==================== 双向同步：工具写入指纹（用于过滤饿了么回流） ====================

    /**
     * 批量写入“工具写入造成的库存变更指纹”
     * @param {number} groupId - 双向同步组ID
     * @param {number|null} syncRunId - dual_sync_history.id（可为空）
     * @param {string} destSide - 'A' | 'B'（回流会出现在该侧饿了么）
     * @param {string} direction - 方向标识（如 'A->B' / 'B->A'）
     * @param {Array<Object>} items - [{barcode, oldStock, newStock, appliedAt}]
     */
    addDualSyncAppliedChanges(groupId, syncRunId, destSide, direction, items) {
        if (!items || items.length === 0) return;

        const now = toLocalISOString();
        const stmt = this.db.prepare(`
            INSERT INTO dual_sync_applied_change (
                group_id, sync_run_id, direction, dest_side,
                barcode, old_stock, new_stock, applied_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const transaction = this.db.transaction((rows) => {
            for (const row of rows) {
                stmt.run(
                    groupId,
                    syncRunId || null,
                    direction || null,
                    destSide,
                    row.barcode,
                    row.oldStock,
                    row.newStock,
                    row.appliedAt || now,
                    now
                );
            }
        });

        transaction(items);

        // 轻量清理：保留最近7天（避免表无限增长）
        try {
            const cutoff = toLocalISOString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
            this.db.prepare(`
                DELETE FROM dual_sync_applied_change
                WHERE group_id = ? AND applied_at < ?
            `).run(groupId, cutoff);
        } catch (e) {
            // 清理失败不影响主流程
        }
    }

    /**
     * 批量写入“已经成功消费过的源事件”
     * 用于处理增量回溯时，同一条真实饿了么记录再次被查询到的问题
     * @param {number} groupId
     * @param {number|null} syncRunId
     * @param {string} sourceSide - 'A' | 'B'
     * @param {string|null} direction - 'A->B' | 'B->A'
     * @param {Array<Object>} items - [{eventKey, recordType, barcode, bizId, eleBizId, oldStock, newStock, changeAmount, opTime, consumedAt}]
     */
    addDualSyncConsumedEvents(groupId, syncRunId, sourceSide, direction, items) {
        if (!items || items.length === 0) return;

        const now = toLocalISOString();
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO dual_sync_consumed_event (
                group_id, sync_run_id, source_side, direction, event_key, record_type,
                barcode, biz_id, ele_biz_id, old_stock, new_stock, change_amount,
                op_time, consumed_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const transaction = this.db.transaction((rows) => {
            for (const row of rows) {
                stmt.run(
                    groupId,
                    syncRunId || null,
                    sourceSide,
                    direction || null,
                    row.eventKey,
                    row.recordType || null,
                    row.barcode,
                    row.bizId || null,
                    row.eleBizId || null,
                    row.oldStock ?? null,
                    row.newStock ?? null,
                    row.changeAmount ?? null,
                    row.opTime,
                    row.consumedAt || now,
                    now
                );
            }
        });

        transaction(items);

        try {
            const cutoff = toLocalISOString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
            this.db.prepare(`
                DELETE FROM dual_sync_consumed_event
                WHERE group_id = ? AND op_time < ?
            `).run(groupId, cutoff);
        } catch (_) {}
    }

    /**
     * 获取某一侧在指定时间范围内已经消费过的源事件 key 集合
     * @param {number} groupId
     * @param {string} sourceSide - 'A' | 'B'
     * @param {string} windowStartIso
     * @param {string} windowEndIso
     * @returns {Set<string>}
     */
    getDualSyncConsumedEventKeys(groupId, sourceSide, windowStartIso, windowEndIso) {
        if (!windowStartIso || !windowEndIso) {
            return new Set();
        }

        const rows = this.db.prepare(`
            SELECT event_key
            FROM dual_sync_consumed_event
            WHERE group_id = ?
              AND source_side = ?
              AND op_time >= ?
              AND op_time <= ?
        `).all(groupId, sourceSide, windowStartIso, windowEndIso);

        return new Set(rows.map(row => row.event_key).filter(Boolean));
    }

    /**
     * 获取指定时间窗内的指纹映射（用于过滤饿了么操作记录回流）
     * @param {number} groupId - 双向同步组ID
     * @param {string} destSide - 'A' | 'B'
     * @param {string} windowStartIso - 起始时间（toLocalISOString 格式）
     * @param {string} windowEndIso - 结束时间（toLocalISOString 格式）
     * @returns {Map<string, string[]>} 指纹映射，key 为 `${barcode}_${old}_${new}`，value 为 appliedAt 时间数组
     */
    getDualSyncAppliedFingerprints(groupId, destSide, windowStartIso, windowEndIso) {
        if (!windowStartIso || !windowEndIso) {
            return new Map();
        }

        const stmt = this.db.prepare(`
            SELECT barcode, old_stock, new_stock, applied_at
            FROM dual_sync_applied_change
            WHERE group_id = ?
              AND dest_side = ?
              AND applied_at >= ?
              AND applied_at <= ?
              AND barcode IS NOT NULL
              AND old_stock IS NOT NULL
              AND new_stock IS NOT NULL
        `);

        const rows = stmt.all(groupId, destSide, windowStartIso, windowEndIso);
        const map = new Map();
        for (const row of rows) {
            const key = `${row.barcode}_${row.old_stock}_${row.new_stock}`;
            if (!map.has(key)) {
                map.set(key, []);
            }
            map.get(key).push(row.applied_at);
        }
        return map;
    }

    /**
     * 获取双向同步组的历史
     * @param {number} groupId - 组ID
     * @param {number} limit - 限制数量
     * @returns {Array<Object>} 历史记录列表
     */
    getDualSyncGroupHistory(groupId, limit = 50) {
        const stmt = this.db.prepare(`
            SELECT * FROM dual_sync_history
            WHERE group_id = ?
            ORDER BY start_time DESC
            LIMIT ?
        `);
        return stmt.all(groupId, limit);
    }

    /**
     * 获取双向同步历史记录（按ID）
     * @param {number} recordId
     * @returns {Object|null}
     */
    getDualSyncHistoryById(recordId) {
        const stmt = this.db.prepare(`
            SELECT * FROM dual_sync_history
            WHERE id = ?
            LIMIT 1
        `);
        return stmt.get(recordId) || null;
    }

    // ==================== 双向同步库存快照 ====================

    /**
     * 保存或更新库存快照
     * @param {number} groupId - 组ID
     * @param {string} barcode - 条形码
     * @param {number} stock - 库存值
     * @param {string} productName - 商品名称
     */
    saveDualSyncStockSnapshot(groupId, barcode, stock, productName = null) {
        const now = toLocalISOString();
        
        const stmt = this.db.prepare(`
            INSERT INTO dual_sync_stock_snapshot (
                group_id, barcode, product_name, last_known_stock, last_sync_time, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(group_id, barcode) DO UPDATE SET
                product_name = COALESCE(excluded.product_name, product_name),
                last_known_stock = excluded.last_known_stock,
                last_sync_time = excluded.last_sync_time,
                updated_at = excluded.updated_at
        `);

        stmt.run(groupId, barcode, productName, stock, now, now, now);
    }

    /**
     * 批量保存库存快照
     * @param {number} groupId - 组ID
     * @param {Array<Object>} snapshots - 快照列表 [{barcode, stock, productName}]
     */
    saveDualSyncStockSnapshotBatch(groupId, snapshots) {
        const now = toLocalISOString();
        
        const stmt = this.db.prepare(`
            INSERT INTO dual_sync_stock_snapshot (
                group_id, barcode, product_name, last_known_stock, last_sync_time, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(group_id, barcode) DO UPDATE SET
                product_name = COALESCE(excluded.product_name, product_name),
                last_known_stock = excluded.last_known_stock,
                last_sync_time = excluded.last_sync_time,
                updated_at = excluded.updated_at
        `);

        const transaction = this.db.transaction((items) => {
            for (const item of items) {
                stmt.run(groupId, item.barcode, item.productName || null, item.stock, now, now, now);
            }
        });

        transaction(snapshots);
        console.log(`[Database] 批量保存库存快照: ${snapshots.length} 条`);
    }

    /**
     * 获取库存快照
     * @param {number} groupId - 组ID
     * @param {string} barcode - 条形码（可选）
     * @returns {Object|Array} 单个快照或快照列表
     */
    getDualSyncStockSnapshot(groupId, barcode = null) {
        if (barcode) {
            const stmt = this.db.prepare(`
                SELECT * FROM dual_sync_stock_snapshot
                WHERE group_id = ? AND barcode = ?
            `);
            return stmt.get(groupId, barcode);
        } else {
            const stmt = this.db.prepare(`
                SELECT * FROM dual_sync_stock_snapshot
                WHERE group_id = ?
            `);
            return stmt.all(groupId);
        }
    }

    /**
     * 获取库存快照映射
     * @param {number} groupId - 组ID
     * @returns {Object} 映射对象 {barcode: {stock, productName}}
     */
    getDualSyncStockSnapshotMap(groupId) {
        const stmt = this.db.prepare(`
            SELECT barcode, last_known_stock, product_name
            FROM dual_sync_stock_snapshot
            WHERE group_id = ?
        `);
        
        const rows = stmt.all(groupId);
        const mapping = {};
        for (const row of rows) {
            mapping[row.barcode] = {
                stock: row.last_known_stock,
                productName: row.product_name
            };
        }
        return mapping;
    }

    /**
     * 删除双向同步组的所有库存快照
     * @param {number} groupId - 组ID
     */
    clearDualSyncStockSnapshots(groupId) {
        const stmt = this.db.prepare('DELETE FROM dual_sync_stock_snapshot WHERE group_id = ?');
        stmt.run(groupId);
        console.log(`[Database] 清空双向同步组 ${groupId} 的库存快照`);
    }

    // ==================== 双向同步追溯记录 ====================

    /**
     * 批量写入追溯记录
     * @param {number} groupId - 双向同步组ID
     * @param {number} syncRunId - 同步运行ID (dual_sync_history.id)
     * @param {string} syncType - 同步类型 'full' / 'incremental'
     * @param {Array<Object>} traces - 追溯记录列表
     */
    addDualSyncTraceBatch(groupId, syncRunId, syncType, traces) {
        if (!traces || traces.length === 0) return;

        const now = toLocalISOString();
        const stmt = this.db.prepare(`
            INSERT INTO dual_sync_trace (
                group_id, sync_run_id, sync_type, direction, barcode, product_name,
                source_records_count, source_total_change,
                was_filtered, was_deduplicated, filter_reason,
                current_stock, target_stock, apply_result, error_msg,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const transaction = this.db.transaction((rows) => {
            for (const row of rows) {
                stmt.run(
                    groupId,
                    syncRunId,
                    syncType,
                    row.direction || null,
                    row.barcode,
                    row.productName || null,
                    row.sourceRecordsCount ?? null,
                    row.sourceTotalChange ?? null,
                    row.wasFiltered ? 1 : 0,
                    row.wasDeduplicated ? 1 : 0,
                    row.filterReason || null,
                    row.currentStock ?? null,
                    row.targetStock ?? null,
                    row.applyResult || null,
                    row.errorMsg || null,
                    now
                );
            }
        });

        transaction(traces);
        console.log(`[Database] 批量写入追溯记录: ${traces.length} 条`);
    }

    /**
     * 按条形码查询追溯记录（自动从最近全量同步开始）
     * @param {number} groupId - 双向同步组ID
     * @param {string} barcode - 条形码
     * @param {number} limit - 最大返回数量
     * @returns {Object} { fullSyncBaseline, incrementalRecords, isFullSyncOlderThan30Days }
     */
    getDualSyncTraceByBarcode(groupId, barcode, limit = 500) {
        // 1. 查找该商品最近一次全量同步的基准记录
        const fullSyncStmt = this.db.prepare(`
            SELECT * FROM dual_sync_trace
            WHERE group_id = ? AND barcode = ? AND sync_type = 'full'
            ORDER BY created_at DESC
            LIMIT 1
        `);
        const fullSyncBaseline = fullSyncStmt.get(groupId, barcode) || null;

        // 2. 判断全量同步是否超过30天
        let isFullSyncOlderThan30Days = false;
        let sinceTime = null;
        const thirtyDaysAgo = toLocalISOString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

        if (fullSyncBaseline) {
            if (fullSyncBaseline.created_at < thirtyDaysAgo) {
                isFullSyncOlderThan30Days = true;
                sinceTime = thirtyDaysAgo;
            } else {
                sinceTime = fullSyncBaseline.created_at;
            }
        } else {
            // 没有全量同步记录，从30天前开始查
            isFullSyncOlderThan30Days = true;
            sinceTime = thirtyDaysAgo;
        }

        // 3. 查询增量同步记录
        const incrStmt = this.db.prepare(`
            SELECT * FROM dual_sync_trace
            WHERE group_id = ? AND barcode = ? AND sync_type = 'incremental'
              AND created_at >= ?
            ORDER BY created_at ASC
            LIMIT ?
        `);
        const incrementalRecords = incrStmt.all(groupId, barcode, sinceTime, limit);

        return {
            fullSyncBaseline,
            incrementalRecords,
            isFullSyncOlderThan30Days
        };
    }

    /**
     * 按同步批次查询追溯记录
     * @param {number} groupId - 双向同步组ID
     * @param {number} syncRunId - 同步运行ID
     * @returns {Array<Object>} 追溯记录列表
     */
    getDualSyncTraceByRun(groupId, syncRunId) {
        const stmt = this.db.prepare(`
            SELECT * FROM dual_sync_trace
            WHERE group_id = ? AND sync_run_id = ?
            ORDER BY barcode, direction
        `);
        return stmt.all(groupId, syncRunId);
    }

    /**
     * 获取该商品最近一次全量同步的基准库存
     * @param {number} groupId - 双向同步组ID
     * @param {string} barcode - 条形码
     * @returns {Object|null} 基准记录
     */
    getLastFullSyncTraceForBarcode(groupId, barcode) {
        const stmt = this.db.prepare(`
            SELECT * FROM dual_sync_trace
            WHERE group_id = ? AND barcode = ? AND sync_type = 'full'
            ORDER BY created_at DESC
            LIMIT 1
        `);
        return stmt.get(groupId, barcode) || null;
    }

    /**
     * 清理指定天数前的追溯记录
     * @param {number} daysToKeep - 保留天数
     * @returns {number} 删除的记录数
     */
    cleanupOldDualSyncTrace(daysToKeep = 30) {
        const cutoff = toLocalISOString(new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000));
        const stmt = this.db.prepare(`
            DELETE FROM dual_sync_trace
            WHERE created_at < ?
        `);
        const result = stmt.run(cutoff);
        console.log(`[Database] 清理 ${daysToKeep} 天前的追溯记录: ${result.changes} 条`);
        return result.changes;
    }

    /**
     * 获取双向同步组的最近一次全量同步时间
     * @param {number} groupId - 双向同步组ID
     * @returns {string|null} 全量同步时间
     */
    getLastFullSyncTime(groupId) {
        const stmt = this.db.prepare(`
            SELECT last_full_sync_time FROM dual_sync_groups
            WHERE id = ?
        `);
        const row = stmt.get(groupId);
        return row ? row.last_full_sync_time : null;
    }

    /**
     * 按条形码和时间范围查询追溯记录（用于商品对账功能）
     * @param {number} groupId - 双向同步组ID
     * @param {string} barcode - 商品条形码
     * @param {string} startTime - 开始时间（ISO格式）
     * @param {string} endTime - 结束时间（ISO格式）
     * @param {string|null} direction - 同步方向过滤（'A->B' 或 'B->A'），null表示全部
     * @returns {Array<Object>} 追溯记录列表
     */
    getTraceRecordsByBarcodeAndTimeRange(groupId, barcode, startTime, endTime, direction = null) {
        let sql = `
            SELECT * FROM dual_sync_trace
            WHERE group_id = ? AND barcode = ?
              AND created_at >= ? AND created_at <= ?
        `;
        const params = [groupId, barcode, startTime, endTime];

        if (direction) {
            sql += ` AND direction = ?`;
            params.push(direction);
        }

        sql += ` ORDER BY created_at ASC`;

        const stmt = this.db.prepare(sql);
        return stmt.all(...params);
    }

    /**
     * 获取双向同步组的基线时间信息（用于商品对账功能）
     * @param {number} groupId - 双向同步组ID
     * @returns {Object|null} 包含基线时间的对象
     */
    getDualSyncGroupBaselineInfo(groupId) {
        const stmt = this.db.prepare(`
            SELECT 
                full_sync_a_baseline_time,
                full_sync_b_baseline_time,
                last_a_query_time,
                last_b_query_time,
                last_full_sync_time,
                a_eleme_cookies,
                a_eleme_seller_id,
                a_eleme_store_id,
                a_qnh_cookies,
                a_qnh_store_id,
                b_eleme_cookies,
                b_eleme_seller_id,
                b_eleme_store_id,
                b_qnh_cookies,
                b_qnh_store_id
            FROM dual_sync_groups
            WHERE id = ?
        `);
        return stmt.get(groupId);
    }
}

module.exports = SyncDatabase;

