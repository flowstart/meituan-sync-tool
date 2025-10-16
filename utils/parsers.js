/**
 * 数据解析器模块
 * 包含饿了么和牵牛花的Excel和数据解析功能
 */

const XLSX = require('xlsx');

/**
 * 饿了么数据解析器
 */
class ElemeParser {
    /**
     * 解析商品Excel文件
     * @param {string} filePath - Excel文件路径
     * @returns {Array<Object>} 商品列表
     */
    static parseExcel(filePath) {
        try {
            console.log(`[ElemeParser] 开始解析Excel: ${filePath}`);

            // 读取Excel文件
            const workbook = XLSX.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];

            // 转换为JSON
            const rawData = XLSX.utils.sheet_to_json(worksheet);

            console.log(`[ElemeParser] 读取到 ${rawData.length} 行数据`);

            // 过滤掉说明行和解析数据
            const products = [];
            for (const row of rawData) {
                try {
                    // 过滤说明行
                    if (row['商品ID'] === '平台根据商品及商品所处门店所生成的唯一编码') {
                        continue;
                    }

                    const product = {
                        product_id: String(row['商品ID'] || ''),
                        sku_id: String(row['API专用ID'] || ''),
                        barcode: String(row['商品条形码'] || ''),
                        name: String(row['商品名称'] || ''),
                        spec_name: row['规格'] ? String(row['规格']) : '',
                        stock: row['库存'] !== undefined && row['库存'] !== null ? parseInt(row['库存']) : 0,
                        price: row['售价'] !== undefined && row['售价'] !== null ? parseFloat(row['售价']) : 0.0,
                        status: String(row['商品状态'] || ''),
                        category_1: row['商品一级类目'] ? String(row['商品一级类目']) : '',
                        category_2: row['商品二级类目'] ? String(row['商品二级类目']) : '',
                        category_3: row['商品三级类目'] ? String(row['商品三级类目']) : ''
                    };

                    products.push(product);
                } catch (error) {
                    console.warn(`[ElemeParser] 解析行失败:`, error);
                    continue;
                }
            }

            console.log(`[ElemeParser] 成功解析 ${products.length} 个商品`);
            return products;

        } catch (error) {
            console.error('[ElemeParser] 解析Excel失败:', error);
            throw error;
        }
    }

    /**
     * 解析单条操作记录
     * @param {Object} opLog - 操作记录原始数据
     * @returns {Object|null} 解析后的数据，如果无法解析返回null
     */
    static parseOperationLog(opLog) {
        try {
            const opType = opLog.opType || '';
            // 可能出现多个条形码（多规格一起变更），形如 "693...,693...,697..."
            // 统一拆分为数组，保留第一个条形码在barcode字段以兼容旧逻辑
            const rawBarcode = (opLog.barCode || '').toString();
            const barcodeList = rawBarcode
                .split(/[，,、\s]+/)
                .map(s => s.trim())
                .filter(s => !!s);
            const barcode = barcodeList.length > 0 ? barcodeList[0] : '';
            const opContent = opLog.opContent || '';
            const opTimeStr = opLog.opTime || '';

            // 解析操作时间
            let opTime = null;
            if (opTimeStr) {
                try {
                    opTime = new Date(opTimeStr);
                } catch (e) {
                    console.warn(`[ElemeParser] 解析时间失败: ${opTimeStr}`);
                }
            }

            const result = {
                barcode: barcode,
                barcodes: barcodeList,
                biz_id: opLog.bizId || '',
                ele_biz_id: opLog.eleBizId || '',
                op_type: opType,
                op_time: opTime,
                op_user: opLog.opUser || '',
                op_content: opContent,
                stock_change: null
            };

            // 如果是修改门店商品，解析库存变化
            if (opType === '修改门店商品' && opContent.includes('库存')) {
                const stockChange = ElemeParser.parseStockChange(opContent);
                if (stockChange) {
                    result.stock_change = stockChange;
                }
            }

            return result;

        } catch (error) {
            console.warn('[ElemeParser] 解析操作记录失败:', error);
            return null;
        }
    }

    /**
     * 从操作内容中解析库存变化
     * @param {string} opContent - 操作内容（HTML格式）
     * @returns {Object|null} {"old_stock": int, "new_stock": int, "change": int}
     */
    static parseStockChange(opContent) {
        try {
            // 提取原库存和新库存
            const patternOld = /原信息.*?库存：(\d+)/;
            const patternNew = /新信息.*?库存：(\d+)/;

            const oldMatch = opContent.match(patternOld);
            const newMatch = opContent.match(patternNew);

            if (oldMatch && newMatch) {
                const oldStock = parseInt(oldMatch[1]);
                const newStock = parseInt(newMatch[1]);

                return {
                    old_stock: oldStock,
                    new_stock: newStock,
                    change: newStock - oldStock
                };
            }

            return null;

        } catch (error) {
            console.debug('[ElemeParser] 解析库存变化失败:', error);
            return null;
        }
    }

    /**
     * 批量解析操作记录
     * @param {Object} logsData - 操作记录响应数据
     * @returns {Array<Object>} 解析后的记录列表
     */
    static parseOperationLogs(logsData) {
        const logs = logsData.data || [];
        if (logs.length === 0) {
            console.warn('[ElemeParser] 操作记录为空');
            return [];
        }

        const total = logsData.total || 0;
        console.log(`[ElemeParser] 解析 ${logs.length} 条操作记录（总计 ${total} 条）`);

        const parsedLogs = [];
        for (const log of logs) {
            const parsed = ElemeParser.parseOperationLog(log);
            if (parsed) {
                // 只保留有库存变化的记录
                if (parsed.stock_change) {
                    parsedLogs.push(parsed);
                }
            }
        }

        console.log(`[ElemeParser] 解析出 ${parsedLogs.length} 条有效的库存变化记录`);
        return parsedLogs;
    }

    /**
     * 按条形码分组并汇总库存变化
     * @param {Array<Object>} parsedLogs - 解析后的操作记录
     * @returns {Object} {barcode: {"final_stock": int, "total_change": int, "logs": [...]}}
     */
    static groupStockChangesByBarcode(parsedLogs) {
        const grouped = {};

        for (const log of parsedLogs) {
            const barcodes = Array.isArray(log.barcodes) && log.barcodes.length > 0
                ? log.barcodes
                : (log.barcode ? [log.barcode] : []);

            for (const bc of barcodes) {
                if (!bc) continue;
                if (!grouped[bc]) {
                    grouped[bc] = {
                        final_stock: log.stock_change ? log.stock_change.new_stock : null,
                        total_change: log.stock_change ? log.stock_change.change : 0,
                        change_count: 1,
                        logs: []
                    };
                } else {
                    // 更新最终库存（取最新的）
                    if (log.op_time && log.stock_change) {
                        grouped[bc].final_stock = log.stock_change.new_stock;
                    }
                    // 累计变化量与次数
                    if (log.stock_change) {
                        grouped[bc].total_change += log.stock_change.change;
                    }
                    grouped[bc].change_count += 1;
                }

                grouped[bc].logs.push(log);
            }
        }

        console.log(`[ElemeParser] 共涉及 ${Object.keys(grouped).length} 个商品的库存变化`);
        return grouped;
    }
}

