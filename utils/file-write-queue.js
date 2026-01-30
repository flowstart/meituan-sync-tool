/**
 * 文件写入队列（按文件路径串行化），避免大量 sync IO 阻塞事件循环
 */
const fs = require('fs');
const path = require('path');

class FileWriteQueue {
    constructor(options = {}) {
        this.warnThreshold = Number(options.warnThreshold) || 200;
        this._chains = new Map(); // filePath -> Promise
        this._pending = new Map(); // filePath -> number
    }

    _getChain(filePath) {
        return this._chains.get(filePath) || Promise.resolve();
    }

    _setChain(filePath, chain) {
        this._chains.set(filePath, chain);
    }

    _incPending(filePath) {
        const n = (this._pending.get(filePath) || 0) + 1;
        this._pending.set(filePath, n);
        if (n === this.warnThreshold) {
            console.warn(`[FileWriteQueue] pending queue reached ${n} for ${filePath}`);
        }
    }

    _decPending(filePath) {
        const n = (this._pending.get(filePath) || 0) - 1;
        if (n <= 0) {
            this._pending.delete(filePath);
        } else {
            this._pending.set(filePath, n);
        }
    }

    async _ensureDirForFile(filePath) {
        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, { recursive: true });
    }

    /**
     * 按 filePath 串行执行任务
     * @param {string} filePath
     * @param {Function} op async function
     */
    enqueue(filePath, op) {
        if (!filePath) return Promise.resolve();
        this._incPending(filePath);

        const next = this._getChain(filePath)
            .then(async () => {
                try {
                    return await op();
                } catch (e) {
                    // 不让队列链断裂
                    console.error('[FileWriteQueue] write task failed:', e && e.message ? e.message : e);
                }
            })
            .finally(() => {
                this._decPending(filePath);
            });

        // 将链更新为 next（吞掉错误，保证后续任务继续）
        this._setChain(filePath, next.catch(() => {}));
        return next;
    }

    /**
     * 追加写入（串行）
     */
    appendFile(filePath, data, encoding = 'utf8') {
        return this.enqueue(filePath, async () => {
            await this._ensureDirForFile(filePath);
            await fs.promises.appendFile(filePath, data, encoding);
        });
    }

    /**
     * 原子写入（写临时文件 + rename），避免半文件
     */
    writeFileAtomic(filePath, data, encoding = 'utf8') {
        return this.enqueue(filePath, async () => {
            await this._ensureDirForFile(filePath);
            const dir = path.dirname(filePath);
            const base = path.basename(filePath);
            const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);

            await fs.promises.writeFile(tmpPath, data, encoding);

            // Windows 下 rename 覆盖可能失败，先尝试删除目标文件
            try {
                await fs.promises.unlink(filePath);
            } catch (_) {}

            await fs.promises.rename(tmpPath, filePath);
        });
    }

    /**
     * 等待所有队列写入完成
     */
    async flushAll() {
        const chains = Array.from(this._chains.values());
        await Promise.allSettled(chains);
    }
}

const defaultQueue = new FileWriteQueue();

module.exports = defaultQueue;
module.exports.FileWriteQueue = FileWriteQueue;
