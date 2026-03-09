/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

const protobuf = require('protobufjs');
const { CONFIG, PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantNameBySeedId, getPlantName, getPlantExp, formatGrowTime, getPlantGrowTime, getAllSeeds, getPlantById, getPlantBySeedId, getSeedImageBySeedId } = require('../config/gameConfig');
const { isAutomationOn, getPreferredSeed, getAutomation, getPlantingStrategy, recordSuspendUntil, getTimingConfig, getConfigSnapshot } = require('../models/store');
const { sendMsgAsync, sendMsgAsyncUrgent, getUserState, networkEvents, getWsErrorState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, getServerTimeSec, toTimeSec, log, logWarn, sleep } = require('../utils/utils');
const { getPlantRankings } = require('./analytics');
const { getRuntimeAccountModePolicy } = require('./account-mode-policy');
const { getBagDetail } = require('./warehouse');
const { ANALYTICS_SORT_BY_MAP, getInventorySourcePlan, getWorkflowSelectSeedOverride, normalizeInventoryPlantingMode, pickBudgetOptimizedPlan, pickSeedByStrategy } = require('./planting-strategy');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');
const { getDefaultLimiter } = require('./rate-limiter');

// ============ 内部状态 ============
let isCheckingFarm = false;
let isFirstFarmCheck = true; // 用于初始化输出更多日志
let lastGhostingEndedAt = 0; // Ghosting 打盹上次结束时间（独立于 suspendUntil，避免语义混淆）

let farmLoopRunning = false;
let externalSchedulerMode = false;
const farmScheduler = createScheduler('farm');

// Promise 级别的高频并发合并缓存 (针对防偷抢收的极速侦测请求起削峰作用)
let landsFetchPromise = null;
let landsFetchTime = 0;
const LANDS_CACHE_TTL_MS = 500;
const FAST_HARVEST_WINDOW_SEC = 60;
const FAST_HARVEST_ADVANCE_MS = 200;
const FAST_HARVEST_TASK_PREFIX = 'fast_harvest_land_';
const OCCUPIED_LAND_RECHECK_COOLDOWN_MS = 3 * 60 * 1000;
const occupiedLandPlantCooldowns = new Map();
const smartPhaseFertilizeMarks = new Map();
const MODE_SCOPE_LOG_TTL_MS = 5 * 60 * 1000;
let lastModeScopeLogState = '';
let lastModeScopeLogAt = 0;

const STRATEGY_METRIC_LABELS = Object.freeze({
    actualExpPerHour: '总经验/时',
    actualNormalFertilizerExpPerHour: '总普肥经验/时',
    actualProfitPerHour: '总利润/时',
    actualNormalFertilizerProfitPerHour: '总普肥利润/时',
    expPerHour: '总经验/时',
    normalFertilizerExpPerHour: '总普肥经验/时',
    profitPerHour: '总利润/时',
    normalFertilizerProfitPerHour: '总普肥利润/时',
});

function normalizeInventoryPlantingConfig(config) {
    const raw = (config && typeof config === 'object') ? config : {};
    const reserveRules = Array.isArray(raw.reserveRules)
        ? raw.reserveRules
            .map(rule => ({
                seedId: Math.max(0, Number.parseInt(rule && rule.seedId, 10) || 0),
                keepCount: Math.max(0, Number.parseInt(rule && rule.keepCount, 10) || 0),
            }))
            .filter(rule => rule.seedId > 0)
        : [];
    const seen = new Set();
    return {
        mode: normalizeInventoryPlantingMode(raw.mode),
        globalKeepCount: Math.max(0, Number.parseInt(raw.globalKeepCount, 10) || 0),
        reserveRules: reserveRules.filter((rule) => {
            if (seen.has(rule.seedId)) return false;
            seen.add(rule.seedId);
            return true;
        }),
    };
}

function getInventoryReserveCount(inventoryPlanting, seedId) {
    const config = normalizeInventoryPlantingConfig(inventoryPlanting);
    const matchedRule = config.reserveRules.find(rule => Number(rule.seedId) === Number(seedId));
    return matchedRule ? matchedRule.keepCount : config.globalKeepCount;
}

function buildPlantingCandidates(shopAvailable, bagDetail, inventoryPlanting) {
    const candidates = new Map();
    for (const item of (Array.isArray(shopAvailable) ? shopAvailable : [])) {
        const seedId = toNum(item && item.seedId);
        if (seedId <= 0) continue;
        candidates.set(seedId, {
            ...item,
            seedId,
            requiredLevel: toNum(item.requiredLevel),
            price: toNum(item.price),
            purchasable: true,
            inventoryTotalCount: 0,
            inventoryReservedCount: 0,
            inventoryUsableCount: 0,
        });
    }

    const seedMetaMap = new Map((getAllSeeds() || []).map(seed => [toNum(seed && seed.seedId), seed]));
    for (const item of ((bagDetail && Array.isArray(bagDetail.items)) ? bagDetail.items : [])) {
        const seedId = toNum(item && item.id);
        if (seedId <= 0 || String(item && item.category) !== 'seed') continue;

        const totalCount = Math.max(0, toNum(item.count));
        const reservedCount = getInventoryReserveCount(inventoryPlanting, seedId);
        const usableCount = Math.max(0, totalCount - reservedCount);
        const fallbackMeta = seedMetaMap.get(seedId) || {};
        const existing = candidates.get(seedId) || {
            seedId,
            goodsId: 0,
            goods: null,
            price: toNum(fallbackMeta.price),
            requiredLevel: toNum(fallbackMeta.requiredLevel),
            name: fallbackMeta.name || getPlantNameBySeedId(seedId),
            image: fallbackMeta.image || '',
            purchasable: false,
        };
        candidates.set(seedId, {
            ...existing,
            name: existing.name || fallbackMeta.name || getPlantNameBySeedId(seedId),
            price: Math.max(0, toNum(existing.price || fallbackMeta.price)),
            requiredLevel: Math.max(0, toNum(existing.requiredLevel || fallbackMeta.requiredLevel)),
            purchasable: !!existing.purchasable,
            inventoryTotalCount: totalCount,
            inventoryReservedCount: reservedCount,
            inventoryUsableCount: usableCount,
        });
    }

    return Array.from(candidates.values());
}

function filterPlantingCandidatesByInventoryMode(candidates, inventoryMode) {
    const mode = normalizeInventoryPlantingMode(inventoryMode);
    if (mode === 'inventory_only') {
        return (candidates || []).filter(item => toNum(item && item.inventoryUsableCount) > 0);
    }
    if (mode === 'prefer_inventory') {
        return (candidates || []).filter(item => !!(item && item.purchasable) || toNum(item && item.inventoryUsableCount) > 0);
    }
    return (candidates || []).filter(item => !!(item && item.purchasable));
}

function logModeScopePolicy(policy) {
    if (!policy || policy.collaborationEnabled || !policy.degradeReason) {
        lastModeScopeLogState = '';
        lastModeScopeLogAt = 0;
        return;
    }
    const stateValue = `${policy.fallbackBehavior}:${policy.effectiveMode}:${policy.degradeReason}`;
    const now = Date.now();
    if (stateValue === lastModeScopeLogState && (now - lastModeScopeLogAt) < MODE_SCOPE_LOG_TTL_MS) {
        return;
    }
    lastModeScopeLogState = stateValue;
    lastModeScopeLogAt = now;
    const reasonLabel = policy.degradeReasonLabel || policy.degradeReason;
    const isStrictBlock = policy.fallbackBehavior === 'strict_block';
    const message = isStrictBlock
        ? `账号模式作用范围未命中: ${reasonLabel}，农场模块已按 ${policy.effectiveMode || 'safe'} 模式保守执行`
        : `账号模式作用范围未命中: ${reasonLabel}，农场模块按独立账号继续执行`;
    const meta = {
        module: 'farm',
        event: 'mode_scope',
        result: policy.collaborationEnabled ? 'in_scope' : 'standalone',
        effectiveMode: policy.effectiveMode || policy.accountMode || 'main',
        degradeReason: policy.degradeReason,
    };
    if (isStrictBlock) {
        logWarn('农场', message, meta);
        return;
    }
    log('农场', message, meta);
}

// ============ 访客行为检测 (来源: NC 版 farm.js#L32-92) ============
// visitorCache: 缓存每块地的访客状态，用于 diff 检测新增访客（种草/放虫/偷菜）
const visitorCache = new Map();

/**
 * 根据 GID 获取好友昵称
 * gid<=0 视为未知来源，不应被展示为真实好友名
 * 查询失败或好友不存在时，返回 "GID:xxx" 格式
 */
async function getFriendNameByGid(gid) {
    const numericGid = toNum(gid);
    if (!Number.isFinite(numericGid) || numericGid <= 0) return '';
    try {
        const { getCachedFriends } = require('./database');
        if (!getCachedFriends || !CONFIG.accountId) return `GID:${numericGid}`;
        const friends = await getCachedFriends(CONFIG.accountId);
        const friend = friends.find(f => toNum(f.gid) === numericGid);
        return friend ? (friend.remark || friend.name || `GID:${numericGid}`) : `GID:${numericGid}`;
    } catch {
        return `GID:${numericGid}`;
    }
}

function buildVisitorLogMessage(kind, landId, actorName) {
    if (kind === 'weed') {
        return actorName
            ? `🌿 ${actorName} 给你的土地#${landId}放草了`
            : `🌿 匿名好友给你的土地#${landId}放草了`;
    }
    if (kind === 'insect') {
        return actorName
            ? `🐛 ${actorName} 给你的土地#${landId}放虫了`
            : `🐛 匿名好友给你的土地#${landId}放虫了`;
    }
    return actorName
        ? `🥷 ${actorName} 偷取了你土地#${landId}的果实`
        : `🥷 匿名好友偷取了你土地#${landId}的果实`;
}

/**
 * 检测并记录访客行为变化
 * 比对当前土地状态与缓存，识别新增的种草者/放虫者/偷菜者
 * 仅记录增量变化，避免重复告警
 */
async function detectAndLogVisitorChanges(lands) {
    if (!lands || lands.length === 0) return;

    for (const land of lands) {
        if (!land || !land.unlocked || !land.plant) continue;
        const landId = toNum(land.id);
        const plant = land.plant;
        const cached = visitorCache.get(landId) || { weed_owners: [], insect_owners: [], stealers: [] };

        const currentWeedOwners = (plant.weed_owners || []).map(g => toNum(g));
        const currentInsectOwners = (plant.insect_owners || []).map(g => toNum(g));
        const currentStealers = (plant.stealers || []).map(g => toNum(g));

        // 检测新增的放草者
        for (const gid of currentWeedOwners) {
            if (!cached.weed_owners.includes(gid)) {
                const name = await getFriendNameByGid(gid);
                log('访客', buildVisitorLogMessage('weed', landId, name), {
                    module: 'farm', event: 'visitor', result: 'weed', gid, landId, sourceKnown: !!name
                });
            }
        }

        // 检测新增的放虫者
        for (const gid of currentInsectOwners) {
            if (!cached.insect_owners.includes(gid)) {
                const name = await getFriendNameByGid(gid);
                log('访客', buildVisitorLogMessage('insect', landId, name), {
                    module: 'farm', event: 'visitor', result: 'insect', gid, landId, sourceKnown: !!name
                });
            }
        }

        // 检测新增的偷菜者
        for (const gid of currentStealers) {
            if (!cached.stealers.includes(gid)) {
                const name = await getFriendNameByGid(gid);
                log('访客', buildVisitorLogMessage('steal', landId, name), {
                    module: 'farm', event: 'visitor', result: 'steal', gid, landId, sourceKnown: !!name
                });
            }
        }

        // 更新缓存 (无论是否有变化都更新，确保状态同步)
        visitorCache.set(landId, {
            weed_owners: currentWeedOwners,
            insect_owners: currentInsectOwners,
            stealers: currentStealers,
        });
    }
}