/**
 * 牵牛花数据解析器
 */
class QianniuhuaParser {
    /**
     * 解析牵牛花导出的Excel文件，提取条形码和SKU ID的映射
     * @param {string} excelPath - Excel文件路径
     * @returns {Object} {条形码: SKU ID}
     */
    static parseExportExcel(excelPath) {
        console.log(`[QianniuhuaParser] 开始解析牵牛花Excel: ${excelPath}`);

        try {
            // 读取Excel文件
            const workbook = XLSX.readFile(excelPath, { 
                cellDates: true,
                cellNF: false,
                cellText: false
            });

            // 使用第一个sheet（门店商品）
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];

            // 转换为JSON
            const rawData = XLSX.utils.sheet_to_json(worksheet);

            if (rawData.length === 0) {
                console.warn('[QianniuhuaParser] Excel文件为空');
                return {};
            }

            // 读取表头，找到条形码和SKU ID列
            const headers = Object.keys(rawData[0]);
            console.log(`[QianniuhuaParser] 找到的列: ${headers.join(', ')}`);

            // 查找关键列
            let upcCol = null;
            let skuIdCol = null;

            for (const header of headers) {
                const headerLower = header.toLowerCase();
                if (['upc', '条形码', '商品条码'].includes(headerLower) || headerLower.includes('upc')) {
                    upcCol = header;
                }
                if (['skuid', 'sku id', 'skuid', 'sku_id'].includes(headerLower) || headerLower.includes('skuid')) {
                    skuIdCol = header;
                }
            }

            if (!upcCol || !skuIdCol) {
                console.error(`[QianniuhuaParser] 未找到必需的列: upc列=${upcCol}, skuId列=${skuIdCol}`);
                console.error(`[QianniuhuaParser] 可用列: ${headers.join(', ')}`);
                return {};
            }

            console.log(`[QianniuhuaParser] 找到列: upc=${upcCol}, skuId=${skuIdCol}`);

            // 解析数据
            const mapping = {};
            let rowCount = 0;

            for (const row of rawData) {
                rowCount++;

                try {
                    const upc = row[upcCol];
                    const skuId = row[skuIdCol];

                    if (upc && skuId) {
                        // 确保都是字符串
                        const upcStr = String(upc).trim();
                        const skuIdStr = String(skuId).trim();

                        if (upcStr && skuIdStr) {
                            mapping[upcStr] = skuIdStr;
                        }
                    }
                } catch (error) {
                    console.warn(`[QianniuhuaParser] 解析第${rowCount}行失败:`, error);
                    continue;
                }
            }

            console.log(`[QianniuhuaParser] 解析完成，共 ${rowCount} 行，提取 ${Object.keys(mapping).length} 个条形码映射`);

            return mapping;

        } catch (error) {
            console.error('[QianniuhuaParser] 解析Excel失败:', error);
            return {};
        }
    }
}

module.exports = {
    ElemeParser,
    QianniuhuaParser
};

