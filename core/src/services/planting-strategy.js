const ALLOWED_PLANTING_STRATEGIES = new Set([
    'preferred',
    'level',
    'max_exp',
    'max_fert_exp',
    'max_profit',
    'max_fert_profit',
]);

const ALLOWED_PLANTING_FALLBACK_STRATEGIES = new Set([
    'pause',
    'preferred',
    'level',
    'cheapest',
]);

const ALLOWED_INVENTORY_PLANTING_MODES = new Set([
    'disabled',
    'prefer_inventory',
    'inventory_only',
]);

const ANALYTICS_SORT_BY_MAP = Object.freeze({
    max_exp: 'exp',
    max_fert_exp: 'fert',
    max_profit: 'profit',
    max_fert_profit: 'fert_profit',
});

const STRATEGY_SCORE_FIELD_MAP = Object.freeze({
    max_exp: {
        theoretical: 'expPerHour',
        actual: 'actualExpPerHour',
    },
    max_fert_exp: {
        theoretical: 'normalFertilizerExpPerHour',
        actual: 'actualNormalFertilizerExpPerHour',
    },
    max_profit: {
        theoretical: 'profitPerHour',
        actual: 'actualProfitPerHour',
    },
    max_fert_profit: {
        theoretical: 'normalFertilizerProfitPerHour',
        actual: 'actualNormalFertilizerProfitPerHour',
    },
});

function toSafeNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function normalizeStrategy(strategy, fallback = 'preferred') {
    const normalized = String(strategy || '').trim();
    return ALLOWED_PLANTING_STRATEGIES.has(normalized) ? normalized : fallback;
}

function normalizeFallbackStrategy(strategy, fallback = 'level') {
    const normalized = String(strategy || '').trim();
    return ALLOWED_PLANTING_FALLBACK_STRATEGIES.has(normalized) ? normalized : fallback;
}

function normalizeTimingMode(mode, fallback = 'actual') {
    const normalized = String(mode || '').trim();
    return normalized === 'theoretical' || normalized === 'actual' ? normalized : fallback;
}

function normalizeInventoryPlantingMode(mode, fallback = 'disabled') {
    const normalized = String(mode || '').trim();
    return ALLOWED_INVENTORY_PLANTING_MODES.has(normalized) ? normalized : fallback;
}

function normalizeAvailableSeeds(available) {
    return Array.isArray(available)
        ? available
            .filter(item => toSafeNumber(item && item.seedId, 0) > 0)
            .map(item => ({
                ...item,
                seedId: toSafeNumber(item.seedId, 0),
                requiredLevel: toSafeNumber(item.requiredLevel, 0),
                price: toSafeNumber(item.price, 0),
                purchasable: item && item.purchasable !== undefined ? !!item.purchasable : true,
                inventoryTotalCount: Math.max(0, toSafeNumber(item && item.inventoryTotalCount, 0)),
                inventoryReservedCount: Math.max(0, toSafeNumber(item && item.inventoryReservedCount, 0)),
                inventoryUsableCount: Math.max(0, toSafeNumber(item && item.inventoryUsableCount, 0)),
            }))
        : [];
}

function compareByRequiredLevelDesc(a, b) {
    return (
        toSafeNumber(b && b.requiredLevel, -1) - toSafeNumber(a && a.requiredLevel, -1)
        || toSafeNumber(b && b.price, -1) - toSafeNumber(a && a.price, -1)
        || toSafeNumber(b && b.seedId, 0) - toSafeNumber(a && a.seedId, 0)
    );
}

function compareByPriceAsc(a, b) {
    return (
        toSafeNumber(a && a.price, Number.MAX_SAFE_INTEGER) - toSafeNumber(b && b.price, Number.MAX_SAFE_INTEGER)
        || toSafeNumber(a && a.requiredLevel, Number.MAX_SAFE_INTEGER) - toSafeNumber(b && b.requiredLevel, Number.MAX_SAFE_INTEGER)
        || toSafeNumber(a && a.seedId, Number.MAX_SAFE_INTEGER) - toSafeNumber(b && b.seedId, Number.MAX_SAFE_INTEGER)
    );
}

