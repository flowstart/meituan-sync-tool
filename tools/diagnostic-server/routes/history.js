/**
 * 同步历史 API 路由
 */

const express = require('express');
const router = express.Router();

// 获取同步历史列表
router.get('/', (req, res) => {
    try {
        const groupId = req.query.groupId ? parseInt(req.query.groupId, 10) : null;
        const limit = parseInt(req.query.limit, 10) || 100;
        const offset = parseInt(req.query.offset, 10) || 0;
        
        const history = req.db.getDualSyncHistory(groupId, limit, offset);
        res.json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取同步历史统计
router.get('/stats', (req, res) => {
    try {
        const groupId = req.query.groupId ? parseInt(req.query.groupId, 10) : null;
        const stats = req.db.getDualSyncHistoryStats(groupId);
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取指定同步批次的追溯记录
router.get('/run/:syncRunId', (req, res) => {
    try {
        const groupId = parseInt(req.query.groupId, 10);
        const syncRunId = parseInt(req.params.syncRunId, 10);
        
        if (!groupId) {
            return res.status(400).json({ success: false, error: '缺少 groupId 参数' });
        }
        
        const records = req.db.getTraceByRun(groupId, syncRunId);
        res.json({ success: true, data: records });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
