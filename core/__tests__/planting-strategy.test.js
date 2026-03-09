const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getInventorySourcePlan,
    getWorkflowSelectSeedOverride,
    pickBudgetOptimizedPlan,
    pickSeedByStrategy,
} = require('../src/services/planting-strategy');

test('getWorkflowSelectSeedOverride returns the last valid select_seed node when farm workflow is enabled', () => {
    const override = getWorkflowSelectSeedOverride({
        farm: {
            enabled: true,
            nodes: [
                { id: 'a', type: 'delay', params: { sec: 5 } },
                { id: 'b', type: 'select_seed', params: { strategy: 'max_profit' } },
                { id: 'c', type: 'select_seed', params: { strategy: 'max_exp' } },
            ],
        },
    });

    assert.deepEqual(override, {
        strategy: 'max_exp',
        source: 'workflow',
        nodeId: 'c',
    });
});

test('pickSeedByStrategy honors preferred seed before falling back', () => {
    const picked = pickSeedByStrategy({
        available: [
            { seedId: 20003, requiredLevel: 2, price: 4 },
            { seedId: 20059, requiredLevel: 5, price: 10 },
        ],
        strategy: 'preferred',
        preferredSeedId: 20003,
        accountLevel: 6,
    });

    assert.equal(picked.seed.seedId, 20003);
    assert.equal(picked.selectionType, 'preferred');
    assert.equal(picked.fallbackReason, '');
});

test('pickSeedByStrategy uses analytics rankings instead of max level when a ranked seed is available', () => {
    const picked = pickSeedByStrategy({
        available: [
            { seedId: 20061, requiredLevel: 6, price: 126 },
            { seedId: 20059, requiredLevel: 5, price: 10 },
            { seedId: 20060, requiredLevel: 5, price: 84 },
        ],
        strategy: 'max_profit',
        accountLevel: 6,
        rankings: [
            { seedId: 20059, level: 5 },
            { seedId: 20060, level: 5 },
            { seedId: 20061, level: 6 },
        ],
    });

    assert.equal(picked.seed.seedId, 20059);
    assert.equal(picked.selectionType, 'analytics');
    assert.equal(picked.fallbackReason, '');
});

test('pickSeedByStrategy falls back to highest level seed when preferred seed is unavailable', () => {
    const picked = pickSeedByStrategy({
        available: [
            { seedId: 20003, requiredLevel: 2, price: 4 },
            { seedId: 20059, requiredLevel: 5, price: 10 },
        ],
        strategy: 'preferred',
        preferredSeedId: 29999,
        accountLevel: 6,
    });

    assert.equal(picked.seed.seedId, 20059);
    assert.equal(picked.selectionType, 'fallback_level');
    assert.equal(picked.fallbackReason, 'preferred_unavailable');
});

test('pickSeedByStrategy can pause the planting round when fallback strategy is pause', () => {
    const picked = pickSeedByStrategy({
        available: [
            { seedId: 20003, requiredLevel: 2, price: 4 },
            { seedId: 20059, requiredLevel: 5, price: 10 },
        ],
        strategy: 'max_profit',
        fallbackStrategy: 'pause',
        accountLevel: 6,
        rankings: [],
    });

    assert.equal(picked.seed, null);
    assert.equal(picked.selectionType, 'fallback_pause');
    assert.equal(picked.fallbackReason, 'analytics_no_match');
});

test('pickSeedByStrategy can fall back to the cheapest seed', () => {
    const picked = pickSeedByStrategy({
        available: [
            { seedId: 20061, requiredLevel: 6, price: 126 },
            { seedId: 20059, requiredLevel: 5, price: 10 },
            { seedId: 20003, requiredLevel: 2, price: 4 },
        ],
        strategy: 'max_profit',
        fallbackStrategy: 'cheapest',
        accountLevel: 6,
        rankings: [],
    });

    assert.equal(picked.seed.seedId, 20003);
    assert.equal(picked.selectionType, 'fallback_cheapest');
    assert.equal(picked.fallbackReason, 'analytics_no_match');
});

