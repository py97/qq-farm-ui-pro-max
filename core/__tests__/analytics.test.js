const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTimingProfile, getPlantRankings } = require('../src/services/analytics');

test('buildTimingProfile reflects harvest delay and polling interval when push trigger is off', () => {
    const profile = buildTimingProfile({
        timingMode: 'actual',
        accountConfig: {
            harvestDelay: { min: 20, max: 40 },
            intervals: { farmMin: 40, farmMax: 60 },
            automation: { farm_push: false },
        },
    });

    assert.equal(profile.harvestDelaySec, 30);
    assert.equal(profile.farmIntervalSec, 50);
    assert.equal(profile.detectionDelaySec, 25);
    assert.equal(profile.totalOverheadSec, 55);
    assert.equal(profile.pushEnabled, false);
});

test('actual timing mode lowers per-hour metrics when extra waiting time exists', () => {
    const [theoretical] = getPlantRankings('exp', null, {
        plants: [
            {
                id: 1,
                seed_id: 91001,
                name: '测试短作物',
                seasons: 1,
                exp: 100,
                grow_phases: '1:100;2:0',
                fruit: { id: 0, count: 1 },
                land_level_need: 1,
            },
        ],
    });

    const [actual] = getPlantRankings('exp', null, {
        timingMode: 'actual',
        accountConfig: {
            harvestDelay: { min: 30, max: 30 },
            intervals: { farmMin: 30, farmMax: 30 },
            automation: { farm_push: false },
        },
        plants: [
            {
                id: 1,
                seed_id: 91001,
                name: '测试短作物',
                seasons: 1,
                exp: 100,
                grow_phases: '1:100;2:0',
                fruit: { id: 0, count: 1 },
                land_level_need: 1,
            },
        ],
    });

    assert.equal(theoretical.expPerHour, 3600);
    assert.equal(actual.timingOverheadSec, 45);
    assert.equal(actual.actualGrowTime, 145);
    assert(actual.actualExpPerHour < theoretical.expPerHour);
});

test('actual timing mode can change the best crop under heavy overhead', () => {
    const plants = [
        {
            id: 1,
            seed_id: 92001,
            name: '短周期',
            seasons: 1,
            exp: 100,
            grow_phases: '1:100;2:0',
            fruit: { id: 0, count: 1 },
            land_level_need: 1,
        },
        {
            id: 2,
            seed_id: 92002,
            name: '长周期',
            seasons: 1,
            exp: 150,
            grow_phases: '1:200;2:0',
            fruit: { id: 0, count: 1 },
            land_level_need: 1,
        },
    ];

    const theoretical = getPlantRankings('exp', null, { plants });
    const actual = getPlantRankings('exp', null, {
        timingMode: 'actual',
        accountConfig: {
            harvestDelay: { min: 240, max: 240 },
            intervals: { farmMin: 120, farmMax: 120 },
            automation: { farm_push: false },
        },
        plants,
    });

    assert.equal(theoretical[0].seedId, 92001);
    assert.equal(actual[0].seedId, 92002);
    assert(actual[0].actualExpPerHour > actual[1].actualExpPerHour);
});
