/**
 * 追溯查询 API 路由
 */

const express = require('express');
const router = express.Router();

// 按条形码查询追溯记录
router.get('/barcode/:barcode', (req, res) => {
    try {
        const groupId = parseInt(req.query.groupId, 10);
        const barcode = req.params.barcode;
        const limit = parseInt(req.query.limit, 10) || 500;
        
        if (!groupId) {
            return res.status(400).json({ success: false, error: '缺少 groupId 参数' });
        }
        
        const result = req.db.getTraceByBarcode(groupId, barcode, limit);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取有追溯记录的条形码列表
router.get('/barcodes', (req, res) => {
    try {
        const groupId = parseInt(req.query.groupId, 10);
        const limit = parseInt(req.query.limit, 10) || 100;
        
        if (!groupId) {
            return res.status(400).json({ success: false, error: '缺少 groupId 参数' });
        }
        
        const barcodes = req.db.getTracedBarcodes(groupId, limit);
        res.json({ success: true, data: barcodes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 列出追溯日志文件
router.get('/logs', (req, res) => {
    try {
        const groupId = parseInt(req.query.groupId, 10);
        const limit = parseInt(req.query.limit, 10) || 100;
        
        if (!groupId) {
            return res.status(400).json({ success: false, error: '缺少 groupId 参数' });
        }
        
        const logs = req.db.listTraceLogs(groupId, limit);
        res.json({ success: true, data: logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 读取追溯日志详情
router.get('/logs/:syncRunId', (req, res) => {
    try {
        const groupId = parseInt(req.query.groupId, 10);
        const syncRunId = parseInt(req.params.syncRunId, 10);
        
        if (!groupId) {
            return res.status(400).json({ success: false, error: '缺少 groupId 参数' });
        }
        
        const logData = req.db.readTraceLog(groupId, syncRunId);
        
        if (!logData) {
            return res.status(404).json({ success: false, error: '未找到日志文件' });
        }
        
        res.json({ success: true, data: logData });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取原始操作记录（饿了么格式，带状态标注）
// 参数: groupId, side ('A' 或 'B'), sinceDate (可选)
router.get('/raw/:barcode', (req, res) => {
    try {
        const groupId = parseInt(req.query.groupId, 10);
        const barcode = req.params.barcode;
        const side = req.query.side || 'A';  // 默认查询 A 门店
        const sinceDate = req.query.sinceDate || null;
        
        if (!groupId) {
            return res.status(400).json({ success: false, error: '缺少 groupId 参数' });
        }
        
        if (!['A', 'B'].includes(side)) {
            return res.status(400).json({ success: false, error: 'side 参数必须是 A 或 B' });
        }
        
        const result = req.db.getTraceRawRecordsByBarcode(groupId, barcode, side, sinceDate);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
