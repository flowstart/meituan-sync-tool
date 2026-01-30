/**
 * 库存操作记录查询 API 路由
 */

const express = require('express');
const router = express.Router();

// 分页查询原始操作记录
router.get('/', (req, res) => {
    try {
        const groupId = req.query.groupId ? parseInt(req.query.groupId, 10) : null;
        const side = req.query.side || null;  // 'A' 或 'B'，不传则查所有
        const barcode = req.query.barcode || null;
        const oldStock = req.query.oldStock !== undefined && req.query.oldStock !== '' 
            ? parseInt(req.query.oldStock, 10) : null;
        const newStock = req.query.newStock !== undefined && req.query.newStock !== '' 
            ? parseInt(req.query.newStock, 10) : null;
        const syncRunIdStart = req.query.syncRunIdStart ? parseInt(req.query.syncRunIdStart, 10) : null;
        const syncRunIdEnd = req.query.syncRunIdEnd ? parseInt(req.query.syncRunIdEnd, 10) : null;
        const page = parseInt(req.query.page, 10) || 1;
        const pageSize = parseInt(req.query.pageSize, 10) || 100;

        if (!groupId) {
            return res.status(400).json({ success: false, error: '缺少 groupId 参数' });
        }

        const result = req.db.queryRawRecords({
            groupId,
            side,
            barcode,
            oldStock,
            newStock,
            syncRunIdStart,
            syncRunIdEnd,
            page,
            pageSize
        });

        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