function getWorkflowSelectSeedOverride(workflowConfig) {
    const farmConfig = workflowConfig && typeof workflowConfig === 'object'
        ? workflowConfig.farm
        : null;
    if (!farmConfig || !farmConfig.enabled || !Array.isArray(farmConfig.nodes)) {
        return null;
    }

    let override = null;
    for (const node of farmConfig.nodes) {
        if (!node || node.type !== 'select_seed') continue;
        const strategy = normalizeStrategy(node.params && node.params.strategy, '');
        if (!strategy) continue;
        override = {
            strategy,
            source: 'workflow',
            nodeId: String(node.id || ''),
        };
    }

    return override;
}

function pickFallbackSeed({ available, bySeedId, fallbackStrategy, preferredSeedId, reason }) {
    const normalizedFallback = normalizeFallbackStrategy(fallbackStrategy);

    if (normalizedFallback === 'pause') {
        return {
            seed: null,
            selectionType: 'fallback_pause',
            fallbackReason: reason,
            fallbackStrategy: normalizedFallback,
        };
    }

    if (normalizedFallback === 'preferred') {
        const preferred = preferredSeedId > 0 ? bySeedId.get(preferredSeedId) : null;
        if (preferred) {
            return {
                seed: preferred,
                selectionType: 'fallback_preferred',
                fallbackReason: reason,
                fallbackStrategy: normalizedFallback,
                preferredSeedId,
            };
        }
        return {
            seed: null,
            selectionType: 'fallback_pause',
            fallbackReason: reason === 'preferred_unavailable' ? reason : `${reason}_preferred_unavailable`,
            fallbackStrategy: normalizedFallback,
            preferredSeedId,
        };
    }

    if (normalizedFallback === 'cheapest') {
        const cheapest = [...available].sort(compareByPriceAsc)[0] || null;
        return {
            seed: cheapest,
            selectionType: 'fallback_cheapest',
            fallbackReason: reason,
            fallbackStrategy: normalizedFallback,
        };
    }

    const highest = [...available].sort(compareByRequiredLevelDesc)[0] || null;
    return {
        seed: highest,
        selectionType: 'fallback_level',
        fallbackReason: reason,
        fallbackStrategy: normalizedFallback,
    };
}

function getStrategyScoreField(strategy, timingMode = 'actual') {
    const normalizedStrategy = normalizeStrategy(strategy, '');
    if (!normalizedStrategy) return '';
    const scoreFields = STRATEGY_SCORE_FIELD_MAP[normalizedStrategy];
    if (!scoreFields) return '';
    return scoreFields[normalizeTimingMode(timingMode)] || '';
}

function compareBudgetPlans(a, b) {
    return (
        toSafeNumber(b && b.totalScore, -Infinity) - toSafeNumber(a && a.totalScore, -Infinity)
        || toSafeNumber(b && b.plantedCount, -1) - toSafeNumber(a && a.plantedCount, -1)
        || toSafeNumber(b && b.inventoryUseCount, -1) - toSafeNumber(a && a.inventoryUseCount, -1)
        || toSafeNumber(b && b.metricValue, -Infinity) - toSafeNumber(a && a.metricValue, -Infinity)
        || toSafeNumber(a && a.totalCost, Infinity) - toSafeNumber(b && b.totalCost, Infinity)
        || toSafeNumber(a && a.rankIndex, Infinity) - toSafeNumber(b && b.rankIndex, Infinity)
        || compareByRequiredLevelDesc(a && a.seed, b && b.seed)
    );
}

