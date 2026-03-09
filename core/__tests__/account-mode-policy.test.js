const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const policyModulePath = require.resolve('../src/services/account-mode-policy');
const configModulePath = require.resolve('../src/config/config');
const storeModulePath = require.resolve('../src/models/store');
const networkModulePath = require.resolve('../src/utils/network');

function mockModule(modulePath, exports) {
    const previous = require.cache[modulePath];
    require.cache[modulePath] = {
        id: modulePath,
        filename: modulePath,
        loaded: true,
        exports,
    };

    return () => {
        if (previous) require.cache[modulePath] = previous;
        else delete require.cache[modulePath];
    };
}

function createStoreMock(modeScopeOverrides = {}) {
    const snapshots = {
        '1': { accountMode: 'main', modeScope: { zoneScope: 'same_zone_only', requiresGameFriend: true, fallbackBehavior: 'standalone' } },
        '2': { accountMode: 'alt', modeScope: { zoneScope: 'same_zone_only', requiresGameFriend: true, fallbackBehavior: 'standalone', ...modeScopeOverrides } },
    };
    const accounts = [
        { id: '1', username: 'admin', platform: 'qq', uin: '10001' },
        { id: '2', username: 'admin', platform: 'qq', uin: '10002' },
    ];
    return {
        getConfigSnapshot(accountId) {
            return { ...(snapshots[String(accountId)] || {}) };
        },
        getAccounts() {
            return { accounts: accounts.map(item => ({ ...item })) };
        },
        resolveAccountZone(platform) {
            return String(platform || '').trim().toLowerCase().startsWith('wx') ? 'wechat_zone' : 'qq_zone';
        },
    };
}

test('account mode policy enables collaboration after sibling main account is detected as game friend', () => {
    const networkEvents = new EventEmitter();
    const restoreConfig = mockModule(configModulePath, { CONFIG: { accountId: '2' } });
    const restoreStore = mockModule(storeModulePath, createStoreMock());
    const restoreNetwork = mockModule(networkModulePath, { networkEvents });

    try {
        delete require.cache[policyModulePath];
        const policyService = require(policyModulePath);

        let policy = policyService.getRuntimeAccountModePolicy('2');
        assert.equal(policy.collaborationEnabled, false);
        assert.equal(policy.effectiveMode, 'alt');
        assert.equal(policy.degradeReason, 'friend_relation_unknown');

        policyService.updateRuntimeFriendsSnapshot([{ uin: '10001', gid: '9001' }], '2');
        policy = policyService.getRuntimeAccountModePolicy('2');

        assert.equal(policy.collaborationEnabled, true);
        assert.equal(policy.effectiveMode, 'alt');
        assert.deepEqual(policy.matchedPeerIds, ['1']);
        assert.equal(policy.degradeReason, '');
    } finally {
        delete require.cache[policyModulePath];
        restoreNetwork();
        restoreStore();
        restoreConfig();
    }
});

test('strict_block falls back to safe mode when sibling account is not a game friend', () => {
    const networkEvents = new EventEmitter();
    const restoreConfig = mockModule(configModulePath, { CONFIG: { accountId: '2' } });
    const restoreStore = mockModule(storeModulePath, createStoreMock({ fallbackBehavior: 'strict_block' }));
    const restoreNetwork = mockModule(networkModulePath, { networkEvents });

    try {
        delete require.cache[policyModulePath];
        const policyService = require(policyModulePath);
        policyService.updateRuntimeFriendsSnapshot([{ uin: '77777', gid: '9777' }], '2');

        const policy = policyService.getRuntimeAccountModePolicy('2');
        assert.equal(policy.collaborationEnabled, false);
        assert.equal(policy.degradeReason, 'not_game_friend');
        assert.equal(policy.effectiveMode, 'safe');
        assert.equal(policy.fallbackBehavior, 'strict_block');
    } finally {
        delete require.cache[policyModulePath];
        restoreNetwork();
        restoreStore();
        restoreConfig();
    }
});
