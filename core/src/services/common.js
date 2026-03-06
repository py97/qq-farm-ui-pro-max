/**
 * 公共工具函数模块 (T4 - 来源: PR 版 common.js)
 * 提取各服务模块中重复的代码，统一管理
 */

const { toNum } = require('../utils/utils');

// ============ 日期相关 ============

/**
 * 获取当前日期 key (YYYY-MM-DD)
 * @param {Date|number} date - 日期对象或时间戳
 */
function getDateKey(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dStr = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dStr}`;
}

/**
 * 获取服务器时间对应的日期 key (北京时间 UTC+8)
 * @param {number} serverTimeSec - 服务器时间(秒)
 */
function getServerDateKey(serverTimeSec = 0) {
    const nowSec = serverTimeSec > 0 ? serverTimeSec : Math.floor(Date.now() / 1000);
    const nowMs = nowSec * 1000;
    const bjOffset = 8 * 3600 * 1000;
    const bjDate = new Date(nowMs + bjOffset);
    const y = bjDate.getUTCFullYear();
    const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bjDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 判断是否为同一天
 */
function isSameDay(dateKey1, dateKey2) {
    return dateKey1 === dateKey2;
}

// ============ 奖励汇总 ============

const ITEM_NAMES = {
    1: '金币',
    2: '经验',
    1001: '金币',
    1101: '经验',
    1002: '点券',
};

/**
 * 获取奖励摘要字符串
 * @param {Array} items - 物品列表
 * @returns {string} 奖励摘要 (如 "金币100/经验50")
 */
function getRewardSummary(items) {
    const list = Array.isArray(items) ? items : [];
    const summary = [];
    for (const it of list) {
        const id = toNum(it.id);
        const count = toNum(it.count);
        if (count <= 0) continue;
        const itemName = ITEM_NAMES[id] || `物品${id}`;
        summary.push(`${itemName}${count}`);
    }
    return summary.join('/');
}

/**
 * 获取详细奖励摘要
 * @param {Array} items - 物品列表
 * @returns {object} 详细奖励信息 { gold, exp, coupon, items }
 */
function getDetailedRewardSummary(items) {
    const list = Array.isArray(items) ? items : [];
    const result = { gold: 0, exp: 0, coupon: 0, items: [] };
    for (const it of list) {
        const id = toNum(it.id);
        const count = toNum(it.count);
        if (count <= 0) continue;
        if (id === 1 || id === 1001) result.gold += count;
        else if (id === 2 || id === 1101) result.exp += count;
        else if (id === 1002) result.coupon += count;
        else result.items.push({ id, count });
    }
    return result;
}

// ============ 错误判断 ============

/**
 * 判断是否为"已领取"错误
 */
function isAlreadyClaimedError(error) {
    const msg = String(error && (error.message) || '');
    return msg.includes('code=1009001') ||
        msg.includes('code=1018005') ||
        msg.includes('已经领取') ||
        msg.includes('已领取') ||
        msg.includes('活动未解锁') ||
        msg.includes('次数已达上限') ||
        msg.includes('已达上限');
}

/**
 * 判断是否为"余额不足"错误
 */
function isInsufficientBalanceError(error) {
    const msg = String((error && (error.message || error)) || '');
    return msg.includes('余额不足') ||
        msg.includes('点券不足') ||
        msg.includes('金币不足') ||
        msg.includes('code=1000019');
}

/**
 * 判断是否为参数错误
 */
function isParamError(error) {
    const msg = String((error && (error.message || error)) || '');
    return msg.includes('code=1000020') ||
        msg.includes('请求参数错误');
}

// ============ Cooldown 管理 ============

/**
 * 创建每日 Cooldown 管理器
 * 功能：跨日自动重置 + 冷却时间控制
 * @param {object} options - 配置
 * @param {number} options.cooldownMs - 冷却时间(ms)，默认 10 分钟
 */
function createDailyCooldown(options = {}) {
    const { cooldownMs = 10 * 60 * 1000 } = options;
    let lastCheckAt = 0;
    let lastDateKey = '';

    return {
        /** 检查是否可以执行 */
        canRun(force = false) {
            const now = Date.now();
            const currentKey = getDateKey();
            if (currentKey !== lastDateKey) return true;
            if (force && lastCheckAt === 0) return true;
            if (now - lastCheckAt >= cooldownMs) return true;
            return false;
        },
        /** 标记已执行 */
        markRan() {
            const currentKey = getDateKey();
            if (currentKey !== lastDateKey) lastCheckAt = 0;
            lastCheckAt = Date.now();
            lastDateKey = currentKey;
        },
        /** 获取状态 */
        getState() {
            return { lastCheckAt, lastDateKey, cooldownMs, currentKey: getDateKey() };
        },
        /** 重置 */
        reset() { lastCheckAt = 0; lastDateKey = ''; },
        /** 是否已完成今日 */
        isDoneToday() { return lastDateKey === getDateKey(); },
    };
}

/**
 * 创建完整的每日任务管理器
 * 同时管理: 跨日重置、冷却时间、是否完成
 */
function createDailyTaskManager(options = {}) {
    const { cooldownMs = 10 * 60 * 1000 } = options;
    let lastCheckAt = 0;
    let lastDateKey = '';
    const reset = () => { lastCheckAt = 0; lastDateKey = ''; };

    const manager = {
        canRun(force = false) {
            const now = Date.now();
            const currentKey = getDateKey();
            if (force) return true;
            if (currentKey !== lastDateKey) { reset(); return true; }
            if (now - lastCheckAt >= cooldownMs) return true;
            return false;
        },
        markDone() { lastCheckAt = Date.now(); lastDateKey = getDateKey(); },
        markChecked() { lastCheckAt = Date.now(); lastDateKey = getDateKey(); },
        isDoneToday() { return lastDateKey === getDateKey(); },
        getState() {
            return { doneToday: manager.isDoneToday(), lastCheckAt, lastDateKey, cooldownMs, currentKey: getDateKey() };
        },
        reset,
    };
    return manager;
}

// ============ 异步工具 ============

/**
 * 带超时的 Promise
 * @param {Promise} promise - 原 Promise
 * @param {number} ms - 超时时间(ms)
 * @param {string} errorMessage - 超时错误消息
 */
function withTimeout(promise, ms, errorMessage = 'Operation timeout') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(errorMessage)), ms)
        )
    ]);
}

/**
 * 带重试的异步函数（支持指数退避）
 * @param {Function} fn - 异步函数
 * @param {object} options - 配置
 */
async function withRetry(fn, options = {}) {
    const { maxRetries = 3, retryDelay = 1000, shouldRetry = () => true } = options;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries && shouldRetry(error)) {
                await new Promise(r => setTimeout(r, retryDelay * (attempt + 1)));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

// ============ 限流器 ============

/**
 * 创建简单令牌桶限流器
 * @param {number} maxPerSecond - 每秒最大请求数
 */
function createRateLimiter(maxPerSecond = 10) {
    let tokens = maxPerSecond;
    let lastRefill = Date.now();
    const refillAmount = maxPerSecond;

    return {
        async acquire() {
            const now = Date.now();
            const elapsed = now - lastRefill;
            tokens = Math.min(refillAmount, tokens + (elapsed / 1000) * refillAmount);
            lastRefill = now;
            if (tokens < 1) {
                await new Promise(r => setTimeout(r, 1000 / refillAmount));
                tokens = 0;
            } else {
                tokens -= 1;
            }
            return true;
        },
    };
}

// ============ 对象工具 ============

function isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * 深度合并对象
 */
function deepMerge(target, ...sources) {
    if (!sources.length) return target;
    const source = sources.shift();
    if (isObject(target) && isObject(source)) {
        for (const key in source) {
            if (isObject(source[key])) {
                if (!target[key]) Object.assign(target, { [key]: {} });
                deepMerge(target[key], source[key]);
            } else {
                Object.assign(target, { [key]: source[key] });
            }
        }
    }
    return deepMerge(target, ...sources);
}

/**
 * 安全地获取嵌套属性
 * @param {object} obj - 对象
 * @param {string} path - 属性路径 (如 'a.b.c')
 * @param {*} defaultValue - 默认值
 */
function get(obj, path, defaultValue = undefined) {
    const keys = path.split('.');
    let result = obj;
    for (const key of keys) {
        if (result == null) return defaultValue;
        result = result[key];
    }
    return result !== undefined ? result : defaultValue;
}

/**
 * 安全地设置嵌套属性
 */
function set(obj, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let current = obj;
    for (const key of keys) {
        if (!current[key]) current[key] = {};
        current = current[key];
    }
    current[lastKey] = value;
}

// ============ 导出 ============

module.exports = {
    // 日期
    getDateKey, getServerDateKey, isSameDay,
    // 奖励
    getRewardSummary, getDetailedRewardSummary,
    // 错误判断
    isAlreadyClaimedError, isInsufficientBalanceError, isParamError,
    // Cooldown
    createDailyCooldown, createDailyTaskManager,
    // 异步
    withTimeout, withRetry,
    // 限流
    createRateLimiter,
    // 对象
    deepMerge, get, set,
};
