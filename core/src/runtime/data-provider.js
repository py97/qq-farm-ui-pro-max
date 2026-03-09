const { findAccountByRef, normalizeAccountRef, resolveAccountId: resolveAccountIdByList } = require('../services/account-resolver');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');

function createDataProvider(options) {
    const {
        workers,
        globalLogs,
        accountLogs,
        store,
        accountRepository,
        getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
    } = options;

    async function getStoredAccountsList() {
        const data = await getAccounts();
        return Array.isArray(data.accounts) ? data.accounts : [];
    }

    async function resolveAccountRefId(accountRef) {
        const raw = normalizeAccountRef(accountRef);
        if (!raw) return '';
        const list = await getStoredAccountsList();
        const resolved = resolveAccountIdByList(list, raw);
        return resolved || raw;
    }

    async function findAccountByAnyRef(accountRef) {
        const list = await getStoredAccountsList();
        return findAccountByRef(list, accountRef);
    }

    async function persistModeSnapshot(accountId, downgraded = []) {
        if (!accountRepository || typeof accountRepository.updateConfig !== 'function') {
            return;
        }

        const targetSnapshot = typeof store.getConfigSnapshot === 'function'
            ? (store.getConfigSnapshot(accountId) || {})
            : {};
        await accountRepository.updateConfig(accountId, {
            account_mode: targetSnapshot.accountMode || 'main',
            harvest_delay_min: targetSnapshot.harvestDelay?.min || 0,
            harvest_delay_max: targetSnapshot.harvestDelay?.max || 0,
        });

        for (const item of downgraded) {
            const downgradedId = String(item && item.id || '').trim();
            if (!downgradedId) continue;
            const snapshot = typeof store.getConfigSnapshot === 'function'
                ? (store.getConfigSnapshot(downgradedId) || {})
                : {};
            await accountRepository.updateConfig(downgradedId, {
                account_mode: snapshot.accountMode || 'main',
                harvest_delay_min: snapshot.harvestDelay?.min || 0,
                harvest_delay_max: snapshot.harvestDelay?.max || 0,
            });
        }
    }

    async function applyAccountModeWithinSettings(accountId, requestedMode) {
        const mode = String(requestedMode || '').trim();
        if (!mode) {
            return { downgraded: [] };
        }
        if (!store.ACCOUNT_MODE_PRESETS || !store.ACCOUNT_MODE_PRESETS[mode]) {
            throw new Error('Invalid account mode');
        }

        let downgraded = [];
        if (mode === 'main' && typeof store.ensureMainAccountUnique === 'function') {
            const accounts = await getStoredAccountsList();
            const target = accounts.find(item => String(item && item.id || '') === String(accountId));
            const ownerUsername = String((target && target.username) || '').trim();
            if (ownerUsername) {
                downgraded = await store.ensureMainAccountUnique(accountId, ownerUsername);
            }
        }

        if (typeof store.applyAccountMode === 'function') {
            store.applyAccountMode(accountId, mode);
        }

        return { downgraded };
    }

    return {
        resolveAccountId: async (accountRef) => await resolveAccountRefId(accountRef),

        // 获取指定账号的状态 (如果 accountId 为空，返回概览?)
        getStatus: async (accountRef) => {
            const accountId = await resolveAccountRefId(accountRef);
            if (!accountId) return buildDefaultStatus('');
            const w = workers[accountId];
            if (!w || !w.status) {
                const list = await getStoredAccountsList();
                const account = list.find(a => String(a.id || '') === String(accountId));
                return {
                    ...buildDefaultStatus(accountId),
                    wsError: account && account.wsError ? account.wsError : null,
                };
            }
            return {
                ...buildDefaultStatus(accountId),
                ...normalizeStatusForPanel(w.status, accountId, w.name),
                wsError: w.wsError || null,
            };
        },

        getLogs: async (accountRef, optionsOrLimit) => {
            const opts = (typeof optionsOrLimit === 'object' && optionsOrLimit) ? optionsOrLimit : { limit: optionsOrLimit };
            const max = Math.max(1, Number(opts.limit) || 100);
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = await resolveAccountRefId(accountRef);
            if (!rawRef) {
                return filterLogs(globalLogs, opts).slice(-max);
            }
            if (!accountId) return [];
            const accId = String(accountId || '');
            const w = workers[accId];
            if (w && Array.isArray(w.logs) && w.logs.length > 0) {
                return filterLogs(w.logs, opts).slice(-max);
            }
            return filterLogs(globalLogs.filter(l => String(l.accountId || '') === accId), opts).slice(-max);
        },

        getAccountLogs: (limit) => accountLogs.slice(-limit).reverse(),
        addAccountLog: (action, msg, accountId, accountName, extra) => addAccountLog(action, msg, accountId, accountName, extra),

        // 透传方法
        getLands: async (accountRef) => callWorkerApi(await resolveAccountRefId(accountRef), 'getLands'),
        getFriends: async (accountRef) => callWorkerApi(await resolveAccountRefId(accountRef), 'getFriends'),
        getFriendLands: async (accountRef, gid) => callWorkerApi(await resolveAccountRefId(accountRef), 'getFriendLands', gid),
        doFriendOp: async (accountRef, gid, opType) => callWorkerApi(await resolveAccountRefId(accountRef), 'doFriendOp', gid, opType),
        doFriendBatchOp: async (accountRef, gids, opType, options) => callWorkerApi(await resolveAccountRefId(accountRef), 'doFriendBatchOp', gids, opType, options),
        getBag: async (accountRef) => callWorkerApi(await resolveAccountRefId(accountRef), 'getBag'),
        useBagItem: async (accountRef, itemId, count, landIds) => callWorkerApi(await resolveAccountRefId(accountRef), 'useBagItem', itemId, count, landIds),
        getMallGoods: async (accountRef, slotType) => callWorkerApi(await resolveAccountRefId(accountRef), 'getMallGoods', slotType),
        buyMallGoods: async (accountRef, goodsId, count) => callWorkerApi(await resolveAccountRefId(accountRef), 'buyMallGoods', goodsId, count),
        getSellPreview: async (accountRef, tradeConfig) => callWorkerApi(await resolveAccountRefId(accountRef), 'getSellPreview', tradeConfig),
        sellByPolicy: async (accountRef, tradeConfig, options) => callWorkerApi(await resolveAccountRefId(accountRef), 'sellByPolicy', tradeConfig, options),
        sellSelected: async (accountRef, itemIds, options) => callWorkerApi(await resolveAccountRefId(accountRef), 'sellSelected', itemIds, options),
        getDailyGifts: async (accountRef) => callWorkerApi(await resolveAccountRefId(accountRef), 'getDailyGiftOverview'),
        getSeeds: async (accountRef) => callWorkerApi(await resolveAccountRefId(accountRef), 'getSeeds'),

        setAutomation: async (accountRef, key, value) => {
            const accountId = await resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            store.setAutomation(key, value, accountId);
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(accountId);
            return { automation: store.getAutomation(accountId), configRevision: rev };
        },

        doFarmOp: async (accountRef, opType) => callWorkerApi(await resolveAccountRefId(accountRef), 'doFarmOp', opType),
        doAnalytics: async (accountRef, sortBy) => callWorkerApi(await resolveAccountRefId(accountRef), 'getAnalytics', sortBy),
        saveSettings: async (accountRef, payload) => {
            const accountId = await resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            const body = (payload && typeof payload === 'object') ? payload : {};
            const automation = (body.automation && typeof body.automation === 'object') ? body.automation : {};
            const requestedMode = body.accountMode !== undefined ? String(body.accountMode || '').trim() : '';
            const plantingStrategy = (body.plantingStrategy !== undefined) ? body.plantingStrategy : body.strategy;
            const plantingFallbackStrategy = body.plantingFallbackStrategy;
            const preferredSeedId = (body.preferredSeedId !== undefined)
                ? body.preferredSeedId
                : (body.preferredSeed !== undefined ? body.preferredSeed : body.seedId);
            const inventoryPlanting = body.inventoryPlanting;
            const derivedStealFilter = body.stealFilter !== undefined
                ? body.stealFilter
                : ((automation.stealFilterEnabled !== undefined || automation.stealFilterMode !== undefined || automation.stealFilterPlantIds !== undefined)
                    ? {
                            enabled: !!automation.stealFilterEnabled,
                            mode: automation.stealFilterMode === 'whitelist' ? 'whitelist' : 'blacklist',
                            plantIds: Array.isArray(automation.stealFilterPlantIds) ? automation.stealFilterPlantIds.map(String) : [],
                        }
                    : undefined);
            const derivedStealFriendFilter = body.stealFriendFilter !== undefined
                ? body.stealFriendFilter
                : ((automation.stealFriendFilterEnabled !== undefined || automation.stealFriendFilterMode !== undefined || automation.stealFriendFilterIds !== undefined)
                    ? {
                            enabled: !!automation.stealFriendFilterEnabled,
                            mode: automation.stealFriendFilterMode === 'whitelist' ? 'whitelist' : 'blacklist',
                            friendIds: Array.isArray(automation.stealFriendFilterIds) ? automation.stealFriendFilterIds.map(String) : [],
                        }
                    : undefined);
            const snapshot = {
                accountMode: body.accountMode,
                harvestDelay: body.harvestDelay,
                riskPromptEnabled: body.riskPromptEnabled,
                modeScope: body.modeScope,
                plantingStrategy,
                plantingFallbackStrategy,
                preferredSeedId,
                inventoryPlanting,
                intervals: body.intervals,
                friendQuietHours: body.friendQuietHours,
            };
            if (body.automation !== undefined) {
                snapshot.automation = body.automation;
            }
            if (derivedStealFilter !== undefined) {
                snapshot.stealFilter = derivedStealFilter;
            }
            if (derivedStealFriendFilter !== undefined) {
                snapshot.stealFriendFilter = derivedStealFriendFilter;
            }
            if (body.stakeoutSteal !== undefined) {
                snapshot.stakeoutSteal = body.stakeoutSteal;
            }
            if (automation.skipStealRadishEnabled !== undefined) {
                snapshot.skipStealRadish = { enabled: !!automation.skipStealRadishEnabled };
            }
            if (automation.forceGetAllEnabled !== undefined) {
                snapshot.forceGetAll = { enabled: !!automation.forceGetAllEnabled };
            }
            if (body.workflowConfig !== undefined) {
                snapshot.workflowConfig = body.workflowConfig;
            }
            if (body.tradeConfig !== undefined) {
                snapshot.tradeConfig = body.tradeConfig;
            }
            if (body.reportConfig !== undefined) {
                snapshot.reportConfig = body.reportConfig;
            }

            const { downgraded } = await applyAccountModeWithinSettings(accountId, requestedMode);
            store.applyConfigSnapshot(snapshot, { accountId });
            await persistModeSnapshot(accountId, downgraded);
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(accountId);
            for (const item of downgraded) {
                const downgradedId = String(item && item.id || '').trim();
                if (!downgradedId) continue;
                broadcastConfigToWorkers(downgradedId);
            }
            return {
                strategy: store.getPlantingStrategy(accountId),
                plantingStrategy: store.getPlantingStrategy(accountId),
                plantingFallbackStrategy: store.getConfigSnapshot(accountId).plantingFallbackStrategy,
                preferredSeed: store.getPreferredSeed(accountId),
                preferredSeedId: store.getPreferredSeed(accountId),
                inventoryPlanting: store.getConfigSnapshot(accountId).inventoryPlanting,
                intervals: store.getIntervals(accountId),
                friendQuietHours: store.getFriendQuietHours(accountId),
                tradeConfig: store.getTradeConfig ? store.getTradeConfig(accountId) : {},
                reportConfig: store.getReportConfig ? store.getReportConfig(accountId) : {},
                configRevision: rev,
            };
        },

        setUITheme: async (theme) => {
            const snapshot = store.setUITheme(theme);
            return { ui: snapshot.ui || store.getUI() };
        },

        broadcastConfig: (accountId) => {
            broadcastConfigToWorkers(accountId);
        },

        setRuntimeAccountName: async (accountRef, accountName) => {
            const accountId = await resolveAccountRefId(accountRef);
            if (!accountId) return;
            const worker = workers[accountId];
            if (worker) {
                worker.name = String(accountName || worker.name || accountId);
            }
        },

        // 账号管理直接操作 store
        getAccounts: async () => {
            const data = await getAccounts();
            data.accounts.forEach((a) => {
                const accountId = String(a.id || '');
                const worker = workers[accountId];
                const storedRunning = !!a.running;
                const storedConnected = !!a.connected;

                a.running = storedRunning || !!worker;
                const configSnapshot = typeof store.getConfigSnapshot === 'function'
                    ? (store.getConfigSnapshot(accountId) || {})
                    : {};
                a.accountMode = configSnapshot.accountMode || 'main';
                a.effectiveMode = a.accountMode;
                a.harvestDelay = configSnapshot.harvestDelay || { min: 0, max: 0 };
                a.riskPromptEnabled = configSnapshot.riskPromptEnabled !== false;
                a.modeScope = configSnapshot.modeScope || {
                    zoneScope: 'same_zone_only',
                    requiresGameFriend: true,
                    fallbackBehavior: 'standalone',
                };
                a.accountZone = typeof store.resolveAccountZone === 'function'
                    ? store.resolveAccountZone(a.platform)
                    : 'unknown_zone';
                a.collaborationEnabled = false;
                a.degradeReason = '';
                a.degradeReasonLabel = '';

                if (worker) {
                    a.wsError = worker.wsError ? { code: worker.wsError.code, message: worker.wsError.message } : null;
                    if (worker.status && worker.status.connection) {
                        a.connected = !!worker.status.connection.connected;
                    } else {
                        a.connected = false;
                    }
                } else {
                    a.connected = storedConnected;
                    a.wsError = a.wsError || null;
                }

                if (worker && worker.status) {
                    const st = worker.status.status || {};
                    // 附加昵称
                    if (st.name) {
                        a.nick = st.name;
                    }
                    // 附加实时统计数据（用于排行榜和面板展示）
                    a.level = st.level || 0;
                    a.gold = st.gold || 0;
                    a.exp = st.exp || 0;
                    a.coupon = st.coupon || 0;
                    a.uptime = worker.status.uptime || 0;
                    a.effectiveMode = worker.status.effectiveMode || a.effectiveMode;
                    a.accountZone = worker.status.accountZone || a.accountZone;
                    a.collaborationEnabled = !!worker.status.collaborationEnabled;
                    a.degradeReason = worker.status.degradeReason || '';
                    a.degradeReasonLabel = worker.status.degradeReasonLabel || '';
                }
            });
            return data;
        },

        startAccount: async (accountRef) => {
            const accountId = await resolveAccountRefId(accountRef);
            let acc = await findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            // 解决精简版数据遗漏 code 字段导致连接 websocket 时抛出 400 失败的问题
            if (store && typeof store.getAccountFull === 'function') {
                const fullAcc = await store.getAccountFull(acc.id);
                if (fullAcc) {
                    // 数据库里的完整账号记录应覆盖列表缓存，避免新 code 被旧缓存回填
                    acc = { ...acc, ...fullAcc };
                }
            }
            return !!(await startWorker(acc));
        },

        stopAccount: async (accountRef) => {
            const accountId = await resolveAccountRefId(accountRef);
            const acc = await findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            if (accountId) stopWorker(accountId);
            return true;
        },

        restartAccount: async (accountRef) => {
            const accountId = await resolveAccountRefId(accountRef);
            let acc = await findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            // 补全 code 等 auth_data 字段，避免精简版数据缺失导致 WS 400
            if (store && typeof store.getAccountFull === 'function') {
                const fullAcc = await store.getAccountFull(acc.id);
                if (fullAcc) {
                    acc = { ...fullAcc, ...acc };
                }
            }
            return !!(await restartWorker(acc));
        },

        isAccountRunning: async (accountRef) => {
            const accountId = await resolveAccountRefId(accountRef);
            return !!(accountId && workers[accountId]);
        },

        getSchedulerStatus: async (accountRef) => {
            const accountId = await resolveAccountRefId(accountRef);
            const runtime = getSchedulerRegistrySnapshot();
            let worker = null;
            let workerError = '';

            if (!accountId) {
                return { accountId: '', runtime, worker, workerError };
            }

            if (!workers[accountId]) {
                return { accountId, runtime, worker, workerError: '账号未运行' };
            }

            try {
                worker = await callWorkerApi(accountId, 'getSchedulers');
            } catch (e) {
                workerError = (e && e.message) ? e.message : String(e || 'unknown');
            }
            return { accountId, runtime, worker, workerError };
        },
    };
}

module.exports = {
    createDataProvider,
};