// ============ 农场 API ============

// 操作限制更新回调 (由 friend.js 设置)
let onOperationLimitsUpdate = null;
function setOperationLimitsCallback(callback) {
    onOperationLimitsUpdate = callback;
}

/**
 * 通用植物操作请求
 */
async function sendPlantRequest(RequestType, ReplyType, method, landIds, hostGid) {
    const body = RequestType.encode(RequestType.create({
        land_ids: landIds,
        host_gid: toLong(hostGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
    return ReplyType.decode(replyBody);
}

async function getAllLands() {
    const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
    const reply = types.AllLandsReply.decode(replyBody);
    // 更新操作限制
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}

async function harvest(landIds) {
    const state = getUserState();
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    return types.HarvestReply.decode(replyBody);
}

async function waterLand(landIds) {
    const state = getUserState();
    return sendPlantRequest(types.WaterLandRequest, types.WaterLandReply, 'WaterLand', landIds, state.gid);
}

async function weedOut(landIds) {
    const state = getUserState();
    return sendPlantRequest(types.WeedOutRequest, types.WeedOutReply, 'WeedOut', landIds, state.gid);
}

async function insecticide(landIds) {
    const state = getUserState();
    return sendPlantRequest(types.InsecticideRequest, types.InsecticideReply, 'Insecticide', landIds, state.gid);
}

// 普通肥料 ID
const NORMAL_FERTILIZER_ID = 1011;
// 有机肥料 ID
const ORGANIC_FERTILIZER_ID = 1012;

/**
 * 施肥 - 必须逐块进行，服务器不支持批量
 * 游戏中拖动施肥间隔很短，这里用 50ms
 */
async function fertilize(landIds, fertilizerId = NORMAL_FERTILIZER_ID) {
    let successCount = 0;
    for (const landId of landIds) {
        // [防封] 施肥速度平滑，每次请求消费一个令牌
        try { await getDefaultLimiter().bucket.waitForToken(1); } catch (e) { }

        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(fertilizerId),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch {
            // 施肥失败（可能肥料不足），停止继续
            break;
        }
        // 令牌桶已在底层做了 334ms 间隔限流，无需额外 sleep
    }
    return successCount;
}
/**
 * 有机肥循环施肥:
 * 按地块顺序 1-2-3-...-1 持续施肥，直到出现失败即停止。
 * 最大循环 MAX_ORGANIC_ROUNDS 次，防止大量有机肥时长时间阻塞主线程。
 */
const MAX_ORGANIC_ROUNDS = 500;

async function fertilizeOrganicLoop(landIds) {
    const ids = (Array.isArray(landIds) ? landIds : []).filter(Boolean);
    if (ids.length === 0) return 0;

    let successCount = 0;
    let idx = 0;

    while (successCount < MAX_ORGANIC_ROUNDS) {
        // [防封] 有机化肥也平滑，每次消耗 1 个令牌
        try { await getDefaultLimiter().bucket.waitForToken(1); } catch (e) { }

        const landId = ids[idx];
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(ORGANIC_FERTILIZER_ID),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch {
            // 常见是有机肥耗尽，按需求直接停止
            break;
        }

        idx = (idx + 1) % ids.length;
        // 随机化施肥间隔 (400~700ms)，避免固定 500ms 节奏被检测
        await sleep(400 + Math.floor(Math.random() * 300));

        // [优化] 分片让流机制：每连续施有机肥 20 次，强行休眠 8~15 秒，将令牌桶的排队机会让给抢收、心跳等其他核心线程防卡死。
        if (successCount > 0 && successCount % 20 === 0) {
            log('施肥', `批量有机肥已通过 ${successCount} 次，主动让流休息一下...`, {
                module: 'farm', event: 'fertilize_yield', result: 'ok',
            });
            await sleep(8000 + Math.floor(Math.random() * 7000));
        }
    }

    if (successCount >= MAX_ORGANIC_ROUNDS) {
        log('施肥', `有机肥循环达到上限 ${MAX_ORGANIC_ROUNDS} 次，已安全停止`, {
            module: 'farm', event: 'fertilize', result: 'limit',
        });
    }

    return successCount;
}

function getOrganicFertilizerTargetsFromLands(lands) {
    const list = Array.isArray(lands) ? lands : [];
    const targets = [];
    for (const land of list) {
        if (!land || !land.unlocked) continue;
        const landId = toNum(land.id);
        if (!landId) continue;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;
        const currentPhase = getCurrentPhase(plant.phases);
        if (!currentPhase) continue;
        if (currentPhase.phase === PlantPhase.DEAD) continue;

        // 服务端有该字段时，<=0 说明该地当前不能再施有机肥
        if (Object.prototype.hasOwnProperty.call(plant, 'left_inorc_fert_times')) {
            const leftTimes = toNum(plant.left_inorc_fert_times);
            if (leftTimes <= 0) continue;
        }

        targets.push(landId);
    }
    return targets;
}

/**
 * 统一施肥入口
 * @param {number[]} plantedLands - 刚种植的地块 ID 列表
 * @param {object|null} cachedLandsReply - 可选，已缓存的 getAllLands 返回值，避免重复 API 调用
 */
async function runFertilizerByConfig(plantedLands = [], cachedLandsReply = null) {
    const fertilizerConfig = getAutomation().fertilizer || 'both';
    const smartPhaseEnabled = !!isAutomationOn('fertilizer_smart_phase');
    const planted = (Array.isArray(plantedLands) ? plantedLands : []).filter(Boolean);

    if (planted.length === 0 && fertilizerConfig !== 'organic' && fertilizerConfig !== 'both') {
        return { normal: 0, organic: 0 };
    }

    let fertilizedNormal = 0;
    let fertilizedOrganic = 0;

    if ((fertilizerConfig === 'normal' || fertilizerConfig === 'both') && planted.length > 0) {
        if (smartPhaseEnabled) {
            log('施肥', `智能二季施肥已开启：本轮跳过“播种后立即施普通肥”，等待最长生长期自动补肥`, {
                module: 'farm',
                event: 'fertilize',
                result: 'defer',
                type: 'normal',
                scope: 'smart_phase_defer',
                plantedCount: planted.length,
            });
        } else {
        fertilizedNormal = await fertilize(planted, NORMAL_FERTILIZER_ID);
        if (fertilizedNormal > 0) {
            log('施肥', `已为 ${fertilizedNormal}/${planted.length} 块地施无机化肥（范围：本轮新种植地块）`, {
                module: 'farm',
                event: 'fertilize',
                result: 'ok',
                type: 'normal',
                scope: 'newly_planted',
                count: fertilizedNormal,
            });
            recordOperation('fertilize', fertilizedNormal);
        }
        }
    }

    if (fertilizerConfig === 'organic' || fertilizerConfig === 'both') {
        let organicTargets = planted;
        try {
            // 优先使用缓存数据，避免重复 API 调用
            const landsData = cachedLandsReply || (await getAllLands());
            organicTargets = getOrganicFertilizerTargetsFromLands(landsData && landsData.lands);
        } catch (e) {
            logWarn('施肥', `获取全农场地块失败，回退已种地块: ${e.message}`);
        }

        fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
        if (fertilizedOrganic > 0) {
            log('施肥', `有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次（范围：全农场已种植地块）`, {
                module: 'farm',
                event: 'fertilize',
                result: 'ok',
                type: 'organic',
                scope: 'all_planted',
                count: fertilizedOrganic,
            });
            recordOperation('fertilize', fertilizedOrganic);
        }
    }

    return { normal: fertilizedNormal, organic: fertilizedOrganic };
}

function getLongestGrowPhaseValue(phases) {
    const list = Array.isArray(phases) ? phases : [];
    if (list.length < 2) return 0;
    let maxDuration = 0;
    let maxPhase = 0;
    for (let i = 0; i < list.length - 1; i++) {
        const cur = list[i];
        const next = list[i + 1];
        if (!cur || !next) continue;
        const curPhase = toNum(cur.phase);
        if (curPhase === PlantPhase.MATURE || curPhase === PlantPhase.DEAD) continue;
        const curBegin = toTimeSec(cur.begin_time);
        const nextBegin = toTimeSec(next.begin_time);
        const duration = nextBegin - curBegin;
        if (duration > maxDuration) {
            maxDuration = duration;
            maxPhase = curPhase;
        }
    }
    return maxPhase > 0 ? maxPhase : 0;
}

function collectSmartPhaseFertilizeTargets(lands) {
    const targets = [];
    const landsMap = buildLandMap(lands);
    for (const land of (Array.isArray(lands) ? lands : [])) {
        if (!land || !land.unlocked) continue;
        if (isOccupiedSlaveLand(land, landsMap)) continue;
        const landId = toNum(land.id);
        if (landId <= 0) continue;
        const plant = land.plant;
        if (!plant || !Array.isArray(plant.phases) || plant.phases.length < 2) continue;
        const plantCfg = getPlantById(toNum(plant.id));
        const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
        if (totalSeason <= 1) continue;
        const currentPhase = getCurrentPhase(plant.phases);
        if (!currentPhase) continue;
        const currentPhaseVal = toNum(currentPhase.phase);
        if (currentPhaseVal === PlantPhase.MATURE || currentPhaseVal === PlantPhase.DEAD) continue;
        const longestPhaseVal = getLongestGrowPhaseValue(plant.phases);
        if (longestPhaseVal <= 0 || currentPhaseVal !== longestPhaseVal) continue;
        const phaseBegin = toTimeSec(currentPhase.begin_time);
        const mark = `${currentPhaseVal}:${phaseBegin}`;
        if (smartPhaseFertilizeMarks.get(landId) === mark) continue;
        targets.push({ landId, mark, plantId: toNum(plant.id), totalSeason });
    }
    return targets;
}

async function runSmartPhaseFertilizer(lands) {
    if (!isAutomationOn('fertilizer_smart_phase')) return 0;
    const fertilizerConfig = getAutomation().fertilizer || 'both';
    if (fertilizerConfig !== 'normal' && fertilizerConfig !== 'both') return 0;
    const targets = collectSmartPhaseFertilizeTargets(lands);
    if (targets.length === 0) return 0;
    const landIds = targets.map(item => item.landId);
    const success = await fertilize(landIds, NORMAL_FERTILIZER_ID);
    if (success > 0) {
        for (let i = 0; i < success; i++) {
            const item = targets[i];
            if (!item) continue;
            smartPhaseFertilizeMarks.set(item.landId, item.mark);
        }
        log('施肥', `智能二季施肥触发：已为 ${success}/${targets.length} 块地补施普通肥（范围：多季作物最长生长期）`, {
            module: 'farm',
            event: 'fertilize_smart_phase',
            result: 'ok',
            type: 'normal',
            scope: 'multi_season_longest_phase',
            count: success,
            targetCount: targets.length,
            landIds: landIds.slice(0, success),
        });
        recordOperation('fertilize', success);
    }
    return success;
}

/**
 * [紧急通道版] 获取全部土地 - 优先于普通请求 (内建 Promise 合并缓存，防止并发探测风暴)
 */
async function getAllLandsUrgent() {
    const now = Date.now();
    // 500ms 内的并发调用直接复用同一个进行中/已完成的 Promise
    if (landsFetchPromise && (now - landsFetchTime < LANDS_CACHE_TTL_MS)) {
        return landsFetchPromise;
    }

    landsFetchTime = now;
    landsFetchPromise = (async () => {
        try {
            const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
            const { body: replyBody } = await sendMsgAsyncUrgent('gamepb.plantpb.PlantService', 'AllLands', body);
            return types.AllLandsReply.decode(replyBody);
        } catch (e) {
            // 熔断：发生错误立即清除，防止缓存雪崩，使得下一毫秒其他调用可以直接发起重传
            landsFetchPromise = null;
            throw e;
        }
    })();

    return landsFetchPromise;
}

/**
 * [紧急通道版] 施肥 - 优先于普通请求
 */
async function fertilizeUrgent(landId, fertilizerId = NORMAL_FERTILIZER_ID) {
    const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
        land_ids: [toLong(landId)],
        fertilizer_id: toLong(fertilizerId),
    })).finish();
    await sendMsgAsyncUrgent('gamepb.plantpb.PlantService', 'Fertilize', body);
}

/**
 * [紧急通道版] 收获 - 优先于普通请求
 */
async function harvestUrgent(landIds) {
    const state = getUserState();
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsyncUrgent('gamepb.plantpb.PlantService', 'Harvest', body);
    return types.HarvestReply.decode(replyBody);
}

function getFastHarvestTaskId(landId) {
    return `${FAST_HARVEST_TASK_PREFIX}${toNum(landId)}`;
}

function getLandUpgradeTarget() {
    const raw = Number.parseInt(getAutomation().landUpgradeTarget, 10);
    return Math.max(0, Math.min(6, Number.isFinite(raw) ? raw : 6));
}

async function executeFastHarvest(item) {
    const landId = toNum(item && item.landId);
    const plantLabel = item && item.plantName ? item.plantName : `土地#${landId}`;
    if (landId <= 0) return;

    try {
        const reply = await harvestUrgent([landId]);
        const harvested = Array.isArray(reply && reply.items) ? reply.items.length > 0 : true;
        if (harvested) {
            recordOperation('harvest', 1);
            log('秒收', `${plantLabel} 已在成熟瞬间收获`, {
                module: 'farm',
                event: 'fast_harvest',
                result: 'ok',
                landId,
            });
            networkEvents.emit('farmHarvested', {
                count: 1,
                landIds: [landId],
                opType: 'fast_harvest',
            });
            networkEvents.emit('farmStateChanged', {});
            return;
        }
        logWarn('秒收', `${plantLabel} 定时收获未返回有效掉落，可能已被提前处理`);
    } catch (error) {
        logWarn('秒收', `${plantLabel} 定时收获失败: ${error.message}`);
    }
}

function syncFastHarvestTasks(soonToMature) {
    const desired = new Map();
    for (const item of Array.isArray(soonToMature) ? soonToMature : []) {
        const landId = toNum(item && item.landId);
        if (landId > 0) desired.set(landId, item);
    }

    for (const taskName of farmScheduler.getTaskNames()) {
        if (!taskName.startsWith(FAST_HARVEST_TASK_PREFIX)) continue;
        const landId = Number.parseInt(taskName.slice(FAST_HARVEST_TASK_PREFIX.length), 10);
        if (!desired.has(landId)) {
            farmScheduler.clear(taskName);
        }
    }

    if (!getAutomation().fastHarvest) return;

    for (const item of desired.values()) {
        const taskId = getFastHarvestTaskId(item.landId);
        if (farmScheduler.has(taskId)) continue;

        const waitMs = Math.max(0, ((item.matureTime - getServerTimeSec()) * 1000) - FAST_HARVEST_ADVANCE_MS);
        farmScheduler.setTimeoutTask(taskId, waitMs, async () => {
            await executeFastHarvest(item);
        });
        log('秒收', `已为地块#${item.landId} 预设秒收任务 (约 ${Math.max(0, item.matureTime - getServerTimeSec())}s 后)`, {
            module: 'farm',
            event: 'fast_harvest_schedule',
            landId: toNum(item.landId),
            waitMs,
        });
    }
}

/**
 * 防偷抢收函数（60秒施肥并瞬间收获）- 全部使用紧急通道
 * ANTI_STEAL_MAX_MATURE_SEC = 75s (60s施肥加速 + 10s网络延迟 + 5s计时误差)
 */
const ANTI_STEAL_MAX_MATURE_SEC = 75;

async function antiStealHarvest(landId) {
    if (!landId) return;
    try {
        // [P0] 风控休眠绝对互斥屏障
        const state = getUserState();
        if (state.suspendUntil && Date.now() < state.suspendUntil) {
            logWarn('防封', `[防偷熔断] 账号正处于风控强休眠期(至 ${new Date(state.suspendUntil).toLocaleTimeString()})，强制阻断 土地#${landId} 防偷发包，宁弃菜保号！`);
            return;
        }

        // [P1/P2] 独立账号模式安全阻断
        const modePolicy = getRuntimeAccountModePolicy();
        const effectiveMode = String(modePolicy.effectiveMode || modePolicy.accountMode || 'main').trim().toLowerCase() || 'main';
        if (effectiveMode !== 'main') {
            logWarn('防封', `[模式屏蔽] 当前有效模式为 ${effectiveMode}，主动取消 土地#${landId} 的极限防偷操作，维护安全/错峰网络指纹。`, {
                module: 'farm',
                event: 'anti_steal_skip',
                result: 'blocked_by_mode',
                effectiveMode,
                degradeReason: modePolicy.degradeReason || '',
            });
            return;
        }

        // ==========================================
        // [Double Check: 实时状态探测机制] - 紧急通道
        // ==========================================
        const landsReply = await getAllLandsUrgent();
        if (!landsReply || !landsReply.lands) return;

        const land = landsReply.lands.find(l => toNum(l.id) === landId);
        if (!land || !land.unlocked) {
            log('防偷', `[保护拦截] 土地#${landId} 不存在或未解锁，已取消本次防偷执行`);
            return;
        }

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) {
            log('防偷', `[保护拦截] 土地#${landId} 为空地，可能已被提前收割，已取消防偷施肥以防浪费`);
            return;
        }

        const currentPhase = getCurrentPhase(plant.phases, false, `土地#${landId}`);
        if (!currentPhase) return;

        if (currentPhase.phase === PlantPhase.DEAD) {
            log('防偷', `[保护拦截] 土地#${landId} 植物已枯死，已取消防偷施肥`);
            return;
        }

        const maturePhase = Array.isArray(plant.phases)
            ? plant.phases.find((p) => p && toNum(p.phase) === PlantPhase.MATURE)
            : null;
        if (!maturePhase) return;

        const matureBegin = toTimeSec(maturePhase.begin_time);
        const nowSec = getServerTimeSec();
        const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;

        if (matureInSec <= 0 || matureInSec > ANTI_STEAL_MAX_MATURE_SEC) {
            log('防偷', `[保护拦截] 土地#${landId} 发生生命周期漂移(当前距成熟:${matureInSec}s, 阈值:${ANTI_STEAL_MAX_MATURE_SEC}s)，判定为玩家人为干预复种或抢收，已免除本次动作，成功保卫化肥资产`);
            return;
        }

        log('防偷', `[实况校验通过] 土地#${landId} 距离成熟还剩 ${matureInSec} 秒，准备施肥抢收...`, {
            module: 'farm', event: 'anti_steal_trigger', landId, matureInSec
        });

        // 1. [紧急通道] 施肥
        try {
            await fertilizeUrgent(landId, NORMAL_FERTILIZER_ID);
            // 2. [紧急通道] 瞬间收获
            await harvestUrgent([landId]);
            recordOperation('harvest', 1);
            recordOperation('fertilize', 1);
            log('防偷', `[抢收成功] 土地#${landId} 防偷化肥施放并瞬间收获完成！`, {
                module: 'farm', event: 'anti_steal_success', result: 'ok', landId
            });
            networkEvents.emit('farmHarvested', {
                count: 1,
                landIds: [landId],
                opType: 'anti_steal'
            });
            networkEvents.emit('farmStateChanged', {});
        } catch (e) {
            logWarn('防偷', `土地#${landId} 防偷施肥失败(可能无化肥)，降级为普通等待模式`, {
                module: 'farm', event: 'anti_steal_fallback', result: 'no_fertilizer', landId
            });
        }
    } catch (e) {
        logWarn('防偷', `土地#${landId} 防偷执行异常: ${e.message}`);
    }
}