function getInventorySourcePlan(options = {}) {
    const seed = options.seed && typeof options.seed === 'object' ? options.seed : {};
    const mode = normalizeInventoryPlantingMode(options.mode);
    const landCount = Math.max(0, Number.parseInt(options.landCount, 10) || 0);
    const gold = Math.max(0, toSafeNumber(options.gold, 0));
    const price = Math.max(0, toSafeNumber(seed.price, 0));
    const inventoryUsableCount = Math.max(0, toSafeNumber(seed.inventoryUsableCount, 0));
    const purchasable = !!seed.purchasable;

    const inventoryUseCount = mode === 'disabled'
        ? 0
        : Math.min(landCount, inventoryUsableCount);
    if (mode === 'inventory_only') {
        return {
            mode,
            inventoryUseCount,
            buyCount: 0,
            plantedCount: inventoryUseCount,
            totalCost: 0,
            usesInventoryOnly: true,
        };
    }

    const buyAffordableCount = (purchasable && price > 0)
        ? Math.floor(gold / price)
        : 0;
    const remainingNeed = Math.max(0, landCount - inventoryUseCount);
    const buyCount = Math.min(remainingNeed, buyAffordableCount);
    const plantedCount = inventoryUseCount + buyCount;
    return {
        mode,
        inventoryUseCount,
        buyCount,
        plantedCount,
        totalCost: buyCount * price,
        usesInventoryOnly: false,
    };
}

function pickBudgetOptimizedPlan(options = {}) {
    const available = normalizeAvailableSeeds(options.available);
    if (available.length === 0) return null;

    const strategy = normalizeStrategy(options.strategy, '');
    const metricField = getStrategyScoreField(strategy, options.timingMode);
    if (!metricField) return null;

    const landCount = Math.max(0, Number.parseInt(options.landCount, 10) || 0);
    const gold = Math.max(0, toSafeNumber(options.gold, 0));
    if (landCount <= 0) return null;

    const rankings = Array.isArray(options.rankings) ? options.rankings : [];
    if (rankings.length === 0) return null;

    const bySeedId = new Map(available.map(item => [item.seedId, item]));
    const candidatePlans = [];
    for (let index = 0; index < rankings.length; index += 1) {
        const row = rankings[index];
        const seedId = toSafeNumber(row && row.seedId, 0);
        if (seedId <= 0) continue;

        const seed = bySeedId.get(seedId);
        if (!seed) continue;

        const metricValue = toSafeNumber(row && row[metricField], Number.NaN);
        if (!Number.isFinite(metricValue)) continue;

        const sourcePlan = getInventorySourcePlan({
            seed,
            mode: options.inventoryMode,
            landCount,
            gold,
        });
        if (sourcePlan.plantedCount <= 0) continue;

        candidatePlans.push({
            seed,
            metricField,
            metricValue: Number.parseFloat(metricValue.toFixed(2)),
            plantedCount: sourcePlan.plantedCount,
            inventoryUseCount: sourcePlan.inventoryUseCount,
            buyCount: sourcePlan.buyCount,
            totalCost: sourcePlan.totalCost,
            totalScore: Number.parseFloat((metricValue * sourcePlan.plantedCount).toFixed(2)),
            rankIndex: index,
        });
    }

    if (candidatePlans.length === 0) return null;

    candidatePlans.sort(compareBudgetPlans);
    const bestPlan = candidatePlans[0];
    const selectedSeedId = Math.max(0, Number.parseInt(options.selectedSeedId, 10) || 0);
    const selectedPlan = selectedSeedId > 0
        ? candidatePlans.find(item => item.seed && item.seed.seedId === selectedSeedId) || null
        : null;
    const selectedSeed = selectedSeedId > 0 ? bySeedId.get(selectedSeedId) || null : null;
    const selectedRow = selectedSeedId > 0
        ? rankings.find(row => toSafeNumber(row && row.seedId, 0) === selectedSeedId) || null
        : null;
    const selectedMetricValue = Number.isFinite(toSafeNumber(selectedRow && selectedRow[metricField], Number.NaN))
        ? Number.parseFloat(toSafeNumber(selectedRow && selectedRow[metricField], 0).toFixed(2))
        : 0;
    const selectedSourcePlan = getInventorySourcePlan({
        seed: selectedSeed,
        mode: options.inventoryMode,
        landCount,
        gold,
    });
    const baseSeedId = selectedPlan && selectedPlan.seed
        ? selectedPlan.seed.seedId
        : (selectedSeed ? selectedSeed.seedId : 0);
    const basePlantedCount = selectedPlan
        ? selectedPlan.plantedCount
        : selectedSourcePlan.plantedCount;
    const baseTotalCost = selectedPlan
        ? selectedPlan.totalCost
        : selectedSourcePlan.totalCost;
    const baseMetricValue = selectedPlan
        ? selectedPlan.metricValue
        : selectedMetricValue;
    const baseTotalScore = selectedPlan
        ? selectedPlan.totalScore
        : Number.parseFloat((selectedMetricValue * basePlantedCount).toFixed(2));

    return {
        ...bestPlan,
        baseSeedId,
        basePlantedCount,
        baseTotalCost,
        baseMetricValue,
        baseTotalScore,
        changed: selectedSeedId > 0
            ? (
                !bestPlan.seed
                || bestPlan.seed.seedId !== selectedSeedId
                || basePlantedCount !== bestPlan.plantedCount
            )
            : !!selectedPlan && (
                !selectedPlan.seed
                || !bestPlan.seed
                || selectedPlan.seed.seedId !== bestPlan.seed.seedId
                || selectedPlan.plantedCount !== bestPlan.plantedCount
            ),
    };
}

