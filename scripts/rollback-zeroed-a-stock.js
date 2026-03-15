#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');
const createQnhClient = require('../api/qnh-client-factory');

const DEFAULT_DB_PATH = '/Users/jonelee/Library/Application Support/meituan-sync-tool/sync.db';
const DEFAULT_GROUP_ID = 7;
const DEFAULT_SYNC_RUN_ID = 1348;
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '../../docs/bugfix');
const QUERY_BATCH_SIZE = 200;
const UPDATE_BATCH_SIZE = 10;

function parseArgs(argv) {
    const args = {
        groupId: DEFAULT_GROUP_ID,
        syncRunId: DEFAULT_SYNC_RUN_ID,
        dbPath: DEFAULT_DB_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        execute: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--execute') {
            args.execute = true;
            continue;
        }
        if (arg === '--group-id') {
            args.groupId = Number(argv[++i]);
            continue;
        }
        if (arg === '--sync-run-id') {
            args.syncRunId = Number(argv[++i]);
            continue;
        }
        if (arg === '--db-path') {
            args.dbPath = argv[++i];
            continue;
        }
        if (arg === '--output-dir') {
            args.outputDir = argv[++i];
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printHelpAndExit(0);
        }
        throw new Error(`未知参数: ${arg}`);
    }

    if (!Number.isFinite(args.groupId) || args.groupId <= 0) {
        throw new Error('groupId 非法');
    }
    if (!Number.isFinite(args.syncRunId) || args.syncRunId <= 0) {
        throw new Error('syncRunId 非法');
    }

    return args;
}

function printHelpAndExit(code = 0) {
    console.log(`
用法:
  node scripts/rollback-zeroed-a-stock.js [--group-id 7] [--sync-run-id 1348] [--db-path ".../sync.db"] [--output-dir ".../docs/bugfix"] [--execute]

说明:
  1. 默认只预演，不真正回滚
  2. 只处理指定事故批次里 "B->A success 且 current_stock > 0 且 target_stock = 0" 的记录
  3. 回滚前会再次查询 A 门店当前牵牛花库存:
     - 当前仍为 0: 才执行回滚
     - 当前不是 0: 跳过，并记录到 Excel
  4. 输出 Excel 结果表到 docs/bugfix
`);
    process.exit(code);
}

function sqliteJson(dbPath, sql) {
    const output = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' });
    return output.trim() ? JSON.parse(output) : [];
}

function chunk(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function buildOutputPath(outputDir, groupId, syncRunId) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(outputDir, `rollback_group${groupId}_run${syncRunId}_${stamp}.xlsx`);
}

function addSheet(workbook, name, rows) {
    const safeRows = rows.length > 0 ? rows : [{ note: '无数据' }];
    const sheet = XLSX.utils.json_to_sheet(safeRows);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
}

async function queryCurrentStockMap(client, storeId, barcodes) {
    const stockMap = {};
    for (const batch of chunk(barcodes, QUERY_BATCH_SIZE)) {
        const partial = await client.getStockByBarcodes(storeId, batch);
        Object.assign(stockMap, partial || {});
    }
    return stockMap;
}

