const process = require('node:process');

const { CONFIG } = require('../config/config');
const store = require('../models/store');
const { networkEvents } = require('../utils/network');

const DEFAULT_MODE_SCOPE = Object.freeze({
    zoneScope: 'same_zone_only',
    requiresGameFriend: true,
    fallbackBehavior: 'standalone',
});

const runtimeFriendSnapshots = new Map();
let listenerBound = false;

function normalizeAccountMode(mode) {
    const raw = String(mode || '').trim().toLowerCase();
    if (raw === 'alt' || raw === 'safe') return raw;
    return 'main';
}

function normalizeModeScope(scope) {
    const src = (scope && typeof scope === 'object') ? scope : {};
    return {
        zoneScope: String(src.zoneScope || DEFAULT_MODE_SCOPE.zoneScope).trim().toLowerCase() === 'all_zones'
            ? 'all_zones'
            : DEFAULT_MODE_SCOPE.zoneScope,
        requiresGameFriend: src.requiresGameFriend !== false,
        fallbackBehavior: String(src.fallbackBehavior || DEFAULT_MODE_SCOPE.fallbackBehavior).trim().toLowerCase() === 'strict_block'
            ? 'strict_block'
            : DEFAULT_MODE_SCOPE.fallbackBehavior,
    };
}

function resolveRuntimeAccountId(accountId = '') {
    return String(accountId || CONFIG.accountId || process.env.FARM_ACCOUNT_ID || '').trim();
}

function addIdentifier(target, value) {
    const raw = String(value || '').trim();
    if (!raw) return;
    target.add(raw);
    if (/^\d+$/.test(raw)) {
        target.add(String(Number.parseInt(raw, 10)));
    }
}

function buildFriendSnapshot(friends) {
    const identifiers = new Set();
    const list = Array.isArray(friends) ? friends : [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        addIdentifier(identifiers, item.open_id);
        addIdentifier(identifiers, item.uin);
        addIdentifier(identifiers, item.gid);
    }
    return {
        identifiers,
        total: list.length,
        updatedAt: Date.now(),
    };
}

function updateRuntimeFriendsSnapshot(friends, accountId = '') {
    const resolvedId = resolveRuntimeAccountId(accountId);
    if (!resolvedId) return null;
    const snapshot = buildFriendSnapshot(friends);
    runtimeFriendSnapshots.set(resolvedId, snapshot);
    return {
        total: snapshot.total,
        updatedAt: snapshot.updatedAt,
        identifiers: new Set(snapshot.identifiers),
    };
}

function clearRuntimeFriendsSnapshot(accountId = '') {
    const resolvedId = resolveRuntimeAccountId(accountId);
    if (resolvedId) {
        runtimeFriendSnapshots.delete(resolvedId);
        return;
    }
    runtimeFriendSnapshots.clear();
}

function getRuntimeFriendsSnapshot(accountId = '') {
    const resolvedId = resolveRuntimeAccountId(accountId);
    if (!resolvedId) return null;
    const snapshot = runtimeFriendSnapshots.get(resolvedId);
    if (!snapshot) return null;
    return {
        total: snapshot.total,
        updatedAt: snapshot.updatedAt,
        identifiers: new Set(snapshot.identifiers),
    };
}

function getAccountRecord(accountId) {
    const data = (typeof store.getAccounts === 'function') ? store.getAccounts() : { accounts: [] };
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    return accounts.find(item => String(item && item.id || '').trim() === String(accountId || '').trim()) || null;
}

function getPeerIdentifiers(account) {
    const identifiers = new Set();
    if (!account || typeof account !== 'object') return identifiers;
    addIdentifier(identifiers, account.uin);
    addIdentifier(identifiers, account.qq);
    return identifiers;
}

function resolvePeerModeTarget(requestedMode) {
    if (requestedMode === 'main') return 'alt';
    if (requestedMode === 'alt') return 'main';
    return '';
}

function describeModeScopeReason(reason) {
    switch (String(reason || '')) {
        case 'missing_mode_peer':
            return '未找到可协同的对端账号';
        case 'cross_zone_peer_only':
            return '仅存在跨区账号，未命中同区约束';
        case 'friend_relation_unknown':
            return '尚未拿到好友关系快照';
        case 'not_game_friend':
            return '同 owner 对端账号不是游戏好友';
        default:
            return '';
    }
}

function bindRuntimeFriendListener() {
    if (listenerBound) return;
    if (!networkEvents || typeof networkEvents.on !== 'function') return;
    networkEvents.on('friends_updated', (friends) => {
        updateRuntimeFriendsSnapshot(friends);
    });
    listenerBound = true;
}

