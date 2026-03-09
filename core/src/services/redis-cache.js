const { loadProjectEnv } = require('../config/load-env');
const Redis = require('ioredis');
const { createModuleLogger } = require('./logger');
const { circuitBreaker } = require('./circuit-breaker');

loadProjectEnv();

const logger = createModuleLogger('redis-cache');
let redisDisabled = false;
let redisDisableReason = '';

function getErrorMessage(err) {
    return String(err && err.message ? err.message : err || 'unknown').trim() || 'unknown';
}

function isAuthError(message) {
    return /NOAUTH|WRONGPASS|authentication required|invalid username-password/i.test(String(message || ''));
}

function getRedisAuthFailureReason(message) {
    if (!REDIS_PASSWORD) {
        return `Redis 要求密码认证，但 REDIS_PASSWORD 未配置 (${REDIS_HOST}:${REDIS_PORT})`;
    }
    return `Redis 鉴权失败: ${message}`;
}

function disableRedis(reason) {
    if (redisDisabled) return;
    redisDisabled = true;
    redisDisableReason = reason || 'unknown';
    logger.warn(`⚠️ Redis 已切换为降级模式: ${redisDisableReason}`);
    try {
        redis.disconnect();
    } catch {
        // ignore
    }
}

// 从环境变量读取配置，兼容 docker-compose 和本地开发
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number.parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = typeof process.env.REDIS_PASSWORD === 'string'
    ? process.env.REDIS_PASSWORD
    : '';

// Redis 实例
const redisOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    commandTimeout: 5000,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy(times) {
        if (redisDisabled) return null;
        // 重连策略: 延迟重试，最大不超过 2 秒
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
};

if (REDIS_PASSWORD) {
    redisOptions.password = REDIS_PASSWORD;
}

const redis = new Redis(redisOptions);

// === Redis 连接事件 → 同步更新熔断器状态 ===

redis.on('connect', () => {
    if (redisDisabled) return;
    logger.info(`Redis TCP connected (${REDIS_HOST}:${REDIS_PORT})`);
});

redis.on('ready', () => {
    if (redisDisabled) return;
    logger.debug('Redis socket ready，等待 PING 鉴权验证');
});

redis.on('error', (err) => {
    const message = getErrorMessage(err);
    logger.error(`❌ Redis 发生错误: ${message}`);
    if (isAuthError(message)) {
        disableRedis(getRedisAuthFailureReason(message));
        return;
    }
    if (!redisDisabled)
        circuitBreaker.recordFailure(message);
});

redis.on('close', () => {
    if (redisDisabled) return;
    logger.warn('⚠️ Redis 连接已断开');
    circuitBreaker.recordFailure();
});

redis.on('reconnecting', () => {
    if (redisDisabled) return;
    logger.info('🔄 Redis 正在重连...');
});

/**
 * 初始化 Redis 连接（验证连通性）
 * 由 database.js 的 initDatabase 调用
 */
async function initRedis() {
    if (redisDisabled) {
        logger.warn(`⚠️ Redis 已停用，跳过初始化: ${redisDisableReason}`);
        return false;
    }
    try {
        if (redis.status === 'wait') {
            await redis.connect();
        }
        await redis.ping();
        circuitBreaker.recordSuccess();
        logger.info('✅ Redis PING 验证成功');
        return true;
    } catch (e) {
        const message = getErrorMessage(e);
        if (isAuthError(message)) {
            disableRedis(getRedisAuthFailureReason(message));
            return false;
        }
        circuitBreaker.recordFailure(message);
        logger.error(`❌ Redis PING 验证失败: ${message}`);
        throw e;
    }
}

/**
 * 封装缓存 Setter（接入熔断器）
 * @param {string} key 
 * @param {any} value 
 * @param {number} expireSecs 过期时间(秒) 默认永不过期
 */
async function setCache(key, value, expireSecs = 0) {
    if (redisDisabled) return;
    // 熔断器检查：Redis 不可用时直接跳过写入
    if (!circuitBreaker.allowRequest()) return;
    try {
        const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (expireSecs > 0) {
            await redis.set(key, strVal, 'EX', expireSecs);
        } else {
            await redis.set(key, strVal);
        }
        circuitBreaker.recordSuccess();
    } catch (e) {
        circuitBreaker.recordFailure();
        logger.error(`setCache error [${key}]:`, e.message);
    }
}

/**
 * 封装缓存 Getter（接入熔断器）
 * @param {string} key 
 */
async function getCache(key) {
    if (redisDisabled) return null;
    // 熔断器检查：Redis 不可用时直接返回 null
    if (!circuitBreaker.allowRequest()) return null;
    try {
        const val = await redis.get(key);
        circuitBreaker.recordSuccess();
        if (!val) return null;
        try {
            return JSON.parse(val);
        } catch {
            return val;
        }
    } catch (e) {
        circuitBreaker.recordFailure();
        logger.error(`getCache error [${key}]:`, e.message);
        return null;
    }
}

/**
 * 提供分布式锁简单实现 (SET NX)（接入熔断器）
 */
async function acquireLock(lockKey, expireMs = 5000) {
    if (redisDisabled) return false;
    if (!circuitBreaker.allowRequest()) return false;
    try {
        // PX = 毫秒， NX = 不存在才创建
        const result = await redis.set(lockKey, 'LOCKED', 'PX', expireMs, 'NX');
        circuitBreaker.recordSuccess();
        return result === 'OK';
    } catch (e) {
        circuitBreaker.recordFailure();
        logger.error(`acquireLock error [${lockKey}]:`, e.message);
        return false;
    }
}

async function releaseLock(lockKey) {
    if (redisDisabled) return;
    if (!circuitBreaker.allowRequest()) return;
    try {
        await redis.del(lockKey);
        circuitBreaker.recordSuccess();
    } catch (e) {
        circuitBreaker.recordFailure();
        logger.error(`releaseLock error [${lockKey}]:`, e.message);
    }
}

function getRedisClient() {
    if (redisDisabled) return null;
    return redis;
}

module.exports = {
    redis,
    initRedis,
    getRedisClient,
    setCache,
    getCache,
    acquireLock,
    releaseLock
};
