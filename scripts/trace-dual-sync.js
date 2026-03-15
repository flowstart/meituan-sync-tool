#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');
const { getTraceRecordsByBarcode, readTraceLog } = require('../utils/trace-logger');

const DEFAULT_DB_PATH = '/Users/jonelee/Library/Application Support/meituan-sync-tool/sync.db';
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '../../docs/bugfix');
const DEFAULT_LIMIT = 500;

function printHelpAndExit(code = 0) {
    console.log(`
用法:
  node scripts/trace-dual-sync.js --group-id 7 --barcode 6974312573481 [--include-raw] [--export-excel]
  node scripts/trace-dual-sync.js --group-id 7 --sync-run-id 1348 [--export-excel]

参数:
  --group-id <id>         双向同步组ID，必填
  --barcode <barcode>     按条形码排查（与 --sync-run-id 二选一）
  --sync-run-id <id>      按同步批次排查（与 --barcode 二选一）
  --db-path <path>        sync.db 路径，默认使用本机运行数据
  --data-dir <path>       data 目录路径，默认由 db-path 自动推导
  --limit <n>             条码模式最多读取多少条记录，默认 500
  --include-raw           条码模式输出 JSON 追溯里的原始记录细节
  --export-excel          导出 Excel 到 docs/bugfix
  --output-dir <path>     Excel 输出目录，默认 docs/bugfix
  --help, -h              显示帮助
`);
    process.exit(code);
}

function parseArgs(argv) {
    const args = {
        dbPath: DEFAULT_DB_PATH,
        dataDir: null,
        outputDir: DEFAULT_OUTPUT_DIR,
        includeRaw: false,
        exportExcel: false,
        limit: DEFAULT_LIMIT,
        groupId: null,
        barcode: null,
        syncRunId: null
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') printHelpAndExit(0);
        if (arg === '--include-raw') {
            args.includeRaw = true;
            continue;
        }
        if (arg === '--export-excel') {
            args.exportExcel = true;
            continue;
        }
        if (arg === '--group-id') {
            args.groupId = Number(argv[++i]);
            continue;
        }
        if (arg === '--barcode') {
            args.barcode = String(argv[++i] || '').trim();
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
        if (arg === '--data-dir') {
            args.dataDir = argv[++i];
            continue;
        }
        if (arg === '--output-dir') {
            args.outputDir = argv[++i];
            continue;
        }
        if (arg === '--limit') {
            args.limit = Number(argv[++i]);
            continue;
        }
        throw new Error(`未知参数: ${arg}`);
    }

    if (!Number.isFinite(args.groupId) || args.groupId <= 0) {
        throw new Error('必须提供合法的 --group-id');
    }
    if (!!args.barcode === !!args.syncRunId) {
        throw new Error('--barcode 和 --sync-run-id 必须二选一');
    }
    if (args.syncRunId !== null && (!Number.isFinite(args.syncRunId) || args.syncRunId <= 0)) {
        throw new Error('--sync-run-id 非法');
    }
    if (!Number.isFinite(args.limit) || args.limit <= 0) {
        throw new Error('--limit 非法');
    }
    if (!args.dataDir) {
        args.dataDir = path.join(path.dirname(args.dbPath), 'data');
    }

    return args;
}

function quote(value) {
    if (value === null || value === undefined) return 'NULL';
    return `'${String(value).replace(/'/g, "''")}'`;
}

function sqliteJson(dbPath, sql) {
    const output = execFileSync('sqlite3', ['-json', dbPath, sql], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    });
    return output.trim() ? JSON.parse(output) : [];
}

function sqliteOne(dbPath, sql) {
    return sqliteJson(dbPath, sql)[0] || null;
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function buildOutputPath(outputDir, prefix, suffix) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(outputDir, `${prefix}_${suffix}_${stamp}.xlsx`);
}