function getRuntimeAccountModePolicy(accountId = '') {
    const resolvedId = resolveRuntimeAccountId(accountId);
    const configSnapshot = (typeof store.getConfigSnapshot === 'function')
        ? (store.getConfigSnapshot(resolvedId) || {})
        : {};
    const requestedMode = normalizeAccountMode(configSnapshot.accountMode);
    const modeScope = normalizeModeScope(configSnapshot.modeScope);
    const currentAccount = resolvedId ? getAccountRecord(resolvedId) : null;
    const currentZone = currentAccount && typeof store.resolveAccountZone === 'function'
        ? store.resolveAccountZone(currentAccount.platform)
        : 'unknown_zone';

    const policy = {
        accountId: resolvedId,
        accountMode: requestedMode,
        effectiveMode: requestedMode,
        modeScope,
        accountZone: currentZone,
        collaborationEnabled: false,
        scopeMatched: true,
        fallbackBehavior: modeScope.fallbackBehavior,
        degradeReason: '',
        degradeReasonLabel: '',
        matchedPeerIds: [],
        peerCount: 0,
        friendRelationKnown: !modeScope.requiresGameFriend,
    };

    if (!resolvedId || requestedMode === 'safe') {
        return policy;
    }

    const peerMode = resolvePeerModeTarget(requestedMode);
    if (!currentAccount || !peerMode) {
        return policy;
    }

    const owner = String(currentAccount.username || '').trim();
    const accountsData = (typeof store.getAccounts === 'function') ? store.getAccounts() : { accounts: [] };
    const accounts = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];

    const peers = accounts.filter((item) => {
        if (!item || typeof item !== 'object') return false;
        if (String(item.id || '').trim() === resolvedId) return false;
        if (String(item.username || '').trim() !== owner) return false;
        const snapshot = (typeof store.getConfigSnapshot === 'function')
            ? (store.getConfigSnapshot(item.id) || {})
            : {};
        return normalizeAccountMode(snapshot.accountMode) === peerMode;
    });

    policy.peerCount = peers.length;
    if (peers.length === 0) {
        policy.scopeMatched = false;
        policy.degradeReason = 'missing_mode_peer';
    }

    const zoneMatchedPeers = peers.filter((item) => {
        if (modeScope.zoneScope === 'all_zones') return true;
        const peerZone = typeof store.resolveAccountZone === 'function'
            ? store.resolveAccountZone(item.platform)
            : 'unknown_zone';
        return peerZone === currentZone;
    });

    if (!policy.degradeReason && zoneMatchedPeers.length === 0) {
        policy.scopeMatched = false;
        policy.degradeReason = 'cross_zone_peer_only';
    }

    let matchedPeers = zoneMatchedPeers;
    const friendSnapshot = getRuntimeFriendsSnapshot(resolvedId);
    if (modeScope.requiresGameFriend) {
        policy.friendRelationKnown = !!friendSnapshot;
        if (!friendSnapshot) {
            if (!policy.degradeReason) {
                policy.scopeMatched = false;
                policy.degradeReason = 'friend_relation_unknown';
            }
            matchedPeers = [];
        } else {
            matchedPeers = zoneMatchedPeers.filter((item) => {
                const identifiers = getPeerIdentifiers(item);
                for (const identifier of identifiers) {
                    if (friendSnapshot.identifiers.has(identifier)) return true;
                }
                return false;
            });
            if (!policy.degradeReason && matchedPeers.length === 0) {
                policy.scopeMatched = false;
                policy.degradeReason = 'not_game_friend';
            }
        }
    } else {
        policy.friendRelationKnown = true;
    }

    if (matchedPeers.length > 0) {
        policy.scopeMatched = true;
        policy.collaborationEnabled = true;
        policy.matchedPeerIds = matchedPeers.map(item => String(item.id || '').trim()).filter(Boolean);
        policy.degradeReason = '';
    } else if (modeScope.fallbackBehavior === 'strict_block') {
        policy.effectiveMode = 'safe';
    }

    policy.degradeReasonLabel = describeModeScopeReason(policy.degradeReason);
    return policy;
}

bindRuntimeFriendListener();

module.exports = {
    clearRuntimeFriendsSnapshot,
    describeModeScopeReason,
    getRuntimeAccountModePolicy,
    getRuntimeFriendsSnapshot,
    updateRuntimeFriendsSnapshot,
};