async function applyRollback(client, storeId, rollbackCandidates) {
    const results = [];
    let successCount = 0;
    let failedCount = 0;

    for (const batch of chunk(rollbackCandidates, UPDATE_BATCH_SIZE)) {
        const updates = batch.map(item => ({
            skuId: item.skuId,
            newQuantity: item.rollbackToStock,
            comment: `事故回滚(run=${item.syncRunId}, barcode=${item.barcode})`
        }));

        try {
            const success = await client.batchUpdateMultipleSkus(
                storeId,
                updates,
                `事故回滚(run=${batch[0].syncRunId})`
            );
            if (success) {
                for (const item of batch) {
                    successCount++;
                    results.push({
                        ...item,
                        status: 'rolled_back',
                        message: '回滚成功'
                    });
                }
            } else {
                for (const item of batch) {
                    failedCount++;
                    results.push({
                        ...item,
                        status: 'rollback_failed',
                        message: '牵牛花批量更新返回失败'
                    });
                }
            }
        } catch (error) {
            for (const item of batch) {
                failedCount++;
                results.push({
                    ...item,
                    status: 'rollback_failed',
                    message: error.message
                });
            }
        }
    }

    return { results, successCount, failedCount };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    ensureDir(args.outputDir);

    const groupRows = sqliteJson(args.dbPath, `
        SELECT id, name, a_qnh_store_id, a_qnh_store_name, a_qnh_cookies
        FROM dual_sync_groups
        WHERE id = ${args.groupId}
        LIMIT 1;
    `);
    if (groupRows.length === 0) {
        throw new Error(`未找到双向同步组: ${args.groupId}`);
    }
    const group = groupRows[0];
    if (!group.a_qnh_store_id || !group.a_qnh_cookies) {
        throw new Error(`组 ${args.groupId} 缺少 A 门店牵牛花配置`);
    }

    const candidateRows = sqliteJson(args.dbPath, `
        SELECT barcode, current_stock, target_stock, source_total_change, created_at
        FROM dual_sync_trace
        WHERE group_id = ${args.groupId}
          AND sync_run_id = ${args.syncRunId}
          AND direction = 'B->A'
          AND apply_result = 'success'
          AND current_stock > 0
          AND target_stock = 0
        ORDER BY current_stock DESC, barcode ASC;
    `);
    if (candidateRows.length === 0) {
        throw new Error(`未找到可回滚记录: group=${args.groupId}, run=${args.syncRunId}`);
    }

    const qnhClient = createQnhClient(null, { cookies: group.a_qnh_cookies });
    const barcodes = candidateRows.map(row => row.barcode);
    const currentStockMap = await queryCurrentStockMap(qnhClient, group.a_qnh_store_id, barcodes);

    const reviewRows = [];
    const rollbackCandidates = [];
    const skippedRows = [];

    for (const row of candidateRows) {
        const live = currentStockMap[row.barcode];
        const liveStock = live && typeof live.stock === 'number' ? live.stock : null;
        const skuId = live && live.skuId ? live.skuId : null;

        const base = {
            syncRunId: args.syncRunId,
            barcode: row.barcode,
            accidentWrittenAt: row.created_at,
            sourceTotalChange: row.source_total_change,
            originalStockBeforeAccident: row.current_stock,
            accidentTargetStock: row.target_stock,
            liveStock,
            skuId
        };

        if (!live || !skuId) {
            skippedRows.push({
                ...base,
                status: 'skipped',
                reason: 'A门店牵牛花当前未查到商品或缺少SKU'
            });
            reviewRows.push(skippedRows[skippedRows.length - 1]);
            continue;
        }

        if (liveStock !== 0) {
            skippedRows.push({
                ...base,
                status: 'skipped',
                reason: '当前库存不是0，按要求不回滚'
            });
            reviewRows.push(skippedRows[skippedRows.length - 1]);
            continue;
        }

        const candidate = {
            ...base,
            rollbackToStock: row.current_stock,
            status: args.execute ? 'pending_execute' : 'dry_run_pending',
            reason: args.execute ? '等待执行回滚' : '预演命中，可回滚'
        };
        rollbackCandidates.push(candidate);
        reviewRows.push(candidate);
    }

    let executionRows = [];
    let rollbackSummary = {
        successCount: 0,
        failedCount: 0
    };

    if (args.execute && rollbackCandidates.length > 0) {
        const execution = await applyRollback(qnhClient, group.a_qnh_store_id, rollbackCandidates);
        executionRows = execution.results;
        rollbackSummary = {
            successCount: execution.successCount,
            failedCount: execution.failedCount
        };
    } else {
        executionRows = rollbackCandidates.map(item => ({
            ...item,
            status: 'dry_run_pending',
            message: '仅预演，未真正执行'
        }));
    }

    const workbook = XLSX.utils.book_new();
    addSheet(workbook, '摘要', [{
        groupId: args.groupId,
        groupName: group.name,
        aStoreId: group.a_qnh_store_id,
        aStoreName: group.a_qnh_store_name || '',
        syncRunId: args.syncRunId,
        execute: args.execute ? 'yes' : 'no',
        candidateCount: candidateRows.length,
        rollbackCandidateCount: rollbackCandidates.length,
        skippedCount: skippedRows.length,
        rollbackSuccessCount: rollbackSummary.successCount,
        rollbackFailedCount: rollbackSummary.failedCount
    }]);
    addSheet(workbook, '检查结果', reviewRows);
    addSheet(workbook, args.execute ? '回滚执行结果' : '预演待回滚', executionRows);
    addSheet(workbook, '跳过记录', skippedRows);

    const outputPath = buildOutputPath(args.outputDir, args.groupId, args.syncRunId);
    XLSX.writeFile(workbook, outputPath);

    console.log(`组: ${group.name} (${args.groupId})`);
    console.log(`A门店: ${group.a_qnh_store_name || ''} (${group.a_qnh_store_id})`);
    console.log(`事故批次: ${args.syncRunId}`);
    console.log(`候选记录: ${candidateRows.length}`);
    console.log(`可回滚记录: ${rollbackCandidates.length}`);
    console.log(`跳过记录: ${skippedRows.length}`);
    if (args.execute) {
        console.log(`回滚成功: ${rollbackSummary.successCount}`);
        console.log(`回滚失败: ${rollbackSummary.failedCount}`);
    } else {
        console.log('当前为预演模式，未执行实际回滚');
    }
    console.log(`结果文件: ${outputPath}`);
}

main().catch(error => {
    console.error('[rollback-zeroed-a-stock] 失败:', error.message);
    process.exit(1);
});