async function removePlant(landIds) {
    const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
        land_ids: landIds.map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
    return types.RemovePlantReply.decode(replyBody);
}

async function upgradeLand(landId) {
    const body = types.UpgradeLandRequest.encode(types.UpgradeLandRequest.create({
        land_id: toLong(landId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UpgradeLand', body);
    return types.UpgradeLandReply.decode(replyBody);
}

async function unlockLand(landId, doShared = false) {
    const body = types.UnlockLandRequest.encode(types.UnlockLandRequest.create({
        land_id: toLong(landId),
        do_shared: !!doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UnlockLand', body);
    return types.UnlockLandReply.decode(replyBody);
}

// ============ 商店 API ============

async function getShopInfo(shopId) {
    const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
        shop_id: toLong(shopId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
    return types.ShopInfoReply.decode(replyBody);
}

async function buyGoods(goodsId, num, price) {
    const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
        goods_id: toLong(goodsId),
        num: toLong(num),
        price: toLong(price),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
    return types.BuyGoodsReply.decode(replyBody);
}

// ============ 种植 ============

function encodePlantRequest(seedId, landIds) {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    itemWriter.ldelim();
    return writer.finish();
}

function buildLandMap(lands) {
    const map = new Map();
    for (const land of Array.isArray(lands) ? lands : []) {
        const landId = toNum(land && land.id);
        if (!landId) continue;
        map.set(landId, land);
    }
    return map;
}

function getSlaveLandIds(land) {
    const ids = Array.isArray(land && land.slave_land_ids) ? land.slave_land_ids : [];
    return [...new Set(ids.map(id => toNum(id)).filter(Boolean))];
}

function hasPlantData(land) {
    const plant = land && land.plant;
    return !!(plant && Array.isArray(plant.phases) && plant.phases.length > 0);
}

function getLinkedMasterLand(land, landsMap) {
    const landId = toNum(land && land.id);
    const masterLandId = toNum(land && land.master_land_id);
    if (!masterLandId || masterLandId === landId) return null;

    const masterLand = landsMap.get(masterLandId);
    if (!masterLand) return null;

    const slaveIds = getSlaveLandIds(masterLand);
    if (slaveIds.length > 0 && !slaveIds.includes(landId)) return null;

    return masterLand;
}

function getDisplayLandContext(land, landsMap) {
    const masterLand = getLinkedMasterLand(land, landsMap);
    if (masterLand && hasPlantData(masterLand)) {
        const occupiedLandIds = [toNum(masterLand.id), ...getSlaveLandIds(masterLand)].filter(Boolean);
        return {
            sourceLand: masterLand,
            occupiedByMaster: true,
            masterLandId: toNum(masterLand.id),
            occupiedLandIds: occupiedLandIds.length > 0 ? occupiedLandIds : [toNum(masterLand.id)].filter(Boolean),
        };
    }

    const selfId = toNum(land && land.id);
    return {
        sourceLand: land,
        occupiedByMaster: false,
        masterLandId: selfId,
        occupiedLandIds: [selfId].filter(Boolean),
    };
}

function isOccupiedSlaveLand(land, landsMap) {
    return !!getDisplayLandContext(land, landsMap).occupiedByMaster;
}

function getPlantSizeBySeedId(seedId) {
    const plantCfg = getPlantBySeedId(toNum(seedId));
    return Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
}

/**
 * 种植 - 游戏中拖动种植间隔很短，这里用 50ms
 */
function isLandOccupiedPlantError(error) {
    const msg = String((error && error.message) || error || '');
    return msg.includes('code=1001008') || msg.includes('土地已种植');
}

async function plantSeeds(seedId, landIds, options = {}) {
    const result = {
        planted: 0,
        plantedLandIds: [],
        occupiedLandIds: [],
        failedLandIds: [],
    };
    const maxPlantCount = Math.max(0, toNum(options.maxPlantCount) || 0) || Number.POSITIVE_INFINITY;
    const occupiedLandSet = new Set();
    const pendingLandIds = new Set((Array.isArray(landIds) ? landIds : []).map(id => toNum(id)).filter(Boolean));

    for (const landId of landIds) {
        const normalizedLandId = toNum(landId);
        if (!normalizedLandId || !pendingLandIds.has(normalizedLandId)) continue;
        if (result.planted >= maxPlantCount) break;

        try {
            const body = encodePlantRequest(seedId, [normalizedLandId]);
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
            const reply = types.PlantReply.decode(replyBody);
            const changedLands = Array.isArray(reply && reply.land) ? reply.land : [];
            const changedMap = buildLandMap(changedLands);
            const selfLand = changedMap.get(normalizedLandId);
            const displayContext = getDisplayLandContext(selfLand || { id: normalizedLandId }, changedMap);
            const occupiedIds = displayContext.occupiedLandIds.length > 0
                ? displayContext.occupiedLandIds
                : [normalizedLandId];

            result.planted += 1;
            result.plantedLandIds.push(displayContext.masterLandId || normalizedLandId);
            for (const occupiedId of occupiedIds) {
                occupiedLandSet.add(occupiedId);
                pendingLandIds.delete(occupiedId);
            }
        } catch (e) {
            if (isLandOccupiedPlantError(e)) {
                occupiedLandSet.add(normalizedLandId);
                pendingLandIds.delete(normalizedLandId);
            } else {
                result.failedLandIds.push(normalizedLandId);
            }
            logWarn('种植', `土地#${normalizedLandId} 失败: ${e.message}`);
        }
        // Phase 3: 种植动作增加随机抖动 (200ms - 500ms) 防查
        await sleep(200 + Math.floor(Math.random() * 300));
    }
    result.occupiedLandIds = [...occupiedLandSet];
    return result;
}

async function findBestSeed(options = {}) {
    const SEED_SHOP_ID = 2;
    const shopReply = await getShopInfo(SEED_SHOP_ID);
    if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
        logWarn('商店', '种子商店无商品');
        return null;
    }

    const state = getUserState();
    const available = [];
    for (const goods of shopReply.goods_list) {
        if (!goods.unlocked) continue;

        let meetsConditions = true;
        let requiredLevel = 0;
        const conds = goods.conds || [];
        for (const cond of conds) {
            if (toNum(cond.type) === 1) {
                requiredLevel = toNum(cond.param);
                if (state.level < requiredLevel) {
                    meetsConditions = false;
                    break;
                }
            }
        }
        if (!meetsConditions) continue;

        const limitCount = toNum(goods.limit_count);
        const boughtNum = toNum(goods.bought_num);
        if (limitCount > 0 && boughtNum >= limitCount) continue;

        available.push({
            goods,
            goodsId: toNum(goods.id),
            seedId: toNum(goods.item_id),
            price: toNum(goods.price),
            requiredLevel,
        });
    }

    if (available.length === 0) {
        logWarn('商店', '没有可购买的种子');
        return null;
    }

    const configSnapshot = getConfigSnapshot() || {};
    const inventoryPlanting = normalizeInventoryPlantingConfig(configSnapshot.inventoryPlanting);
    const inventoryMode = inventoryPlanting.mode;
    const workflowOverride = getWorkflowSelectSeedOverride(configSnapshot.workflowConfig);
    const strategy = workflowOverride ? workflowOverride.strategy : getPlantingStrategy();
    const fallbackStrategy = configSnapshot.plantingFallbackStrategy || 'level';
    const preferredSeedId = getPreferredSeed();
    const targetLandCount = Math.max(0, Number.parseInt(options.landCount, 10) || 0);
    const currentGold = Math.max(0, toNum(options.gold !== undefined ? options.gold : state.gold));
    const analyticsSortBy = ANALYTICS_SORT_BY_MAP[strategy];
    let bagDetail = null;
    let candidateAvailable = [...available];
    let rankings = [];
    let analyticsError = null;

    if (inventoryMode !== 'disabled') {
        try {
            bagDetail = await getBagDetail();
        } catch (e) {
            logWarn('背包', `读取种子库存失败: ${e.message}，本轮退回商店选种`, {
                module: 'farm',
                event: 'inventory_seed_load',
                result: 'error',
                inventoryMode,
            });
        }
        candidateAvailable = filterPlantingCandidatesByInventoryMode(
            buildPlantingCandidates(available, bagDetail, inventoryPlanting),
            inventoryMode,
        );
    }

    if (candidateAvailable.length === 0) {
        if (inventoryMode === 'inventory_only') {
            logWarn('库存', '库存仅种模式下没有可用种子，已暂停本轮种植', {
                module: 'farm',
                event: 'inventory_seed_empty',
                result: 'no_inventory_seed',
                inventoryMode,
            });
            return null;
        }
        logWarn('商店', '没有可购买的种子');
        return null;
    }

    if (analyticsSortBy) {
        try {
            rankings = getPlantRankings(analyticsSortBy, null, {
                accountConfig: configSnapshot,
                timingMode: 'actual',
            });
        } catch (e) {
            analyticsError = e;
        }
    }

    const picked = pickSeedByStrategy({
        available: candidateAvailable,
        strategy,
        fallbackStrategy,
        preferredSeedId,
        accountLevel: state.level,
        rankings,
    });

    if (!picked.seed) {
        logWarn('商店', `策略 ${strategy} 未命中可种作物，且回退策略=${picked.fallbackStrategy || fallbackStrategy} 未选出种子，本轮暂停种植`);
        return null;
    }

    let plannedCount = targetLandCount > 0 ? targetLandCount : 0;
    let plannedCost = plannedCount > 0 ? (picked.seed.price * plannedCount) : 0;
    let buyCount = plannedCount;
    let inventoryUseCount = 0;
    let budgetOptimized = false;
    let budgetMetricField = '';
    let budgetMetricValue = 0;
    let budgetTotalScore = 0;
    let budgetBaseSeedId = picked.seed.seedId;
    let budgetBasePlantedCount = targetLandCount > 0
        ? Math.min(targetLandCount, picked.seed.price > 0 ? Math.floor(currentGold / picked.seed.price) : targetLandCount)
        : 0;
    let budgetBaseTotalScore = 0;

    if (analyticsSortBy && targetLandCount > 0) {
        const budgetPlan = pickBudgetOptimizedPlan({
            available: candidateAvailable,
            rankings,
            strategy,
            timingMode: 'actual',
            inventoryMode,
            gold: currentGold,
            landCount: targetLandCount,
            selectedSeedId: picked.seed.seedId,
        });
        if (budgetPlan && budgetPlan.seed) {
            picked.seed = budgetPlan.seed;
            plannedCount = budgetPlan.plantedCount;
            plannedCost = budgetPlan.totalCost;
            budgetOptimized = !!budgetPlan.changed;
            budgetMetricField = budgetPlan.metricField || '';
            budgetMetricValue = budgetPlan.metricValue || 0;
            budgetTotalScore = budgetPlan.totalScore || 0;
            budgetBaseSeedId = budgetPlan.baseSeedId || budgetBaseSeedId;
            budgetBasePlantedCount = budgetPlan.basePlantedCount || budgetBasePlantedCount;
            budgetBaseTotalScore = budgetPlan.baseTotalScore || 0;
        }
    }

    const sourcePlan = getInventorySourcePlan({
        seed: picked.seed,
        mode: inventoryMode,
        landCount: targetLandCount,
        gold: currentGold,
    });
    plannedCount = sourcePlan.plantedCount;
    plannedCost = sourcePlan.totalCost;
    buyCount = sourcePlan.buyCount;
    inventoryUseCount = sourcePlan.inventoryUseCount;

    if (analyticsError) {
        logWarn('商店', `策略 ${strategy} 计算失败: ${analyticsError.message}，回退 ${picked.fallbackStrategy || fallbackStrategy}`);
    } else if (picked.fallbackReason === 'analytics_no_match') {
        logWarn('商店', `策略 ${strategy} 未找到可购买作物，回退 ${picked.fallbackStrategy || fallbackStrategy}`);
    } else if (picked.fallbackReason === 'preferred_unavailable') {
        logWarn('商店', `优先种子 ${picked.preferredSeedId} 当前不可购买，回退自动选择`);
    }

    return {
        ...picked.seed,
        strategy,
        strategySource: workflowOverride ? 'workflow' : 'settings',
        fallbackStrategy: picked.fallbackStrategy || fallbackStrategy,
        selectionType: picked.selectionType,
        fallbackReason: picked.fallbackReason,
        plannedCount,
        plannedCost,
        budgetOptimized,
        budgetMetricField,
        budgetMetricValue,
        budgetTotalScore,
        budgetBaseSeedId,
        budgetBasePlantedCount,
        budgetBaseTotalScore,
        inventoryMode,
        inventoryUseCount,
        buyCount,
        inventoryTotalCount: picked.seed.inventoryTotalCount || 0,
        inventoryReservedCount: picked.seed.inventoryReservedCount || 0,
        inventoryUsableCount: picked.seed.inventoryUsableCount || 0,
    };
}

async function getAvailableSeeds() {
    const SEED_SHOP_ID = 2;
    const state = getUserState();
    let list = [];

    try {
        const shopReply = await getShopInfo(SEED_SHOP_ID);
        if (shopReply.goods_list) {
            for (const goods of shopReply.goods_list) {
                // 不再过滤不可用的种子，而是返回给前端展示状态
                let requiredLevel = 0;
                for (const cond of goods.conds || []) {
                    if (toNum(cond.type) === 1) requiredLevel = toNum(cond.param);
                }

                const limitCount = toNum(goods.limit_count);
                const boughtNum = toNum(goods.bought_num);
                const isSoldOut = limitCount > 0 && boughtNum >= limitCount;

                list.push({
                    seedId: toNum(goods.item_id),
                    goodsId: toNum(goods.id),
                    name: getPlantNameBySeedId(toNum(goods.item_id)),
                    price: toNum(goods.price),
                    requiredLevel,
                    locked: !goods.unlocked || state.level < requiredLevel,
                    soldOut: isSoldOut,
                });
            }
        }
    } catch (e) {
        const wsErr = getWsErrorState();
        if (!wsErr || Number(wsErr.code) !== 400) {
            logWarn('商店', `获取商店失败: ${e.message}，使用本地备选列表`);
        }
    }

    // 如果商店请求失败或为空，使用本地配置
    if (list.length === 0) {
        const allSeeds = getAllSeeds();
        list = allSeeds.map(s => ({
            ...s,
            goodsId: 0,
            price: null, // 未知价格
            requiredLevel: null, // 未知等级
            unknownMeta: true,
            locked: false,
            soldOut: false,
        }));
    }
    return list.sort((a, b) => {
        const av = (a.requiredLevel === null || a.requiredLevel === undefined) ? 9999 : a.requiredLevel;
        const bv = (b.requiredLevel === null || b.requiredLevel === undefined) ? 9999 : b.requiredLevel;
        return av - bv;
    });
}

async function getLandsDetail() {
    try {
        const landsReply = await getAllLands();
        if (!landsReply.lands) return { lands: [], summary: {} };
        const status = analyzeLands(landsReply.lands);
        const nowSec = getServerTimeSec();
        const landsMap = buildLandMap(landsReply.lands);
        const lands = [];

        for (const land of landsReply.lands) {
            const id = toNum(land.id);
            const level = toNum(land.level);
            const maxLevel = toNum(land.max_level);
            const landsLevel = toNum(land.lands_level);
            const landSize = toNum(land.land_size);
            const couldUnlock = !!land.could_unlock;
            const couldUpgrade = !!land.could_upgrade;
            const {
                sourceLand,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
            } = getDisplayLandContext(land, landsMap);
            if (!land.unlocked) {
                lands.push({
                    id,
                    unlocked: false,
                    status: 'locked',
                    plantName: '',
                    phaseName: '',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster: false,
                    masterLandId: 0,
                    occupiedLandIds: [],
                    plantSize: 1,
                });
                continue;
            }
            const plant = sourceLand && sourceLand.plant;
            const lifecycle = resolveLandLifecycle(sourceLand);
            if (lifecycle.status === 'empty') {
                lands.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '空地',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const currentPhase = lifecycle.currentPhase;
            const phaseVal = lifecycle.phaseVal;
            const plantId = toNum(plant.id);
            const plantName = getPlantName(plantId) || plant.name || '未知';
            const plantCfg = getPlantById(plantId);
            const seedId = toNum(plantCfg && plantCfg.seed_id);
            const seedImage = seedId > 0 ? getSeedImageBySeedId(seedId) : '';
            const plantSize = Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
            const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
            const currentSeasonRaw = toNum(plant.season);
            const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
            const phaseName = lifecycle.status === 'occupied_unknown'
                ? '同步中'
                : (PHASE_NAMES[phaseVal] || '');
            const maturePhase = Array.isArray(plant.phases)
                ? plant.phases.find((p) => p && toNum(p.phase) === PlantPhase.MATURE)
                : null;
            const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
            const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;

            let landStatus = 'growing';
            if (phaseVal === PlantPhase.MATURE) landStatus = 'harvestable';
            else if (phaseVal === PlantPhase.DEAD) landStatus = 'dead';

            const needWater = !!((toNum(plant.dry_num) > 0) || (currentPhase && toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= nowSec));
            const needWeed = !!((plant.weed_owners && plant.weed_owners.length > 0) || (currentPhase && toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= nowSec));
            const needBug = !!((plant.insect_owners && plant.insect_owners.length > 0) || (currentPhase && toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= nowSec));

            lands.push({
                id,
                unlocked: true,
                status: landStatus,
                plantName,
                seedId,
                seedImage,
                phaseName,
                currentSeason,
                totalSeason,
                matureInSec,
                needWater,
                needWeed,
                needBug,
                stealable: !!plant.stealable,
                level,
                maxLevel,
                landsLevel,
                landSize,
                couldUnlock,
                couldUpgrade,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
                plantSize,
            });
        }

        return {
            lands,
            summary: {
                harvestable: status.harvestable.length,
                growing: status.growing.length,
                empty: status.empty.length,
                dead: status.dead.length,
                needWater: status.needWater.length,
                needWeed: status.needWeed.length,
                needBug: status.needBug.length,
            },
        };
    } catch {
        return { lands: [], summary: {} };
    }
}

async function autoPlantEmptyLands(deadLandIds, emptyLandIds, cachedLandsReply = null) {
    let landsToPlant = [...new Set((emptyLandIds || []).map((id) => toNum(id)).filter((id) => id > 0))];
    const state = getUserState();
    const summary = {
        removedDeadLandIds: [],
        plantableLandIds: [],
        plantedLandIds: [],
        occupiedLandIds: [],
        failedLandIds: [],
        boughtSeedCount: 0,
    };

    // 1. 铲除枯死/收获残留植物（一键操作）
    if (deadLandIds.length > 0) {
        try {
            await removePlant(deadLandIds);
            log('铲除', `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(',')})`, {
                module: 'farm', event: 'remove_plant', result: 'ok', count: deadLandIds.length
            });
            summary.removedDeadLandIds = [...deadLandIds];
            landsToPlant.push(...deadLandIds);
        } catch (e) {
            logWarn('铲除', `批量铲除失败: ${e.message}`, {
                module: 'farm', event: 'remove_plant', result: 'error'
            });
        }
    }

    landsToPlant = [...new Set(landsToPlant.map((id) => toNum(id)).filter((id) => id > 0))];
    const cooldownFilter = filterCoolingDownLandIds(landsToPlant);
    if (cooldownFilter.skipped.length > 0) {
        log('种植', `土地#${cooldownFilter.skipped.join(',')} 刚返回过“已种植”，冷却期内跳过复种`, {
            module: 'farm',
            event: 'plant_skip_cooldown',
            result: 'cooldown',
            landIds: cooldownFilter.skipped,
        });
    }
    landsToPlant = cooldownFilter.allowed;
    if (landsToPlant.length === 0) return summary;

    // 2. 种植前复核，避免旧快照把已占用土地误判为空地
    landsToPlant = await filterPlantableLandIds(landsToPlant);
    if (landsToPlant.length === 0) {
        log('种植', '种植前复核后没有可下种的空地，跳过本轮买种子/种植', {
            module: 'farm',
            event: 'plant_skip_after_verify',
            result: 'no_empty_land',
        });
        return summary;
    }
    summary.plantableLandIds = [...landsToPlant];

    // 3. 查询种子商店
    let bestSeed;
    try {
        bestSeed = await findBestSeed({
            landCount: landsToPlant.length,
            gold: state.gold,
        });
    } catch (e) {
        logWarn('商店', `查询失败: ${e.message}`);
        return summary;
    }
    if (!bestSeed) return summary;

    const seedName = getPlantNameBySeedId(bestSeed.seedId);
    const growTime = getPlantGrowTime(1020000 + (bestSeed.seedId - 20000));  // 转换为植物ID
    const growTimeStr = growTime > 0 ? ` 生长${formatGrowTime(growTime)}` : '';
    const plantSize = getPlantSizeBySeedId(bestSeed.seedId);
    const landFootprint = plantSize * plantSize;
    const sourcePlan = getInventorySourcePlan({
        seed: bestSeed,
        mode: bestSeed.inventoryMode || 'disabled',
        landCount: Math.ceil(landsToPlant.length / landFootprint),
        gold: state.gold,
    });
    log('商店', `最佳种子: ${seedName} (${bestSeed.seedId}) 价格=${bestSeed.price}金币${growTimeStr}`, {
        module: 'warehouse',
        event: 'seed_pick',
        seedId: bestSeed.seedId,
        price: bestSeed.price,
        strategy: bestSeed.strategy || getPlantingStrategy(),
        strategySource: bestSeed.strategySource || 'settings',
        fallbackStrategy: bestSeed.fallbackStrategy || ((getConfigSnapshot() || {}).plantingFallbackStrategy || 'level'),
        selectionType: bestSeed.selectionType || 'level',
        fallbackReason: bestSeed.fallbackReason || '',
        plannedCount: bestSeed.plannedCount || landsToPlant.length,
        plannedCost: bestSeed.plannedCost || 0,
        budgetOptimized: !!bestSeed.budgetOptimized,
        budgetMetricField: bestSeed.budgetMetricField || '',
        budgetMetricValue: bestSeed.budgetMetricValue || 0,
        budgetTotalScore: bestSeed.budgetTotalScore || 0,
        budgetBaseSeedId: bestSeed.budgetBaseSeedId || bestSeed.seedId,
        budgetBasePlantedCount: bestSeed.budgetBasePlantedCount || 0,
        budgetBaseTotalScore: bestSeed.budgetBaseTotalScore || 0,
        inventoryMode: bestSeed.inventoryMode || 'disabled',
        inventoryTotalCount: bestSeed.inventoryTotalCount || 0,
        inventoryReservedCount: bestSeed.inventoryReservedCount || 0,
        inventoryUsableCount: bestSeed.inventoryUsableCount || 0,
        inventoryUseCount: sourcePlan.inventoryUseCount || 0,
        buyCount: sourcePlan.buyCount || 0,
    });

    // 4. 购买
    let needCount = Math.ceil(landsToPlant.length / landFootprint);
    if (bestSeed.budgetOptimized) {
        const baseSeedName = bestSeed.budgetBaseSeedId > 0 ? getPlantNameBySeedId(bestSeed.budgetBaseSeedId) : '';
        const metricLabel = STRATEGY_METRIC_LABELS[bestSeed.budgetMetricField] || '总收益';
        log('商店', `预算优化: ${baseSeedName || '原方案'} 仅能种 ${bestSeed.budgetBasePlantedCount} 块，改选 ${seedName} 可种 ${bestSeed.plannedCount} 块，${metricLabel}更高`, {
            module: 'warehouse',
            event: 'seed_budget_optimize',
            result: 'ok',
            seedId: bestSeed.seedId,
            baseSeedId: bestSeed.budgetBaseSeedId || 0,
            plannedCount: bestSeed.plannedCount || 0,
            basePlantedCount: bestSeed.budgetBasePlantedCount || 0,
            metricField: bestSeed.budgetMetricField || '',
            metricValue: bestSeed.budgetMetricValue || 0,
            totalScore: bestSeed.budgetTotalScore || 0,
            baseTotalScore: bestSeed.budgetBaseTotalScore || 0,
        });
    }
    if (Number.isFinite(Number(sourcePlan.plantedCount)) && Number(sourcePlan.plantedCount) >= 0 && Number(sourcePlan.plantedCount) < needCount) {
        landsToPlant = landsToPlant.slice(0, Number(sourcePlan.plantedCount) * landFootprint);
        needCount = Math.ceil(landsToPlant.length / landFootprint);
        summary.plantableLandIds = [...landsToPlant];
        log('商店', `预算/库存限制下本轮计划种植 ${needCount} 组作物`, {
            module: 'warehouse',
            event: 'seed_budget_limit',
            result: 'planned',
            seedId: bestSeed.seedId,
            count: needCount,
        });
    }
    if (needCount <= 0 || landsToPlant.length <= 0) {
        logWarn('商店', '库存/金币约束下本轮没有可实际种植的作物，已跳过', {
            module: 'warehouse',
            event: 'seed_plan_skip',
            result: 'no_plantable_seed',
            seedId: bestSeed.seedId,
            inventoryMode: bestSeed.inventoryMode || 'disabled',
        });
        return summary;
    }
    const effectiveInventoryUseCount = Math.min(needCount, Math.max(0, Number(sourcePlan.inventoryUseCount || 0)));
    let effectiveBuyCount = Math.min(Math.max(0, Number(sourcePlan.buyCount || 0)), Math.max(0, needCount - effectiveInventoryUseCount));
    const totalCost = bestSeed.price * effectiveBuyCount;
    if (effectiveBuyCount > 0 && totalCost > state.gold) {
        logWarn('商店', `金币不足! 需要 ${totalCost} 金币, 当前 ${state.gold} 金币`, {
            module: 'farm', event: 'seed_buy_skip', result: 'insufficient_gold', need: totalCost, current: state.gold
        });
        const canBuy = Math.floor(state.gold / bestSeed.price);
        if ((effectiveInventoryUseCount + canBuy) <= 0) return summary;
        effectiveBuyCount = canBuy;
        needCount = effectiveInventoryUseCount + effectiveBuyCount;
        landsToPlant = landsToPlant.slice(0, needCount * landFootprint);
        summary.plantableLandIds = [...landsToPlant];
        log('商店', plantSize > 1
            ? `金币有限，本轮库存种 ${effectiveInventoryUseCount} 组，补买种 ${effectiveBuyCount} 组 ${plantSize}x${plantSize} 作物`
            : `金币有限，本轮库存种 ${effectiveInventoryUseCount} 块，补买种 ${effectiveBuyCount} 块`);
    }

    let actualSeedId = bestSeed.seedId;
    if (effectiveInventoryUseCount > 0) {
        log('库存', `优先消耗 ${seedName} 库存种子 x${effectiveInventoryUseCount}，保留 ${bestSeed.inventoryReservedCount || 0}，当前可用 ${bestSeed.inventoryUsableCount || 0}`, {
            module: 'warehouse',
            event: 'seed_inventory_use',
            result: 'ok',
            seedId: bestSeed.seedId,
            inventoryMode: bestSeed.inventoryMode || 'disabled',
            inventoryUseCount: effectiveInventoryUseCount,
            inventoryReservedCount: bestSeed.inventoryReservedCount || 0,
            inventoryUsableCount: bestSeed.inventoryUsableCount || 0,
        });
    }
    if (effectiveBuyCount > 0) {
      try {
        const buyReply = await buyGoods(bestSeed.goodsId, effectiveBuyCount, bestSeed.price);
        if (buyReply.get_items && buyReply.get_items.length > 0) {
            const gotItem = buyReply.get_items[0];
            const gotId = toNum(gotItem.id);
            if (gotId > 0) actualSeedId = gotId;
        }
        if (buyReply.cost_items) {
            for (const item of buyReply.cost_items) {
                state.gold -= toNum(item.count);
            }
        }
        const boughtName = getPlantNameBySeedId(actualSeedId);
        summary.boughtSeedCount = effectiveBuyCount;
        log('购买', plantSize > 1
            ? `已购买 ${boughtName}种子 x${effectiveBuyCount}（${plantSize}x${plantSize}合种）`
            : `已购买 ${boughtName}种子 x${effectiveBuyCount}, 花费 ${bestSeed.price * effectiveBuyCount} 金币`, {
            module: 'warehouse',
            event: 'seed_buy',
            result: 'ok',
            seedId: actualSeedId,
            count: effectiveBuyCount,
            cost: bestSeed.price * effectiveBuyCount,
        });
      } catch (e) {
          logWarn('购买', e.message);
          return summary;
      }
    }

    // 5. 种植（逐块拖动，间隔50ms）
    let plantedLands = [];
    try {
        const plantResult = await plantSeeds(actualSeedId, landsToPlant, { maxPlantCount: needCount });
        summary.plantedLandIds = [...plantResult.plantedLandIds];
        summary.occupiedLandIds = [...plantResult.occupiedLandIds];
        summary.failedLandIds = [...plantResult.failedLandIds];

        if (plantResult.plantedLandIds.length > 0) {
            const occupiedCount = plantResult.occupiedLandIds.length > 0 ? plantResult.occupiedLandIds.length : plantResult.plantedLandIds.length;
            log('种植', plantSize > 1
                ? `已种植 ${plantResult.plantedLandIds.length} 组 ${plantSize}x${plantSize} 作物，占用 ${occupiedCount} 块地 (${plantResult.occupiedLandIds.join(',')})`
                : `已在 ${plantResult.plantedLandIds.length} 块地种植 (${plantResult.plantedLandIds.join(',')})`, {
                module: 'farm',
                event: 'plant_seed',
                result: 'ok',
                seedId: actualSeedId,
                count: plantResult.plantedLandIds.length,
                occupiedCount,
            });
            plantedLands = [...plantResult.plantedLandIds];
        }
        if (plantResult.occupiedLandIds.length > 0) {
            markOccupiedLandCooldown(plantResult.occupiedLandIds);
            logWarn('种植', `种植前后状态发生漂移: 土地#${plantResult.occupiedLandIds.join(',')} 已被占用，已停止对这些地块的重复补种`, {
                module: 'farm',
                event: 'plant_seed_skip',
                result: 'occupied',
                seedId: actualSeedId,
                count: plantResult.occupiedLandIds.length,
            });
        }
    } catch (e) {
        logWarn('种植', e.message);
    }

    // 6. 施肥（传入缓存 lands 数据避免重复 API 调用）
    // 如果启用了流程编排模式，施肥交给 stage_fertilize 节点按阶段处理
    // 传统模式下保持种植后立即施肥的行为
    const fullCfg = getConfigSnapshot() || {};
    const farmWorkflowEnabled = fullCfg.workflowConfig?.farm?.enabled;
    if (!farmWorkflowEnabled) {
        await runFertilizerByConfig(plantedLands, cachedLandsReply);
    } else {
        log('种植', `流程编排模式已启用，跳过种植后立即施肥，交由阶段施肥节点处理`);
    }

    return summary;
}

function getCurrentPhase(phases, debug, landLabel) {
    if (!phases || phases.length === 0) return null;

    const nowSec = getServerTimeSec();

    if (debug) {
        console.warn(`    ${landLabel} 服务器时间=${nowSec} (${new Date(nowSec * 1000).toLocaleTimeString()})`);
        for (let i = 0; i < phases.length; i++) {
            const p = phases[i];
            const bt = toTimeSec(p.begin_time);
            const phaseName = PHASE_NAMES[p.phase] || `阶段${p.phase}`;
            const diff = bt > 0 ? (bt - nowSec) : 0;
            const diffStr = diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : '';
            console.warn(`    ${landLabel}   [${i}] ${phaseName}(${p.phase}) begin=${bt} ${diffStr} dry=${toTimeSec(p.dry_time)} weed=${toTimeSec(p.weeds_time)} insect=${toTimeSec(p.insect_time)}`);
        }
    }

    for (let i = phases.length - 1; i >= 0; i--) {
        const beginTime = toTimeSec(phases[i].begin_time);
        if (beginTime > 0 && beginTime <= nowSec) {
            if (debug) {
                console.warn(`    ${landLabel}   → 当前阶段: ${PHASE_NAMES[phases[i].phase] || phases[i].phase}`);
            }
            return phases[i];
        }
    }

    if (debug) {
        console.warn(`    ${landLabel}   → 所有阶段都在未来，使用第一个: ${PHASE_NAMES[phases[0].phase] || phases[0].phase}`);
    }
    return phases[0];
}

function hasMeaningfulPlantData(plant) {
    if (!plant) return false;
    if (toNum(plant.id) > 0) return true;
    if ((plant.name || '').trim()) return true;
    if (toNum(plant.grow_sec) > 0) return true;
    if (toNum(plant.fruit_id) > 0) return true;
    if (toNum(plant.fruit_num) > 0) return true;
    if (toNum(plant.season) > 0) return true;
    if (Array.isArray(plant.weed_owners) && plant.weed_owners.length > 0) return true;
    if (Array.isArray(plant.insect_owners) && plant.insect_owners.length > 0) return true;
    if (Array.isArray(plant.stealers) && plant.stealers.length > 0) return true;
    return false;
}

function resolveLandLifecycle(land, debug = false, landLabel = '') {
    const plant = land && land.plant;
    if (!plant) {
        return { status: 'empty', plant: null, currentPhase: null, phaseVal: PlantPhase.UNKNOWN };
    }

    const phases = Array.isArray(plant.phases) ? plant.phases : [];
    if (phases.length === 0) {
        if (hasMeaningfulPlantData(plant)) {
            return { status: 'occupied_unknown', plant, currentPhase: null, phaseVal: PlantPhase.UNKNOWN };
        }
        return { status: 'empty', plant, currentPhase: null, phaseVal: PlantPhase.UNKNOWN };
    }

    const currentPhase = getCurrentPhase(phases, debug, landLabel);
    if (!currentPhase) {
        if (hasMeaningfulPlantData(plant)) {
            return { status: 'occupied_unknown', plant, currentPhase: null, phaseVal: PlantPhase.UNKNOWN };
        }
        return { status: 'empty', plant, currentPhase: null, phaseVal: PlantPhase.UNKNOWN };
    }

    const phaseVal = toNum(currentPhase.phase);
    if (phaseVal === PlantPhase.DEAD) {
        return { status: 'dead', plant, currentPhase, phaseVal };
    }
    if (phaseVal === PlantPhase.MATURE) {
        return { status: 'mature', plant, currentPhase, phaseVal };
    }
    return { status: 'growing', plant, currentPhase, phaseVal };
}

async function filterPlantableLandIds(landIds) {
    const requestedLandIds = [...new Set((landIds || []).map((id) => toNum(id)).filter((id) => id > 0))];
    if (requestedLandIds.length === 0) return [];

    try {
        const refreshedReply = await getAllLands();
        if (!refreshedReply.lands || refreshedReply.lands.length === 0) {
            return [];
        }

        const refreshedStatus = analyzeLands(refreshedReply.lands);
        const emptySet = new Set(refreshedStatus.empty);
        const verified = requestedLandIds.filter((id) => emptySet.has(id));
        const skipped = requestedLandIds.filter((id) => !emptySet.has(id));
        if (skipped.length > 0) {
            log('种植', `种植前复核: 土地#${skipped.join(',')} 已非空地，跳过本轮购买/种植`, {
                module: 'farm',
                event: 'plant_verify_skip',
                result: 'occupied',
                landIds: skipped,
            });
        }
        return verified;
    } catch (e) {
        logWarn('种植', `种植前复核失败: ${e.message}，为避免误买种子，已跳过本轮补种`, {
            module: 'farm',
            event: 'plant_verify_skip',
            result: 'verify_error',
        });
        return [];
    }
}

function filterCoolingDownLandIds(landIds) {
    const now = Date.now();
    const allowed = [];
    const skipped = [];
    for (const landId of landIds) {
        const cooldownUntil = occupiedLandPlantCooldowns.get(landId) || 0;
        if (cooldownUntil > now) {
            skipped.push(landId);
            continue;
        }
        if (cooldownUntil > 0) {
            occupiedLandPlantCooldowns.delete(landId);
        }
        allowed.push(landId);
    }
    return { allowed, skipped };
}

function markOccupiedLandCooldown(landIds) {
    const cooldownUntil = Date.now() + OCCUPIED_LAND_RECHECK_COOLDOWN_MS;
    for (const landId of landIds) {
        occupiedLandPlantCooldowns.set(landId, cooldownUntil);
    }
}

function analyzeLands(lands) {
    const result = {
        harvestable: [], needWater: [], needWeed: [], needBug: [],
        growing: [], empty: [], dead: [], unlockable: [], upgradable: [],
        harvestableInfo: [],
        soonToMature: [],
    };

    const nowSec = getServerTimeSec();
    const debug = isFirstFarmCheck;

    // 🔧 优化：将 getUserState / getConfigSnapshot 提取到循环外，避免每块地重复调用
    const state = getUserState();
    const isSuspended = state.suspendUntil && Date.now() < state.suspendUntil;
    const fullCfg = getConfigSnapshot() || {};
    const modePolicy = getRuntimeAccountModePolicy();
    logModeScopePolicy(modePolicy);
    const accountMode = fullCfg.accountMode || 'main';
    const effectiveMode = String(modePolicy.effectiveMode || accountMode || 'main').trim().toLowerCase() || 'main';
    const autoCfg = getAutomation() || {};
    const fastHarvestEnabled = !!autoCfg.fastHarvest && effectiveMode === 'main';
    const landUpgradeTarget = getLandUpgradeTarget();
    const landsMap = buildLandMap(lands);

    for (const land of lands) {
        const id = toNum(land.id);
        if (!land.unlocked) {
            if (land.could_unlock) {
                result.unlockable.push(id);
            }
            continue;
        }
        if (land.could_upgrade) {
            const currentLevel = toNum(land.level || 0);
            if (currentLevel < landUpgradeTarget) {
                result.upgradable.push(id);
            }
        }
        if (isOccupiedSlaveLand(land, landsMap)) {
            continue;
        }

        const plant = land.plant;
        const landLabel = `土地#${id}(${(plant && plant.name) || '未知作物'})`;
        const lifecycle = resolveLandLifecycle(land, debug, landLabel);
        if (lifecycle.status === 'empty') {
            result.empty.push(id);
            continue;
        }
        if (lifecycle.status === 'dead') {
            result.dead.push(id);
            continue;
        }
        if (lifecycle.status === 'occupied_unknown') {
            result.growing.push(id);
            continue;
        }

        const plantName = plant.name || '未知作物';
        const currentPhase = lifecycle.currentPhase;
        const phaseVal = lifecycle.phaseVal;

        if (lifecycle.status === 'mature') {
            const maturePhase = Array.isArray(plant.phases)
                ? plant.phases.find((p) => p && toNum(p.phase) === PlantPhase.MATURE)
                : null;
            const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;

            // 🔧 优化：使用循环外预计算的 fullCfg / accountMode
            const harvestDelay = fullCfg.harvestDelay || { min: 180, max: 300 };

            let isDelayed = false;
            let remainingDelaySec = 0;

            if (effectiveMode !== 'main' && harvestDelay.max > 0) {
                const delayRange = Math.max(1, harvestDelay.max - harvestDelay.min);
                // 使用土地 ID 生成稳定的延迟
                const stableHash = (id * 997 + (matureBegin % 100000)) % delayRange;
                const delaySec = harvestDelay.min + stableHash;

                const effectiveMatureTime = matureBegin + delaySec;
                if (nowSec < effectiveMatureTime) {
                    isDelayed = true;
                    remainingDelaySec = effectiveMatureTime - nowSec;
                }
            }

            if (isDelayed) {
                // 延迟收获中，作为生长中处理，不放入 harvestable
                result.growing.push(id);

                // 为了前端显示正确的倒计时，可以保留部分状态？
                // 这里我们不在 getLandsDetail 中改变 original matureInSec，
                // 由于 analyzeLands 返回的 status 会控制是否可收，我们只需归入 growing 即可。
                continue;
            }

            result.harvestable.push(id);
            const plantId = toNum(plant.id);
            const plantNameFromConfig = getPlantName(plantId);
            const plantExp = getPlantExp(plantId);
            result.harvestableInfo.push({
                landId: id,
                plantId,
                name: plantNameFromConfig || plantName,
                exp: plantExp,
            });
            continue;
        }

        const dryNum = toNum(plant.dry_num);
        const dryTime = toTimeSec(currentPhase.dry_time);
        if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) {
            result.needWater.push(id);
        }

        const weedsTime = toTimeSec(currentPhase.weeds_time);
        const hasWeeds = (plant.weed_owners && plant.weed_owners.length > 0) || (weedsTime > 0 && weedsTime <= nowSec);
        if (hasWeeds) {
            result.needWeed.push(id);
        }

        const insectTime = toTimeSec(currentPhase.insect_time);
        const hasBugs = (plant.insect_owners && plant.insect_owners.length > 0) || (insectTime > 0 && insectTime <= nowSec);
        if (hasBugs) {
            result.needBug.push(id);
        }

        if (fastHarvestEnabled) {
            const plantId = toNum(plant.id);
            const maturePhase = Array.isArray(plant.phases)
                ? plant.phases.find((p) => p && toNum(p.phase) === PlantPhase.MATURE)
                : null;
            const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
            const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;
            if (matureInSec > 0 && matureInSec <= FAST_HARVEST_WINDOW_SEC) {
                result.soonToMature.push({
                    landId: id,
                    matureTime: matureBegin,
                    plantId,
                    plantName: getPlantName(plantId) || plant.name || `土地#${id}`,
                });
            }
        }

        result.growing.push(id);

        // 防偷60秒注册逻辑（🔧 优化：state / isSuspended 已在循环外预计算）
        // P0 (风控阻断) 与 P1/P2 (小号/避险模式阻断)
        if (isAutomationOn('fertilizer_60s_anti_steal') && effectiveMode === 'main' && !isSuspended) {
            const maturePhase = Array.isArray(plant.phases)
                ? plant.phases.find((p) => p && toNum(p.phase) === PlantPhase.MATURE)
                : null;
            const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
            const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;

            // 如果剩余时间在 60 秒到 10 分钟之间，才预埋唤醒任务（避免太久远的预埋堆积）
            // 如果正好等于 60，就立刻唤醒
            if (matureInSec > 0 && matureInSec <= 600) {
                const targetWaitSec = Math.max(0, matureInSec - 60);
                const timerId = `anti_steal_land_${id}`;
                // 使用 farmScheduler 预埋
                if (!farmScheduler.has(timerId)) {
                    log('防偷', `土地#${id} 将在 ${targetWaitSec} 秒后 (剩余60秒时) 触发防偷抢收`);
                    farmScheduler.setTimeoutTask(timerId, targetWaitSec * 1000, async () => {
                        await antiStealHarvest(id);
                    });
                }
            }
        }
    }

    return result;
}

let consecutiveErrors = 0; // Phase 3: 指数退避计数

async function checkFarm() {
    const state = getUserState();

    // Phase 2: 检测休眠锁 — 休眠期间仍允许收获自己土地的成熟作物并播种
    // 原逻辑：休眠直接 return false 跳过全部操作
    // 新逻辑：标记 isSuspended，跳过 Ghosting 打盹触发，但收获播种正常执行
    const isSuspended = state.suspendUntil && Date.now() < state.suspendUntil;
    if (isSuspended) {
        const resetMinutes = Math.ceil((state.suspendUntil - Date.now()) / 60000);
        log('农场', `风控休眠中 (剩余约 ${resetMinutes} 分钟)，仍检查自家土地收获与播种...`);
    }

    // ======== Ghosting 打盹：主动随机触发休眠，模拟人类离开（休眠期间跳过） ========
    // 触发条件：每次巡查 ~2% 概率 + 距上次打盹结束至少 4 小时冷却
    // 休眠时长：随机 30~90 分钟
    // 冷却基准：使用独立变量 lastGhostingEndedAt 而非 suspendUntil，
    //           因为 suspendUntil 语义为"休眠到期时间戳"，可能代表未来时间
    // 从全局时间参数配置中动态读取 Ghosting 参数（管理员可通过面板调整）
    if (!isSuspended) {
        const _tc = getTimingConfig();
        const GHOSTING_COOLDOWN_MS = _tc.ghostingCooldownMin * 60 * 1000; // 冷却期(分钟→毫秒)
        const GHOSTING_PROBABILITY = _tc.ghostingProbability;              // 触发概率
        const GHOSTING_MIN_MIN = _tc.ghostingMinMin;                       // 最短打盹(分钟)
        const GHOSTING_MAX_MIN = _tc.ghostingMaxMin;                       // 最长打盹(分钟)
        if (Math.random() < GHOSTING_PROBABILITY) {
            const timeSinceLastGhosting = Date.now() - lastGhostingEndedAt;
            if (lastGhostingEndedAt === 0 || timeSinceLastGhosting > GHOSTING_COOLDOWN_MS) {
                const napMinutes = GHOSTING_MIN_MIN + Math.floor(Math.random() * (GHOSTING_MAX_MIN - GHOSTING_MIN_MIN + 1));
                state.suspendUntil = Date.now() + napMinutes * 60 * 1000;
                // 预记录本次打盹的结束时间，供下次冷却判断
                lastGhostingEndedAt = state.suspendUntil;
                if (CONFIG.accountId) {
                    recordSuspendUntil(CONFIG.accountId, state.suspendUntil);
                }
                log('风控', `🛏️ Ghosting 打盹触发：模拟人类离开，休眠 ${napMinutes} 分钟`, {
                    module: 'farm', event: 'ghosting_nap', result: 'triggered',
                    napMinutes, resumeAt: new Date(state.suspendUntil).toLocaleTimeString(),
                });
                return false;
            }
        }
    }
    // ======== Ghosting 打盹 END ========

    if (isCheckingFarm || !state.gid || !isAutomationOn('farm')) return false;
    isCheckingFarm = true;

    try {
        // 复用手动操作逻辑
        const result = await runFarmOperation('all');
        isFirstFarmCheck = false;
        if (result && result.hadWork) {
            consecutiveErrors = 0; // 有效工作复位退避次数
        } else if (result && !result.hadWork && consecutiveErrors > 0) {
            // 虽然没产出，但是如果没报错也复位，毕竟网络是畅通的
            consecutiveErrors = 0;
        }
        return !!(result && result.hadWork);
    } catch (err) {
        logWarn('巡田', `检查失败: ${err.message}`);
        consecutiveErrors++;
        return false;
    } finally {
        isCheckingFarm = false;
    }
}

/**
 * 手动/自动执行农场操作
 * @param {string} opType - 'all', 'harvest', 'clear', 'plant', 'upgrade'
 */
async function runFarmOperation(opType) {
    const landsReply = await getAllLands();
    if (!landsReply.lands || landsReply.lands.length === 0) {
        if (opType !== 'all') {
            log('农场', '没有土地数据');
        }
        return { hadWork: false, actions: [] };
    }

    const lands = landsReply.lands;

    // [T1] 访客行为检测 — 后台静默执行，不影响主流程
    try { await detectAndLogVisitorChanges(lands); } catch { /* 访客检测失败不阻塞主流程 */ }

    const status = analyzeLands(lands);
    syncFastHarvestTasks(status.soonToMature);

    if (opType === 'all') {
        try {
            await runSmartPhaseFertilizer(lands);
        } catch (e) {
            logWarn('施肥', `智能二季施肥执行失败: ${e.message}`);
        }
    }

    // 摘要
    const statusParts = [];
    if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
    if (status.needWeed.length) statusParts.push(`草:${status.needWeed.length}`);
    if (status.needBug.length) statusParts.push(`虫:${status.needBug.length}`);
    if (status.needWater.length) statusParts.push(`水:${status.needWater.length}`);
    if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
    if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
    if (status.unlockable.length) statusParts.push(`解:${status.unlockable.length}`);
    if (status.upgradable.length) statusParts.push(`升:${status.upgradable.length}`);
    statusParts.push(`长:${status.growing.length}`);

    const actions = [];
    const batchOps = [];

    // 执行除草/虫/水
    if (opType === 'all' || opType === 'clear') {
        if (status.needWeed.length > 0) {
            batchOps.push(weedOut(status.needWeed).then(() => { actions.push(`除草${status.needWeed.length}`); recordOperation('weed', status.needWeed.length); }).catch(e => logWarn('除草', e.message)));
        }
        if (status.needBug.length > 0) {
            batchOps.push(insecticide(status.needBug).then(() => { actions.push(`除虫${status.needBug.length}`); recordOperation('bug', status.needBug.length); }).catch(e => logWarn('除虫', e.message)));
        }
        if (status.needWater.length > 0) {
            batchOps.push(waterLand(status.needWater).then(() => { actions.push(`浇水${status.needWater.length}`); recordOperation('water', status.needWater.length); }).catch(e => logWarn('浇水', e.message)));
        }
        if (batchOps.length > 0) await Promise.all(batchOps);
    }

    // 执行收获
    let harvestedLandIds = [];
    if (opType === 'all' || opType === 'harvest') {
        if (status.harvestable.length > 0) {
            try {
                await harvest(status.harvestable);
                log('收获', `收获完成 ${status.harvestable.length} 块土地`, {
                    module: 'farm',
                    event: 'harvest_crop',
                    result: 'ok',
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                });
                actions.push(`收获${status.harvestable.length}`);
                recordOperation('harvest', status.harvestable.length);
                harvestedLandIds = [...status.harvestable];
                networkEvents.emit('farmHarvested', {
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                    opType,
                });
            } catch (e) {
                logWarn('收获', e.message, {
                    module: 'farm',
                    event: 'harvest_crop',
                    result: 'error',
                });
            }
        }
    }

    // 执行种植
    if (opType === 'all' || opType === 'plant') {
        let allDeadLands = [...status.dead];
        let allEmptyLands = [...status.empty];

        // 收获后重新检测土地状态，避免两季作物被误铲
        if (harvestedLandIds.length > 0) {
            try {
                const refreshedReply = await getAllLands();
                if (refreshedReply.lands && refreshedReply.lands.length > 0) {
                    const refreshedStatus = analyzeLands(refreshedReply.lands);
                    for (const hid of harvestedLandIds) {
                        if (refreshedStatus.empty.includes(hid)) {
                            allEmptyLands.push(hid);
                        } else if (refreshedStatus.dead.includes(hid)) {
                            allDeadLands.push(hid);
                        }
                        // 仍在生长中（两季作物第二季）→ 不处理，等下次巡查
                    }
                }
            } catch (e) {
                logWarn('巡田', `收获后刷新土地状态失败：${e.message}，跳过收获地块的后续处理`);
            }
        }

        if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
            try {
                const plantResult = await autoPlantEmptyLands(allDeadLands, allEmptyLands, landsReply);
                if (plantResult.plantedLandIds.length > 0) {
                    actions.push(`种植${plantResult.plantedLandIds.length}`);
                    recordOperation('plant', plantResult.plantedLandIds.length);
                }
            } catch (e) { logWarn('种植', e.message); }
        }
    }

    // 执行土地解锁/升级（手动 upgrade 总是执行；自动 all 受开关控制）
    const shouldAutoUpgrade = opType === 'all' && isAutomationOn('land_upgrade');
    if (shouldAutoUpgrade || opType === 'upgrade') {
        if (status.unlockable.length > 0) {
            let unlocked = 0;
            for (const landId of status.unlockable) {
                try {
                    await unlockLand(landId, false);
                    log('解锁', `土地#${landId} 解锁成功`, {
                        module: 'farm', event: 'unlock_land', result: 'ok', landId
                    });
                    unlocked++;
                } catch (e) {
                    logWarn('解锁', `土地#${landId} 解锁失败: ${e.message}`, {
                        module: 'farm', event: 'unlock_land', result: 'error', landId
                    });
                }
                // Phase 3: 操作间隔 Jitter (200~600ms)
                await sleep(200 + Math.floor(Math.random() * 400));
            }
            if (unlocked > 0) {
                actions.push(`解锁${unlocked}`);
            }
        }

        if (status.upgradable.length > 0) {
            let upgraded = 0;
            for (const landId of status.upgradable) {
                try {
                    const reply = await upgradeLand(landId);
                    const newLevel = reply.land ? toNum(reply.land.level) : '?';
                    log('升级', `土地#${landId} 升级成功 → 等级${newLevel}`, {
                        module: 'farm', event: 'upgrade_land', result: 'ok', landId, level: newLevel
                    });
                    upgraded++;
                } catch (e) {
                    log('升级', `土地#${landId} 升级失败: ${e.message}`, {
                        module: 'farm', event: 'upgrade_land', result: 'error', landId
                    });
                }
                // Phase 3: 操作间隔 Jitter (200~600ms)
                await sleep(200 + Math.floor(Math.random() * 400));
            }
            if (upgraded > 0) {
                actions.push(`升级${upgraded}`);
                recordOperation('upgrade', upgraded);
            }
        }
    }

    // 日志
    const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
    if (actions.length > 0) {
        log('农场', `[${statusParts.join(' ')}]${actionStr}`, {
            module: 'farm', event: 'farm_cycle', opType, actions
        });
    }
    return { hadWork: actions.length > 0, actions };
}

function scheduleNextFarmCheck(delayMs = CONFIG.farmCheckInterval) {
    if (externalSchedulerMode) return;
    if (!farmLoopRunning) return;

    let finalDelay = delayMs;

    // Phase 3: 根据连续报错情况计算退避。前3次不退避，第4次开始成倍激增
    if (consecutiveErrors > 3) {
        const backoff = Math.min(300000, 5000 * 2**(consecutiveErrors - 3));
        finalDelay = Math.max(finalDelay, backoff);
        logWarn('系统', `连续 ${consecutiveErrors} 次异常，启动风控退避，下次巡田延迟 ${Math.round(finalDelay / 1000)} 秒`);
    }

    // Phase 3: Jitter 随机抖动防查 (针对下一次定时的间隔时间做 2% ~ 8% 的随机浮动扩大)
    // 避免所有人同时同一秒唤醒
    const jitter = Math.floor((Math.random() * 0.06 + 0.02) * finalDelay);
    finalDelay += jitter;

    farmScheduler.setTimeoutTask('farm_check_loop', Math.max(0, finalDelay), async () => {
        if (!farmLoopRunning) return;
        await checkFarm();
        if (!farmLoopRunning) return;
        scheduleNextFarmCheck(CONFIG.farmCheckInterval);
    });
}

function startFarmCheckLoop(options = {}) {
    if (farmLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    farmLoopRunning = true;
    networkEvents.on('landsChanged', onLandsChangedPush);
    if (!externalSchedulerMode) {
        // 初始延迟 5~15 秒随机，模拟人类登录后不会立即操作的行为
        const initialDelay = 5000 + Math.floor(Math.random() * 10000);
        scheduleNextFarmCheck(initialDelay);
    }
}

let lastPushTime = 0;
function onLandsChangedPush(lands) {
    if (!isAutomationOn('farm_push')) {
        return;
    }
    if (isCheckingFarm) return;
    const now = Date.now();
    if (now - lastPushTime < 500) return;
    lastPushTime = now;
    log('农场', `收到推送: ${lands.length}块土地变化，检查中...`, {
        module: 'farm', event: 'lands_notify', result: 'trigger_check', count: lands.length
    });
    farmScheduler.setTimeoutTask('farm_push_check', 100, async () => {
        if (!isCheckingFarm) await checkFarm();
    });
}

function stopFarmCheckLoop() {
    farmLoopRunning = false;
    externalSchedulerMode = false;
    farmScheduler.clearAll();
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
}

function refreshFarmCheckLoop(delayMs = 200) {
    if (!farmLoopRunning) return;
    scheduleNextFarmCheck(delayMs);
}

module.exports = {
    checkFarm, startFarmCheckLoop, stopFarmCheckLoop,
    refreshFarmCheckLoop,
    getCurrentPhase,
    setOperationLimitsCallback,
    getAllLands,
    getLandsDetail,
    getAvailableSeeds,
    runFarmOperation, // 导出新函数
    runFertilizerByConfig,
};
