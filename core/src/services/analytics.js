/**
 * 数据分析模块 - 作物效率分析
 */

const { getAllPlants, getFruitPrice, getSeedPrice, getItemImageById } = require('../config/gameConfig');
const { getConfigSnapshot } = require('../models/store');

const DEFAULT_TIMING_MODE = 'theoretical';
const ANALYTICS_TIMING_MODES = new Set(['theoretical', 'actual']);

function toSafeNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function normalizeTimingMode(mode, fallback = DEFAULT_TIMING_MODE) {
    const normalized = String(mode || '').trim();
    return ANALYTICS_TIMING_MODES.has(normalized) ? normalized : fallback;
}

/**
 * 解析生长阶段时长数组（排除成熟阶段 :0）
 */
function parsePhaseSeconds(growPhases) {
    if (!growPhases) return [];
    const phases = String(growPhases).split(';').filter(p => p.length > 0);
    const secs = [];
    for (const phase of phases) {
        const match = phase.match(/:(\d+)$/);
        if (match) {
            const s = Number.parseInt(match[1], 10) || 0;
            if (s > 0) secs.push(s);
        }
    }
    return secs;
}

function parseGrowTime(growPhases) {
    const secs = parsePhaseSeconds(growPhases);
    return secs.reduce((a, b) => a + b, 0);
}

/**
 * 两季作物完整周期时长（第一季 + 第二季）
 * 参考 farm-calculator：第二季 = 最后 2 个有效阶段之和
 */
function parseFullCycleGrowTime(growPhases, seasons) {
    const secs = parsePhaseSeconds(growPhases);
    if (secs.length === 0) return 0;
    const firstSeason = secs.reduce((a, b) => a + b, 0);
    if (Number(seasons) !== 2 || secs.length < 2) return firstSeason;
    const last2 = secs.slice(-2);
    const secondSeason = last2.reduce((a, b) => a + b, 0);
    return firstSeason + secondSeason;
}

/**
 * 普通化肥对第一生长阶段的加速效果（秒）
 * 参考策略版：普通施肥跳过第一阶段，即减少时长为第一个有效阶段的秒数
 * 排除成熟阶段（:0），取第一个 seconds>0 的阶段
 */
function parseNormalFertilizerReduceSec(growPhases) {
    if (!growPhases) return 0;
    const phases = String(growPhases).split(';').filter(p => p.length > 0);
    for (const phase of phases) {
        const match = phase.match(/:(\d+)$/);
        if (match) {
            const sec = Number.parseInt(match[1], 10) || 0;
            if (sec > 0) return sec; // 第一个有效阶段
        }
    }
    return 0;
}

function formatTime(seconds) {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins > 0 ? `${hours}时${mins}分` : `${hours}时`;
}

function averageRange(minValue, maxValue, fallback = 0) {
    const min = toSafeNumber(minValue, fallback);
    const max = toSafeNumber(maxValue, fallback);
    if (min <= 0 && max <= 0) return Math.max(0, fallback);
    if (min <= 0) return Math.max(0, max);
    if (max <= 0) return Math.max(0, min);
    if (max < min) return (min + max) / 2;
    return (min + max) / 2;
}

function getAverageFarmIntervalSec(intervals = {}) {
    if (!intervals || typeof intervals !== 'object') return 30;

    const fallback = Math.max(1, toSafeNumber(intervals.farm, 30));
    const hasFarmMin = Number.isFinite(Number(intervals.farmMin)) && Number(intervals.farmMin) > 0;
    const hasFarmMax = Number.isFinite(Number(intervals.farmMax)) && Number(intervals.farmMax) > 0;

    if (hasFarmMin || hasFarmMax) {
        return Math.max(1, averageRange(intervals.farmMin, intervals.farmMax, fallback));
    }
    return fallback;
}