function pickSeedByStrategy(options = {}) {
    const available = normalizeAvailableSeeds(options.available);
    if (available.length === 0) {
        return {
            seed: null,
            strategy: normalizeStrategy(options.strategy),
            selectionType: 'none',
            fallbackReason: 'no_available_seed',
        };
    }

    const strategy = normalizeStrategy(options.strategy);
    const fallbackStrategy = normalizeFallbackStrategy(options.fallbackStrategy);
    const preferredSeedId = Math.max(0, Number.parseInt(options.preferredSeedId, 10) || 0);
    const accountLevel = toSafeNumber(options.accountLevel, Number.NaN);
    const rankings = Array.isArray(options.rankings) ? options.rankings : [];

    const bySeedId = new Map(available.map(item => [item.seedId, item]));
    const levelFallback = [...available].sort(compareByRequiredLevelDesc)[0] || null;

    if (!levelFallback) {
        return {
            seed: null,
            strategy,
            selectionType: 'none',
            fallbackReason: 'no_level_fallback',
            fallbackStrategy,
        };
    }

    if (strategy === 'preferred') {
        if (preferredSeedId > 0) {
            const preferred = bySeedId.get(preferredSeedId);
            if (preferred) {
                return {
                    seed: preferred,
                    strategy,
                    selectionType: 'preferred',
                    fallbackReason: '',
                    fallbackStrategy,
                };
            }
        }
        const preferredFallback = pickFallbackSeed({
            available,
            bySeedId,
            fallbackStrategy,
            preferredSeedId,
            reason: preferredSeedId > 0 ? 'preferred_unavailable' : 'preferred_auto',
        });
        return {
            ...preferredFallback,
            strategy,
        };
    }

    if (ANALYTICS_SORT_BY_MAP[strategy]) {
        for (const row of rankings) {
            const seedId = toSafeNumber(row && row.seedId, 0);
            if (seedId <= 0) continue;

            const rowLevel = toSafeNumber(row && row.level, Number.NaN);
            if (Number.isFinite(accountLevel) && Number.isFinite(rowLevel) && rowLevel > accountLevel) {
                continue;
            }

            const found = bySeedId.get(seedId);
            if (found) {
                return {
                    seed: found,
                    strategy,
                    selectionType: 'analytics',
                    fallbackReason: '',
                    fallbackStrategy,
                };
            }
        }

        return {
            ...pickFallbackSeed({
                available,
                bySeedId,
                fallbackStrategy,
                preferredSeedId,
                reason: 'analytics_no_match',
            }),
            strategy,
        };
    }

    return {
        seed: levelFallback,
        strategy,
        selectionType: 'level',
        fallbackReason: '',
        fallbackStrategy,
    };
}

module.exports = {
    ANALYTICS_SORT_BY_MAP,
    getWorkflowSelectSeedOverride,
    getInventorySourcePlan,
    getStrategyScoreField,
    normalizeInventoryPlantingMode,
    normalizeFallbackStrategy,
    normalizeStrategy,
    pickBudgetOptimizedPlan,
    pickSeedByStrategy,
};