function addSheet(workbook, name, rows) {
    const safeRows = rows.length > 0 ? rows : [{ note: '无数据' }];
    const sheet = XLSX.utils.json_to_sheet(safeRows);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function summarizeRunRecords(records) {
    const summary = {};
    for (const record of records) {
        const key = `${record.direction || 'none'}|${record.apply_result || 'none'}`;
        if (!summary[key]) {
            summary[key] = {
                direction: record.direction || '',
                apply_result: record.apply_result || '',
                count: 0,
                filtered_count: 0,
                deduplicated_count: 0,
                zero_target_count: 0,
                positive_to_zero_count: 0
            };
        }
        const item = summary[key];
        item.count++;
        if (Number(record.was_filtered) === 1) item.filtered_count++;
        if (Number(record.was_deduplicated) === 1) item.deduplicated_count++;
        if (record.target_stock === 0) item.zero_target_count++;
        if ((record.current_stock || 0) > 0 && record.target_stock === 0) item.positive_to_zero_count++;
    }
    return Object.values(summary).sort((a, b) => a.direction.localeCompare(b.direction) || a.apply_result.localeCompare(b.apply_result));
}

function findSinceDate(fullSyncBaseline) {
    if (fullSyncBaseline && typeof fullSyncBaseline.created_at === 'string') {
        return fullSyncBaseline.created_at.slice(0, 10);
    }
    const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getGroupInfo(dbPath, groupId) {
    return sqliteOne(dbPath, `
        SELECT id, name, last_full_sync_time, full_sync_a_baseline_time, full_sync_b_baseline_time,
               last_a_query_time, last_b_query_time
        FROM dual_sync_groups
        WHERE id = ${groupId}
        LIMIT 1;
    `);
}

function getBarcodeTrace(dbPath, groupId, barcode, limit) {
    const fullSyncBaseline = sqliteOne(dbPath, `
        SELECT *
        FROM dual_sync_trace
        WHERE group_id = ${groupId} AND barcode = ${quote(barcode)} AND sync_type = 'full'
        ORDER BY created_at DESC
        LIMIT 1;
    `);

    const sinceTime = fullSyncBaseline ? fullSyncBaseline.created_at : null;
    const whereSince = sinceTime ? `AND created_at >= ${quote(sinceTime)}` : '';
    const incrementalRecords = sqliteJson(dbPath, `
        SELECT *
        FROM dual_sync_trace
        WHERE group_id = ${groupId}
          AND barcode = ${quote(barcode)}
          AND sync_type = 'incremental'
          ${whereSince}
        ORDER BY created_at ASC
        LIMIT ${limit};
    `);

    const stockSnapshot = sqliteOne(dbPath, `
        SELECT barcode, product_name, last_known_stock, last_sync_time
        FROM dual_sync_stock_snapshot
        WHERE group_id = ${groupId}
          AND barcode = ${quote(barcode)}
        LIMIT 1;
    `);

    const appliedChanges = sqliteJson(dbPath, `
        SELECT sync_run_id, direction, dest_side, barcode, old_stock, new_stock, applied_at
        FROM dual_sync_applied_change
        WHERE group_id = ${groupId}
          AND barcode = ${quote(barcode)}
        ORDER BY applied_at ASC;
    `);

    const consumedEvents = sqliteJson(dbPath, `
        SELECT sync_run_id, source_side, direction, event_key, record_type, barcode,
               biz_id, ele_biz_id, old_stock, new_stock, change_amount, op_time, consumed_at
        FROM dual_sync_consumed_event
        WHERE group_id = ${groupId}
          AND barcode = ${quote(barcode)}
        ORDER BY consumed_at ASC;
    `);

    return {
        fullSyncBaseline,
        incrementalRecords,
        stockSnapshot,
        appliedChanges,
        consumedEvents
    };
}

function getRunReport(dbPath, dataDir, groupId, syncRunId) {
    const runInfo = sqliteOne(dbPath, `
        SELECT *
        FROM dual_sync_history
        WHERE group_id = ${groupId} AND id = ${syncRunId}
        LIMIT 1;
    `);

    const traceRecords = sqliteJson(dbPath, `
        SELECT *
        FROM dual_sync_trace
        WHERE group_id = ${groupId} AND sync_run_id = ${syncRunId}
        ORDER BY direction ASC, barcode ASC, id ASC;
    `);

    const appliedChanges = sqliteJson(dbPath, `
        SELECT *
        FROM dual_sync_applied_change
        WHERE group_id = ${groupId} AND sync_run_id = ${syncRunId}
        ORDER BY dest_side ASC, barcode ASC, id ASC;
    `);

    const consumedEvents = sqliteJson(dbPath, `
        SELECT *
        FROM dual_sync_consumed_event
        WHERE group_id = ${groupId} AND sync_run_id = ${syncRunId}
        ORDER BY source_side ASC, barcode ASC, id ASC;
    `);

    const traceDetail = readTraceLog(dataDir, groupId, syncRunId);

    return {
        runInfo,
        traceRecords,
        appliedChanges,
        consumedEvents,
        traceDetail,
        runSummary: summarizeRunRecords(traceRecords)
    };
}

function printBarcodeReport(groupInfo, barcodeReport, rawDetails, args) {
    console.log(`组: ${groupInfo.name} (${groupInfo.id})`);
    console.log(`条码: ${args.barcode}`);
    console.log(`最近全量: ${groupInfo.last_full_sync_time || '无'}`);
    if (barcodeReport.fullSyncBaseline) {
        console.log(`全量基线: ${barcodeReport.fullSyncBaseline.created_at} | ${barcodeReport.fullSyncBaseline.current_stock} -> ${barcodeReport.fullSyncBaseline.target_stock} | ${barcodeReport.fullSyncBaseline.apply_result}`);
    } else {
        console.log('全量基线: 未找到');
    }
    if (barcodeReport.stockSnapshot) {
        console.log(`当前快照: ${barcodeReport.stockSnapshot.last_known_stock} @ ${barcodeReport.stockSnapshot.last_sync_time}`);
    } else {
        console.log('当前快照: 未找到');
    }
    console.log(`增量记录数: ${barcodeReport.incrementalRecords.length}`);
    console.log(`指纹记录数: ${barcodeReport.appliedChanges.length}`);
    console.log(`已消费事件数: ${barcodeReport.consumedEvents.length}`);
    if (barcodeReport.incrementalRecords.length > 0) {
        console.log('增量时间线:');
        for (const record of barcodeReport.incrementalRecords) {
            console.log(`  [${record.created_at}] ${record.direction || '-'} ${record.apply_result || '-'} | change=${record.source_total_change ?? '-'} | ${record.current_stock ?? '-'} -> ${record.target_stock ?? '-'}${record.filter_reason ? ` | ${record.filter_reason}` : ''}${record.error_msg ? ` | err=${record.error_msg}` : ''}`);
        }
    }
    if (barcodeReport.appliedChanges.length > 0) {
        console.log('指纹记录:');
        for (const item of barcodeReport.appliedChanges) {
            console.log(`  [${item.applied_at}] ${item.direction || '-'} dest=${item.dest_side} | ${item.old_stock} -> ${item.new_stock}`);
        }
    }
    if (barcodeReport.consumedEvents.length > 0) {
        console.log('已消费事件:');
        for (const item of barcodeReport.consumedEvents) {
            console.log(`  [${item.consumed_at}] source=${item.source_side} ${item.direction || '-'} | ${item.record_type || '-'} | ${item.old_stock} -> ${item.new_stock} | change=${item.change_amount ?? '-'} | op=${item.op_time}`);
        }
    }
    if (args.includeRaw && rawDetails) {
        console.log(`原始记录: ${rawDetails.rawRecords.length} | 被过滤: ${rawDetails.filteredRecords.length} | 被去重: ${rawDetails.deduplicatedRecords.length} | 已落地: ${rawDetails.appliedRecords.length}`);
        if (rawDetails.rawRecords.length > 0) {
            console.log('原始记录明细:');
            for (const record of rawDetails.rawRecords) {
                console.log(`  [${record.syncTime}] side=${record.side} | ${record.opTimeIso || record.opTime || '-'} | ${record.oldStock} -> ${record.newStock} | change=${record.change} | ${record.opUser || ''}`);
            }
        }
        if (rawDetails.filteredRecords.length > 0) {
            console.log('被过滤记录明细:');
            for (const record of rawDetails.filteredRecords) {
                console.log(`  [${record.syncTime}] side=${record.side} | ${record.opTimeIso || record.opTime || '-'} | ${record.oldStock} -> ${record.newStock} | ${record.filterReason || ''}`);
            }
        }
        if (rawDetails.deduplicatedRecords.length > 0) {
            console.log('被去重记录明细:');
            for (const record of rawDetails.deduplicatedRecords) {
                console.log(`  [${record.syncTime}] side=${record.side} | ${record.opTimeIso || record.opTime || '-'} | ${record.oldStock} -> ${record.newStock} | ${record.filterReason || ''}`);
            }
        }
    }
}

function printRunReport(groupInfo, runReport, args) {
    console.log(`组: ${groupInfo.name} (${groupInfo.id})`);
    console.log(`批次: ${args.syncRunId}`);
    if (!runReport.runInfo) {
        console.log('批次不存在');
        return;
    }
    console.log(`类型: ${runReport.runInfo.sync_type}`);
    console.log(`时间: ${runReport.runInfo.start_time} ~ ${runReport.runInfo.end_time || '-'}`);
    console.log(`状态: ${runReport.runInfo.status}`);
    console.log(`追溯记录数: ${runReport.traceRecords.length}`);
    console.log(`指纹记录数: ${runReport.appliedChanges.length}`);
    console.log(`已消费事件数: ${runReport.consumedEvents.length}`);
    console.log('方向汇总:');
    for (const row of runReport.runSummary) {
        console.log(`  ${row.direction || '-'} / ${row.apply_result || '-'}: ${row.count} 条, filtered=${row.filtered_count}, dedup=${row.deduplicated_count}, target0=${row.zero_target_count}, positive->0=${row.positive_to_zero_count}`);
    }
    const suspicious = runReport.traceRecords
        .filter(item => item.apply_result === 'success' && (item.current_stock || 0) > 0 && item.target_stock === 0)
        .slice(0, 30);
    if (suspicious.length > 0) {
        console.log('可疑写入样本(前30条):');
        for (const item of suspicious) {
            console.log(`  ${item.barcode} | ${item.direction || '-'} | change=${item.source_total_change ?? '-'} | ${item.current_stock} -> ${item.target_stock} | ${item.created_at}`);
        }
    }
}

function exportBarcodeExcel(groupInfo, barcodeReport, rawDetails, args) {
    ensureDir(args.outputDir);
    const wb = XLSX.utils.book_new();
    addSheet(wb, '摘要', [{
        groupId: groupInfo.id,
        groupName: groupInfo.name,
        barcode: args.barcode,
        lastFullSyncTime: groupInfo.last_full_sync_time || '',
        fullSyncBaselineTime: barcodeReport.fullSyncBaseline ? barcodeReport.fullSyncBaseline.created_at : '',
        fullSyncBaselineStock: barcodeReport.fullSyncBaseline ? barcodeReport.fullSyncBaseline.target_stock : '',
        currentSnapshotStock: barcodeReport.stockSnapshot ? barcodeReport.stockSnapshot.last_known_stock : '',
        currentSnapshotTime: barcodeReport.stockSnapshot ? barcodeReport.stockSnapshot.last_sync_time : '',
        incrementalCount: barcodeReport.incrementalRecords.length,
        appliedFingerprintCount: barcodeReport.appliedChanges.length,
        consumedEventCount: barcodeReport.consumedEvents.length
    }]);
    addSheet(wb, '全量基线', barcodeReport.fullSyncBaseline ? [barcodeReport.fullSyncBaseline] : []);
    addSheet(wb, '增量追溯', barcodeReport.incrementalRecords);
    addSheet(wb, '指纹记录', barcodeReport.appliedChanges);
    addSheet(wb, '已消费事件', barcodeReport.consumedEvents);
    if (args.includeRaw && rawDetails) {
        addSheet(wb, '原始记录', rawDetails.rawRecords);
        addSheet(wb, '过滤记录', rawDetails.filteredRecords);
        addSheet(wb, '去重记录', rawDetails.deduplicatedRecords);
        addSheet(wb, '落地记录', rawDetails.appliedRecords);
    }
    const outputPath = buildOutputPath(args.outputDir, `trace_group${groupInfo.id}_barcode`, args.barcode);
    XLSX.writeFile(wb, outputPath);
    return outputPath;
}

function exportRunExcel(groupInfo, runReport, args) {
    ensureDir(args.outputDir);
    const wb = XLSX.utils.book_new();
    addSheet(wb, '摘要', [{
        groupId: groupInfo.id,
        groupName: groupInfo.name,
        syncRunId: args.syncRunId,
        syncType: runReport.runInfo ? runReport.runInfo.sync_type : '',
        status: runReport.runInfo ? runReport.runInfo.status : '',
        startTime: runReport.runInfo ? runReport.runInfo.start_time : '',
        endTime: runReport.runInfo ? runReport.runInfo.end_time : '',
        traceRecordCount: runReport.traceRecords.length,
        appliedFingerprintCount: runReport.appliedChanges.length,
        consumedEventCount: runReport.consumedEvents.length
    }]);
    addSheet(wb, '方向汇总', runReport.runSummary);
    addSheet(wb, '追溯记录', runReport.traceRecords);
    addSheet(wb, '指纹记录', runReport.appliedChanges);
    addSheet(wb, '已消费事件', runReport.consumedEvents);
    if (runReport.traceDetail) {
        addSheet(wb, 'JSON_查询窗口', [runReport.traceDetail.queryWindow || {}]);
        addSheet(wb, 'JSON_A原始记录', (runReport.traceDetail.rawRecords && runReport.traceDetail.rawRecords.A) || []);
        addSheet(wb, 'JSON_B原始记录', (runReport.traceDetail.rawRecords && runReport.traceDetail.rawRecords.B) || []);
    }
    const outputPath = buildOutputPath(args.outputDir, `trace_group${groupInfo.id}_run`, String(args.syncRunId));
    XLSX.writeFile(wb, outputPath);
    return outputPath;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const groupInfo = getGroupInfo(args.dbPath, args.groupId);
    if (!groupInfo) {
        throw new Error(`未找到双向同步组: ${args.groupId}`);
    }

    if (args.barcode) {
        const barcodeReport = getBarcodeTrace(args.dbPath, args.groupId, args.barcode, args.limit);
        const rawDetails = args.includeRaw
            ? getTraceRecordsByBarcode(args.dataDir, args.groupId, args.barcode, findSinceDate(barcodeReport.fullSyncBaseline), args.limit)
            : null;

        printBarcodeReport(groupInfo, barcodeReport, rawDetails, args);

        if (args.exportExcel) {
            const outputPath = exportBarcodeExcel(groupInfo, barcodeReport, rawDetails, args);
            console.log(`Excel: ${outputPath}`);
        }
        return;
    }

    const runReport = getRunReport(args.dbPath, args.dataDir, args.groupId, args.syncRunId);
    printRunReport(groupInfo, runReport, args);

    if (args.exportExcel) {
        const outputPath = exportRunExcel(groupInfo, runReport, args);
        console.log(`Excel: ${outputPath}`);
    }
}

main().catch(error => {
    console.error('[trace-dual-sync] 失败:', error.message);
    process.exit(1);
});