function buildTimingProfile(options = {}) {
    const timingMode = normalizeTimingMode(options.timingMode);
    if (timingMode !== 'actual') {
        return {
            timingMode,
            harvestDelaySec: 0,
            detectionDelaySec: 0,
            farmIntervalSec: 0,
            totalOverheadSec: 0,
            pushEnabled: false,
        };
    }

    const accountConfig = options.accountConfig && typeof options.accountConfig === 'object'
        ? options.accountConfig
        : getConfigSnapshot(options.accountId);
    const harvestDelay = accountConfig && typeof accountConfig.harvestDelay === 'object'
        ? accountConfig.harvestDelay
        : {};
    const automation = accountConfig && typeof accountConfig.automation === 'object'
        ? accountConfig.automation
        : {};
    const intervals = accountConfig && typeof accountConfig.intervals === 'object'
        ? accountConfig.intervals
        : {};
    const pushEnabled = automation.farm_push !== false;
    const harvestDelaySec = Math.max(0, averageRange(harvestDelay.min, harvestDelay.max, 0));
    const farmIntervalSec = getAverageFarmIntervalSec(intervals);
    const detectionDelaySec = pushEnabled
        ? Math.min(5, Math.max(1, farmIntervalSec * 0.2))
        : Math.max(1, farmIntervalSec / 2);

    return {
        timingMode,
        harvestDelaySec: Number.parseFloat(harvestDelaySec.toFixed(2)),
        detectionDelaySec: Number.parseFloat(detectionDelaySec.toFixed(2)),
        farmIntervalSec: Number.parseFloat(farmIntervalSec.toFixed(2)),
        totalOverheadSec: Number.parseFloat((harvestDelaySec + detectionDelaySec).toFixed(2)),
        pushEnabled,
    };
}

function getSortMetric(sortBy, timingMode) {
    const useActualMetrics = normalizeTimingMode(timingMode) === 'actual';
    const metricMap = useActualMetrics
        ? {
            exp: 'actualExpPerHour',
            fert: 'actualNormalFertilizerExpPerHour',
            gold: 'actualGoldPerHour',
            profit: 'actualProfitPerHour',
            fert_profit: 'actualNormalFertilizerProfitPerHour',
        }
        : {
            exp: 'expPerHour',
            fert: 'normalFertilizerExpPerHour',
            gold: 'goldPerHour',
            profit: 'profitPerHour',
            fert_profit: 'normalFertilizerProfitPerHour',
        };
    return metricMap[sortBy] || '';
}

function sortPlantRankings(results, sortBy, timingMode) {
    const sortMetric = getSortMetric(sortBy, timingMode);
    if (sortMetric) {
        results.sort((a, b) => toSafeNumber(b && b[sortMetric], -Infinity) - toSafeNumber(a && a[sortMetric], -Infinity));
        return;
    }

    if (sortBy === 'level') {
        const lv = (v) => (v === null || v === undefined ? -1 : Number(v));
        results.sort((a, b) => lv(b.level) - lv(a.level));
    }
}

