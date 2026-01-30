/**
 * 诊断分析 API 路由
 */

const express = require('express');
const router = express.Router();

// 获取综合诊断报告
router.get('/report/:groupId', (req, res) => {
    try {
        const groupId = parseInt(req.params.groupId, 10);
        const report = req.db.getDiagnosisReport(groupId);
        res.json({ success: true, data: report });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取库存快照
router.get('/snapshots/:groupId', (req, res) => {
    try {
        const groupId = parseInt(req.params.groupId, 10);
        const snapshots = req.db.getStockSnapshots(groupId);
        res.json({ success: true, data: snapshots });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取库存快照统计
router.get('/snapshots/:groupId/stats', (req, res) => {
    try {
        const groupId = parseInt(req.params.groupId, 10);
        const stats = req.db.getStockSnapshotStats(groupId);
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取失败操作日志
router.get('/failures', (req, res) => {
    try {
        const groupId = req.query.groupId ? parseInt(req.query.groupId, 10) : null;
        const limit = parseInt(req.query.limit, 10) || 100;
        
        const logs = req.db.getFailedOperationLogs(groupId, limit);
        res.json({ success: true, data: logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取失败原因统计
router.get('/failures/stats', (req, res) => {
    try {
        const groupId = req.query.groupId ? parseInt(req.query.groupId, 10) : null;
        const stats = req.db.getFailureReasonStats(groupId);
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取高频失败商品
router.get('/failures/frequent', (req, res) => {
    try {
        const groupId = req.query.groupId ? parseInt(req.query.groupId, 10) : null;
        const limit = parseInt(req.query.limit, 10) || 50;
        
        const products = req.db.getFrequentlyFailedProducts(groupId, limit);
        res.json({ success: true, data: products });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取追溯异常统计
router.get('/anomalies/:groupId', (req, res) => {
    try {
        const groupId = parseInt(req.params.groupId, 10);
        const anomalies = req.db.getTraceAnomalies(groupId);
        res.json({ success: true, data: anomalies });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
