/**
 * 日志系统
 * 支持控制台输出和文件记录
 */

const fs = require('fs');
const path = require('path');
const { toLocalISOString, toLocalDateString } = require('./time-utils');
const fileWriteQueue = require('./file-write-queue');

class Logger {
    constructor(options = {}) {
        this.logLevel = options.logLevel || 'info'; // debug, info, warn, error
        this.enableFile = options.enableFile !== false; // 默认启用文件日志
        this.logDir = options.logDir || 'logs';
        this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB

        // 日志级别优先级
        this.levels = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3
        };

        // 确保日志目录存在（捕获错误，避免打包后无法创建目录导致崩溃）
        this._ensureLogDir();
    }

    /**
     * 确保日志目录存在
     */
    _ensureLogDir() {
        if (!this.enableFile) return;
        
        try {
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }
        } catch (error) {
            console.warn('无法创建日志目录:', error.message);
            // 如果创建失败，禁用文件日志
            this.enableFile = false;
        }
    }

    /**
     * 设置日志目录（用于在 app ready 后重新设置）
     */
    setLogDir(logDir) {
        this.logDir = logDir;
        this._ensureLogDir();
    }

    /**
     * 获取当前日志文件路径
     */
    _getLogFilePath() {
        const today = toLocalDateString();
        return path.join(this.logDir, `app-${today}.log`);
    }

    /**
     * 格式化日志消息
     */
    _formatMessage(level, ...args) {
        const timestamp = toLocalISOString();
        const message = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg, null, 2);
                } catch (e) {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');

        return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    }

    /**
     * 写入文件
     */
    _writeToFile(message) {
        if (!this.enableFile) return;

        try {
            const logFile = this._getLogFilePath();

            // 串行化：rotate + append 都放到同一文件队列，避免并发写乱序
            fileWriteQueue.enqueue(logFile, async () => {
                // 检查文件大小，如果超过限制则备份
                try {
                    const stats = await fs.promises.stat(logFile);
                    if (stats && stats.size > this.maxFileSize) {
                        const backupFile = logFile.replace('.log', `-${Date.now()}.log`);
                        try {
                            await fs.promises.rename(logFile, backupFile);
                        } catch (e) {
                            // rename 失败不影响继续写入
                            console.error('备份日志文件失败:', e && e.message ? e.message : e);
                        }
                    }
                } catch (_) {
                    // 文件不存在时忽略
                }

                await fileWriteQueue.appendFile(logFile, message + '\n', 'utf8');
            });
        } catch (error) {
            console.error('写入日志文件失败:', error);
        }
    }

    /**
     * 检查是否应该记录该级别的日志
     */
    _shouldLog(level) {
        return this.levels[level] >= this.levels[this.logLevel];
    }

    /**
     * 通用日志方法
     */
    _log(level, ...args) {
        if (!this._shouldLog(level)) return;

        const message = this._formatMessage(level, ...args);

        // 控制台输出（带颜色）
        const colors = {
            debug: '\x1b[36m', // Cyan
            info: '\x1b[32m',  // Green
            warn: '\x1b[33m',  // Yellow
            error: '\x1b[31m'  // Red
        };
        const reset = '\x1b[0m';

        if (level === 'error') {
            console.error(`${colors[level]}${message}${reset}`);
        } else if (level === 'warn') {
            console.warn(`${colors[level]}${message}${reset}`);
        } else {
            console.log(`${colors[level]}${message}${reset}`);
        }

        // 写入文件
        this._writeToFile(message);
    }

    /**
     * Debug级别日志
     */
    debug(...args) {
        this._log('debug', ...args);
    }

    /**
     * Info级别日志
     */
    info(...args) {
        this._log('info', ...args);
    }

    /**
     * Warn级别日志
     */
    warn(...args) {
        this._log('warn', ...args);
    }

    /**
     * Error级别日志
     */
    error(...args) {
        this._log('error', ...args);
    }

    /**
     * 设置日志级别
     */
    setLogLevel(level) {
        if (this.levels[level] !== undefined) {
            this.logLevel = level;
        } else {
            this.warn(`未知的日志级别: ${level}`);
        }
    }
}

// 创建默认Logger实例
const defaultLogger = new Logger({
    logLevel: process.env.LOG_LEVEL || 'info',
    enableFile: true,
    logDir: 'logs'
});

// 导出默认实例和类
module.exports = defaultLogger;
module.exports.Logger = Logger;
module.exports.createLogger = (options) => new Logger(options);

