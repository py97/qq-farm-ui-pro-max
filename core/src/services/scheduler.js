const { createModuleLogger } = require('./logger');

const schedulerLogger = createModuleLogger('scheduler');
const schedulerRegistry = new Map(); // namespace -> { createdAt, timers: Map<taskName, TaskMeta> }

function toDelayMs(value, fallbackMs = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return Math.max(0, fallbackMs | 0);
    return Math.max(0, Math.floor(n));
}

function ensureNamespaceStore(namespace) {
    const key = String(namespace || 'default');
    const existed = schedulerRegistry.get(key);
    if (existed) return existed;
    const created = {
        namespace: key,
        createdAt: Date.now(),
        timers: new Map(),
    };
    schedulerRegistry.set(key, created);
    return created;
}

function normalizeTaskSnapshot(taskName, meta) {
    const item = meta || {};
    return {
        name: String(taskName || ''),
        kind: item.kind || 'timeout',
        delayMs: Math.max(0, Number(item.delayMs) || 0),
        createdAt: Number(item.createdAt) || 0,
        nextRunAt: Number(item.nextRunAt) || 0,
        lastRunAt: Number(item.lastRunAt) || 0,
        runCount: Number(item.runCount) || 0,
        running: !!item.running,
        preventOverlap: item.preventOverlap !== false,
    };
}

function getSchedulerRegistrySnapshot(namespace = '') {
    const ns = String(namespace || '').trim();
    const list = [];
    for (const [name, store] of schedulerRegistry.entries()) {
        if (ns && name !== ns) continue;
        const tasks = [];
        for (const [taskName, meta] of store.timers.entries()) {
            tasks.push(normalizeTaskSnapshot(taskName, meta));
        }
        tasks.sort((a, b) => a.name.localeCompare(b.name));
        list.push({
            namespace: name,
            createdAt: Number(store.createdAt) || 0,
            taskCount: tasks.length,
            tasks,
        });
    }
    list.sort((a, b) => a.namespace.localeCompare(b.namespace));
    return {
        generatedAt: Date.now(),
        schedulerCount: list.length,
        schedulers: list,
    };
}

