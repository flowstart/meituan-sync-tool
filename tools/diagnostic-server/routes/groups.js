/**
 * 同步组 API 路由
 */

const express = require('express');
const router = express.Router();

// 获取所有双向同步组
router.get('/', (req, res) => {
    try {
        const groups = req.db.getAllDualSyncGroups();
        res.json({ success: true, data: groups });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取指定同步组详情
router.get('/:groupId', (req, res) => {
    try {
        const groupId = parseInt(req.params.groupId, 10);
        const group = req.db.getDualSyncGroup(groupId);
        
        if (!group) {
            return res.status(404).json({ success: false, error: '同步组不存在' });
        }
        
        res.json({ success: true, data: group });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