test('pickBudgetOptimizedPlan chooses a cheaper crop when it yields higher total profit under budget', () => {
    const plan = pickBudgetOptimizedPlan({
        available: [
            { seedId: 20061, requiredLevel: 6, price: 50 },
            { seedId: 20059, requiredLevel: 5, price: 20 },
        ],
        rankings: [
            { seedId: 20061, actualProfitPerHour: 100 },
            { seedId: 20059, actualProfitPerHour: 60 },
        ],
        strategy: 'max_profit',
        timingMode: 'actual',
        gold: 100,
        landCount: 5,
        selectedSeedId: 20061,
    });

    assert.equal(plan.seed.seedId, 20059);
    assert.equal(plan.plantedCount, 5);
    assert.equal(plan.baseSeedId, 20061);
    assert.equal(plan.basePlantedCount, 2);
    assert.equal(plan.totalScore, 300);
    assert.equal(plan.baseTotalScore, 200);
    assert.equal(plan.changed, true);
});

test('pickBudgetOptimizedPlan can avoid a no-plant round when the top-ranked crop is unaffordable', () => {
    const plan = pickBudgetOptimizedPlan({
        available: [
            { seedId: 20061, requiredLevel: 6, price: 126 },
            { seedId: 20059, requiredLevel: 5, price: 10 },
        ],
        rankings: [
            { seedId: 20061, actualExpPerHour: 100 },
            { seedId: 20059, actualExpPerHour: 25 },
        ],
        strategy: 'max_exp',
        timingMode: 'actual',
        gold: 100,
        landCount: 10,
        selectedSeedId: 20061,
    });

    assert.equal(plan.seed.seedId, 20059);
    assert.equal(plan.plantedCount, 10);
    assert.equal(plan.baseSeedId, 20061);
    assert.equal(plan.basePlantedCount, 0);
    assert.equal(plan.changed, true);
});

test('getInventorySourcePlan prefers inventory before buying more seeds', () => {
    const plan = getInventorySourcePlan({
        seed: {
            seedId: 20059,
            price: 10,
            purchasable: true,
            inventoryUsableCount: 3,
        },
        mode: 'prefer_inventory',
        landCount: 5,
        gold: 50,
    });

    assert.equal(plan.inventoryUseCount, 3);
    assert.equal(plan.buyCount, 2);
    assert.equal(plan.plantedCount, 5);
    assert.equal(plan.totalCost, 20);
});

test('getInventorySourcePlan can limit planting to inventory only', () => {
    const plan = getInventorySourcePlan({
        seed: {
            seedId: 20059,
            price: 10,
            purchasable: true,
            inventoryUsableCount: 4,
        },
        mode: 'inventory_only',
        landCount: 10,
        gold: 999,
    });

    assert.equal(plan.inventoryUseCount, 4);
    assert.equal(plan.buyCount, 0);
    assert.equal(plan.plantedCount, 4);
    assert.equal(plan.totalCost, 0);
});

test('pickBudgetOptimizedPlan considers usable inventory after reserve rules', () => {
    const plan = pickBudgetOptimizedPlan({
        available: [
            { seedId: 20061, requiredLevel: 6, price: 50, purchasable: true, inventoryUsableCount: 1 },
            { seedId: 20059, requiredLevel: 5, price: 20, purchasable: true, inventoryUsableCount: 4 },
        ],
        rankings: [
            { seedId: 20061, actualProfitPerHour: 100 },
            { seedId: 20059, actualProfitPerHour: 60 },
        ],
        strategy: 'max_profit',
        timingMode: 'actual',
        inventoryMode: 'prefer_inventory',
        gold: 20,
        landCount: 4,
        selectedSeedId: 20061,
    });

    assert.equal(plan.seed.seedId, 20059);
    assert.equal(plan.inventoryUseCount, 4);
    assert.equal(plan.buyCount, 0);
    assert.equal(plan.totalCost, 0);
});

test('pickBudgetOptimizedPlan keeps inventory-only seeds even when price metadata is unavailable', () => {
    const plan = pickBudgetOptimizedPlan({
        available: [
            { seedId: 29901, requiredLevel: 5, price: 0, purchasable: false, inventoryUsableCount: 3 },
            { seedId: 20059, requiredLevel: 5, price: 20, purchasable: true, inventoryUsableCount: 0 },
        ],
        rankings: [
            { seedId: 29901, actualProfitPerHour: 88 },
            { seedId: 20059, actualProfitPerHour: 60 },
        ],
        strategy: 'max_profit',
        timingMode: 'actual',
        inventoryMode: 'inventory_only',
        gold: 0,
        landCount: 3,
        selectedSeedId: 29901,
    });

    assert.equal(plan.seed.seedId, 29901);
    assert.equal(plan.inventoryUseCount, 3);
    assert.equal(plan.buyCount, 0);
    assert.equal(plan.totalCost, 0);
});
