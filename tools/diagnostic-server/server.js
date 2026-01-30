/**
 * 美团同步工具诊断服务
 * 用于分析客户提供的 meituan-sync-tool 用户数据目录
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const DatabaseService = require('./services/database');

// 解析命令行参数
function parseArgs() {
    const args = process.argv.slice(2);
    const result = {
        dataDir: null,
        port: 5005
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--data-dir=')) {
            result.dataDir = arg.split('=')[1].replace(/"/g, '');
        } else if (arg.startsWith('--port=')) {
            result.port = parseInt(arg.split('=')[1], 10);
        } else if (arg === '--data-dir' && args[i + 1]) {
            result.dataDir = args[++i];
        } else if (arg === '--port' && args[i + 1]) {
            result.port = parseInt(args[++i], 10);
        }
    }

    return result;
}

const config = parseArgs();

// 验证数据目录
function validateDataDir(dataDir) {
    if (!dataDir) {
        return { valid: false, error: '未指定数据目录，请使用 --data-dir 参数' };
    }

    const resolvedPath = path.resolve(dataDir);
    
    if (!fs.existsSync(resolvedPath)) {
        return { valid: false, error: `数据目录不存在: ${resolvedPath}` };
    }

    const dbPath = path.join(resolvedPath, 'sync.db');
    if (!fs.existsSync(dbPath)) {
        return { valid: false, error: `数据库文件不存在: ${dbPath}` };
    }

    return { valid: true, path: resolvedPath, dbPath };
}

// 创建应用
const app = express();

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 数据库服务实例
let db = null;
let dataDir = null;

// 初始化数据库
function initDatabase(dirPath) {
    const validation = validateDataDir(dirPath);
    if (!validation.valid) {
        throw new Error(validation.error);
    }

    dataDir = validation.path;
    db = new DatabaseService(validation.dbPath, path.join(dataDir, 'data'));
    console.log(`数据库已加载: ${validation.dbPath}`);
    return db;
}

// 中间件：确保数据库已加载
function ensureDatabase(req, res, next) {
    if (!db) {
        return res.status(503).json({ error: '数据库未加载，请先配置数据目录' });
    }
    req.db = db;
    req.dataDir = dataDir;
    next();
}

// API 路由
const groupsRouter = require('./routes/groups');
const historyRouter = require('./routes/history');
const traceRouter = require('./routes/trace');
const diagnosisRouter = require('./routes/diagnosis');
const recordsRouter = require('./routes/records');

app.use('/api/groups', ensureDatabase, groupsRouter);
app.use('/api/history', ensureDatabase, historyRouter);
app.use('/api/trace', ensureDatabase, traceRouter);
app.use('/api/diagnosis', ensureDatabase, diagnosisRouter);
app.use('/api/records', ensureDatabase, recordsRouter);

// 配置 API
app.get('/api/config', (req, res) => {
    res.json({
        dataDir: dataDir,
        dbLoaded: !!db
    });
});

app.post('/api/config/data-dir', (req, res) => {
    const { path: dirPath } = req.body;
    
    try {
        initDatabase(dirPath);
        res.json({ success: true, dataDir: dataDir });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// 首页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务
app.listen(config.port, () => {
    console.log('='.repeat(60));
    console.log('美团同步工具诊断服务');
    console.log('='.repeat(60));
    console.log(`服务地址: http://localhost:${config.port}`);
    
    if (config.dataDir) {
        try {
            initDatabase(config.dataDir);
            console.log(`数据目录: ${dataDir}`);
        } catch (error) {
            console.error(`初始化失败: ${error.message}`);
            console.log('请在界面中配置有效的数据目录');
        }
    } else {
        console.log('未指定数据目录，请在界面中配置或使用 --data-dir 参数');
    }
    
    console.log('='.repeat(60));
});