function getPlantRankings(sortBy = 'exp', levelMax = null, options = {}) {
    const plants = Array.isArray(options.plants) ? options.plants : getAllPlants();
    const timingProfile = buildTimingProfile(options);

    const normalPlants = plants.filter(p => {
        return p.seed_id > 0 && p.grow_phases;
    });

    const results = [];
    for (const plant of normalPlants) {
        const baseGrowTime = parseGrowTime(plant.grow_phases);
        if (baseGrowTime <= 0) continue;
        const seasons = Number(plant.seasons) || 1;
        const isTwoSeason = seasons === 2;
        const growTime = parseFullCycleGrowTime(plant.grow_phases, seasons);
        
        const harvestExpBase = Number.parseInt(plant.exp) || 0;
        const harvestExp = isTwoSeason ? (harvestExpBase * 2) : harvestExpBase;
        const expPerHour = (harvestExp / growTime) * 3600;
        // 普通化肥：直接减少第一生长阶段时长（reduceSec）
        const reduceSecBase = parseNormalFertilizerReduceSec(plant.grow_phases);
        const reduceSecApplied = isTwoSeason ? (reduceSecBase * 2) : reduceSecBase;
        const fertilizedGrowTime = growTime - reduceSecApplied;
        const safeFertilizedTime = fertilizedGrowTime > 0 ? fertilizedGrowTime : 1;
        const normalFertilizerExpPerHour = (harvestExp / safeFertilizedTime) * 3600;
        const actualGrowTime = growTime + timingProfile.totalOverheadSec;
        const actualFertilizedGrowTime = safeFertilizedTime + timingProfile.totalOverheadSec;
        const safeActualGrowTime = actualGrowTime > 0 ? actualGrowTime : 1;
        const safeActualFertilizedTime = actualFertilizedGrowTime > 0 ? actualFertilizedGrowTime : 1;
        const actualExpPerHour = (harvestExp / safeActualGrowTime) * 3600;
        const actualNormalFertilizerExpPerHour = (harvestExp / safeActualFertilizedTime) * 3600;
        
        const fruitId = Number(plant.fruit && plant.fruit.id) || 0;
        const fruitCount = Number(plant.fruit && plant.fruit.count) || 0;
        const fruitPrice = getFruitPrice(fruitId);
        const seedPrice = getSeedPrice(Number(plant.seed_id) || 0);

        // 单次收获总金币（毛收益）与净收益
        const income = (fruitCount * fruitPrice) * (isTwoSeason ? 2 : 1);
        const netProfit = income - seedPrice;
        const goldPerHour = (income / growTime) * 3600;
        const profitPerHour = (netProfit / growTime) * 3600;
        const normalFertilizerProfitPerHour = (netProfit / safeFertilizedTime) * 3600;
        const actualGoldPerHour = (income / safeActualGrowTime) * 3600;
        const actualProfitPerHour = (netProfit / safeActualGrowTime) * 3600;
        const actualNormalFertilizerProfitPerHour = (netProfit / safeActualFertilizedTime) * 3600;

        const cfgLevel = Number(plant.land_level_need);
        const requiredLevel = (Number.isFinite(cfgLevel) && cfgLevel > 0) ? cfgLevel : null;
        results.push({
            id: plant.id,
            seedId: plant.seed_id,
            name: plant.name,
            seasons,
            level: requiredLevel,
            growTime,
            growTimeStr: formatTime(growTime),
            reduceSec: reduceSecBase,
            reduceSecApplied,
            expPerHour: Number.parseFloat(expPerHour.toFixed(2)),
            normalFertilizerExpPerHour: Number.parseFloat(normalFertilizerExpPerHour.toFixed(2)),
            goldPerHour: Number.parseFloat(goldPerHour.toFixed(2)), // 毛收益/时
            profitPerHour: Number.parseFloat(profitPerHour.toFixed(2)), // 净收益/时
            normalFertilizerProfitPerHour: Number.parseFloat(normalFertilizerProfitPerHour.toFixed(2)), // 普通肥净收益/时
            actualGrowTime: Number.parseFloat(safeActualGrowTime.toFixed(2)),
            actualGrowTimeStr: formatTime(Math.round(safeActualGrowTime)),
            actualFertilizedGrowTime: Number.parseFloat(safeActualFertilizedTime.toFixed(2)),
            actualExpPerHour: Number.parseFloat(actualExpPerHour.toFixed(2)),
            actualNormalFertilizerExpPerHour: Number.parseFloat(actualNormalFertilizerExpPerHour.toFixed(2)),
            actualGoldPerHour: Number.parseFloat(actualGoldPerHour.toFixed(2)),
            actualProfitPerHour: Number.parseFloat(actualProfitPerHour.toFixed(2)),
            actualNormalFertilizerProfitPerHour: Number.parseFloat(actualNormalFertilizerProfitPerHour.toFixed(2)),
            timingMode: timingProfile.timingMode,
            timingOverheadSec: timingProfile.totalOverheadSec,
            expectedHarvestDelaySec: timingProfile.harvestDelaySec,
            expectedDetectionDelaySec: timingProfile.detectionDelaySec,
            expectedFarmIntervalSec: timingProfile.farmIntervalSec,
            farmPushEnabled: timingProfile.pushEnabled,
            income,
            netProfit,
            fruitId,
            fruitCount,
            fruitPrice,
            seedPrice,
            image: getItemImageById(plant.seed_id),
        });
    }

    sortPlantRankings(results, sortBy, timingProfile.timingMode);

    // 按等级筛选：仅保留 level 为空或 level <= levelMax 的作物
    if (levelMax != null && Number.isFinite(Number(levelMax)) && Number(levelMax) > 0) {
        const max = Number(levelMax);
        return results.filter(r => r.level === null || r.level === undefined || Number(r.level) <= max);
    }
    return results;
}

module.exports = {
    buildTimingProfile,
    getPlantRankings,
    normalizeTimingMode,
};