function createScheduler(namespace = 'default') {
    const name = String(namespace || 'default');
    const store = ensureNamespaceStore(name);
    const timers = store.timers;

    function clear(taskName) {
        const key = String(taskName || '');
        const entry = timers.get(key);
        if (!entry) return false;
        timers.delete(key);
        if (entry.kind === 'interval') {
            clearInterval(entry.handle);
        } else {
            clearTimeout(entry.handle);
        }
        return true;
    }

    function clearAll() {
        const keys = Array.from(timers.keys());
        for (const key of keys) clear(key);
    }

    function setTimeoutTask(taskName, delayMs, taskFn) {
        const key = String(taskName || '');
        if (!key) throw new Error('taskName 不能为空');
        if (typeof taskFn !== 'function') throw new Error(`timeout 任务 ${key} 缺少回调函数`);
        clear(key);
        const delay = toDelayMs(delayMs, 0);
        const entry = {
            kind: 'timeout',
            delayMs: delay,
            createdAt: Date.now(),
            nextRunAt: Date.now() + delay,
            lastRunAt: 0,
            runCount: 0,
            running: false,
            preventOverlap: true,
            handle: null,
        };
        const handle = setTimeout(async () => {
            const current = timers.get(key);
            if (!current || current.handle !== handle) return;
            current.running = true;
            current.lastRunAt = Date.now();
            current.runCount += 1;
            try {
                await taskFn();
            } catch (e) {
                schedulerLogger.warn(`[${name}] timeout 任务执行失败: ${key}`, {
                    module: 'scheduler',
                    scope: name,
                    task: key,
                    error: e && e.message ? e.message : String(e),
                });
            } finally {
                // 只删除自己，避免删掉 taskFn 执行期间注册的新 entry
                const after = timers.get(key);
                if (after && after.handle === handle) {
                    timers.delete(key);
                }
            }
        }, delay);
        entry.handle = handle;
        timers.set(key, entry);
        return handle;
    }

    function setIntervalTask(taskName, intervalMs, taskFn, options = {}) {
        const key = String(taskName || '');
        if (!key) throw new Error('taskName 不能为空');
        if (typeof taskFn !== 'function') throw new Error(`interval 任务 ${key} 缺少回调函数`);
        clear(key);

        const delay = Math.max(1, toDelayMs(intervalMs, 1000));
        const preventOverlap = options.preventOverlap !== false;
        const runImmediately = !!options.runImmediately;

        const entry = {
            kind: 'interval',
            delayMs: delay,
            createdAt: Date.now(),
            nextRunAt: Date.now() + delay,
            lastRunAt: 0,
            runCount: 0,
            running: false,
            preventOverlap,
            handle: null,
            expectedNext: Date.now() + delay // 记录基准时间用于补偿漂移
        };

        const runner = async () => {
            const current = timers.get(key);
            if (!current) return;

            // 用微小挂起把庞大的主线程执行切片让出（缓解低配 CPU 排队阻塞）
            await new Promise(r => setImmediate(r));

            if (preventOverlap && current.running) {
                // 如果上个任务还在执行，放弃本次补偿，直接预约下一个周期
                current.expectedNext += delay;
                queueNext(delay);
                return;
            }

            current.running = true;
            current.lastRunAt = Date.now();
            current.runCount += 1;

            try {
                await taskFn();
            } catch (e) {
                schedulerLogger.warn(`[${name}] interval 任务执行失败: ${key}`, {
                    module: 'scheduler',
                    scope: name,
                    task: key,
                    error: e && e.message ? e.message : String(e),
                });
            } finally {
                const updated = timers.get(key);
                if (updated) {
                    updated.running = false;

                    // 核心逻辑: 日志漂移的时间补偿 (Time Drift Compensation)
                    updated.expectedNext += delay;
                    const now = Date.now();
                    // 下一次真实的 delay 等于期待时间减去当前时间（但防超上限和跌入负数狂暴死循环）
                    let nextDelay = updated.expectedNext - now;
                    if (nextDelay < 0) {
                        // 落后太多了，可能刚才 CPU 卡了几十秒钟，把期盼时间拽回现在，防止连发暴走
                        updated.expectedNext = now + delay;
                        nextDelay = delay;
                    }

                    updated.nextRunAt = now + nextDelay;
                    queueNext(nextDelay);
                }
            }
        };

        const queueNext = (ms) => {
            const current = timers.get(key);
            if (current) {
                current.handle = setTimeout(runner, ms);
            }
        };

        if (runImmediately) {
            entry.expectedNext = Date.now();
            Promise.resolve().then(runner).catch(() => null);
        } else {
            entry.handle = setTimeout(runner, delay);
        }

        timers.set(key, entry);
        // 返回解绑函数签名适配
        return entry.handle;
    }

    function has(taskName) {
        return timers.has(String(taskName || ''));
    }

    function getTaskNames() {
        return Array.from(timers.keys());
    }

    function getSnapshot() {
        const one = getSchedulerRegistrySnapshot(name);
        return one.schedulers[0] || { namespace: name, createdAt: Date.now(), taskCount: 0, tasks: [] };
    }

    /**
     * 遍历式清理：清除所有 taskName 包含指定关键词的定时任务
     * 用途：Worker 退出时清理所有与该 accountId 相关的残留定时资源
     * @param {string} keyword - 要匹配的关键词（支持部分匹配）
     * @returns {number} 清理的任务数量
     */
    function clearByKeyword(keyword) {
        if (!keyword) return 0;
        const keys = Array.from(timers.keys());
        let count = 0;
        for (const key of keys) {
            if (key.includes(keyword)) {
                clear(key);
                count++;
            }
        }
        return count;
    }

    return {
        setTimeoutTask,
        setIntervalTask,
        clear,
        clearAll,
        has,
        getTaskNames,
        getSnapshot,
        clearByKeyword,
    };
}

module.exports = {
    createScheduler,
    getSchedulerRegistrySnapshot,
};
