const crypto = require('node:crypto');
const { createModuleLogger } = require('./logger');
const { createScheduler } = require('./scheduler');
const { insertReportLog, pruneReportLogs } = require('./database');

const logger = createModuleLogger('report-service');
const REPORT_SCAN_INTERVAL_MS = 60 * 1000;
const RESTART_BROADCAST_DEFAULT_MAX_ATTEMPTS = 2;
const RESTART_BROADCAST_DEFAULT_RETRY_DELAY_MS = 30 * 1000;
const REPORT_OPERATION_KEYS = [
    'harvest',
    'water',
    'weed',
    'bug',
    'fertilize',
    'plant',
    'steal',
    'helpWater',
    'helpWeed',
    'helpBug',
    'taskClaim',
    'sell',
    'upgrade',
    'levelUp',
];

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatDateTime(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatSlotDate(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatHourSlot(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return `${formatSlotDate(d)}-${pad2(d.getHours())}`;
}

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function createEmptyOperations() {
    const operations = {};
    for (const key of REPORT_OPERATION_KEYS) {
        operations[key] = 0;
    }
    return operations;
}

function normalizeSnapshot(statusData) {
    const src = (statusData && typeof statusData === 'object') ? statusData : {};
    const rawOperations = (src.operations && typeof src.operations === 'object') ? src.operations : {};
    const operations = createEmptyOperations();
    for (const key of REPORT_OPERATION_KEYS) {
        operations[key] = Math.max(0, Math.floor(toNumber(rawOperations[key])));
    }
    return {
        sessionExpGained: Math.max(0, toNumber(src.sessionExpGained)),
        sessionGoldGained: Math.max(0, toNumber(src.sessionGoldGained)),
        sessionCouponGained: Math.max(0, toNumber(src.sessionCouponGained)),
        operations,
        recordedAt: Date.now(),
    };
}

function diffSnapshots(current, baseline) {
    const base = (baseline && typeof baseline === 'object') ? baseline : null;
    const result = {
        exp: current.sessionExpGained,
        gold: current.sessionGoldGained,
        coupon: current.sessionCouponGained,
        operations: createEmptyOperations(),
        resetDetected: false,
        hasBaseline: !!base,
    };

    if (!base) {
        for (const key of REPORT_OPERATION_KEYS) {
            result.operations[key] = current.operations[key];
        }
        return result;
    }

    if (
        current.sessionExpGained < toNumber(base.sessionExpGained)
        || current.sessionGoldGained < toNumber(base.sessionGoldGained)
        || current.sessionCouponGained < toNumber(base.sessionCouponGained)
    ) {
        result.resetDetected = true;
        for (const key of REPORT_OPERATION_KEYS) {
            result.operations[key] = current.operations[key];
        }
        return result;
    }

    result.exp = Math.max(0, current.sessionExpGained - toNumber(base.sessionExpGained));
    result.gold = Math.max(0, current.sessionGoldGained - toNumber(base.sessionGoldGained));
    result.coupon = Math.max(0, current.sessionCouponGained - toNumber(base.sessionCouponGained));

    for (const key of REPORT_OPERATION_KEYS) {
        const previous = Math.max(0, Math.floor(toNumber(base.operations && base.operations[key])));
        const now = Math.max(0, Math.floor(toNumber(current.operations[key])));
        if (now < previous) {
            result.resetDetected = true;
            result.operations[key] = now;
        } else {
            result.operations[key] = now - previous;
        }
    }

    return result;
}

function buildModeWindow(mode, now) {
    const end = now instanceof Date ? now : new Date(now || Date.now());
    if (mode === 'hourly') {
        return {
            label: `最近1小时 (${formatDateTime(new Date(end.getTime() - 60 * 60 * 1000))} ~ ${formatDateTime(end)})`,
            slot: formatHourSlot(end),
        };
    }
    if (mode === 'daily') {
        const start = new Date(end);
        start.setHours(0, 0, 0, 0);
        return {
            label: `今日累计 (${formatDateTime(start)} ~ ${formatDateTime(end)})`,
            slot: formatSlotDate(end),
        };
    }
    return {
        label: `当前会话 (${formatDateTime(new Date(end.getTime() - 5 * 60 * 1000))} ~ ${formatDateTime(end)})`,
        slot: '',
    };
}

function getReportHeadline(mode) {
    if (mode === 'hourly') return '小时经营汇报';
    if (mode === 'daily') return '每日经营汇报';
    return '经营汇报测试';
}

function buildOperationSummary(diff) {
    const ops = diff && diff.operations ? diff.operations : {};
    const helpTotal = toNumber(ops.helpWater) + toNumber(ops.helpWeed) + toNumber(ops.helpBug);
    const items = [
        ['收获', ops.harvest],
        ['种植', ops.plant],
        ['浇水', ops.water],
        ['除草', ops.weed],
        ['除虫', ops.bug],
        ['施肥', ops.fertilize],
        ['偷菜', ops.steal],
        ['帮忙', helpTotal],
        ['任务', ops.taskClaim],
        ['出售', ops.sell],
        ['升级', ops.upgrade],
        ['升级到账', ops.levelUp],
    ];
    const parts = items
        .map(([label, value]) => [label, Math.max(0, Math.floor(toNumber(value)))])
        .filter(([, value]) => value > 0)
        .map(([label, value]) => `${label}${value}`);
    return parts.length > 0 ? parts.join(' / ') : '无明显动作';
}

function countCollection(value) {
    if (Array.isArray(value)) return value.length;
    return Math.max(0, Math.floor(toNumber(value)));
}

function summarizeLandsData(landsData) {
    const data = (landsData && typeof landsData === 'object') ? landsData : {};
    const lands = Array.isArray(data.lands) ? data.lands : (Array.isArray(data) ? data : []);
    const summary = (data.summary && typeof data.summary === 'object') ? data.summary : {};
    const total = lands.length;
    const harvestable = countCollection(summary.harvestable || summary.harvestableInfo || summary.harvestableCount);
    const growing = countCollection(summary.growing);
    const empty = countCollection(summary.empty);
    const needWater = countCollection(summary.needWater);
    const needWeed = countCollection(summary.needWeed);
    const needBug = countCollection(summary.needBug);
    const soonToMature = countCollection(summary.soonToMature);
    const upgradable = countCollection(summary.upgradable);
    const unlockable = countCollection(summary.unlockable);
    return `农场概况: 土地${total} / 可收${harvestable} / 生长${growing} / 空地${empty} / 需水${needWater} / 草${needWeed} / 虫${needBug} / 即将成熟${soonToMature} / 可升级${upgradable} / 可解锁${unlockable}`;
}

function summarizeBagData(bagData) {
    const data = (bagData && typeof bagData === 'object') ? bagData : {};
    const items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
    const totalKinds = Math.max(0, Math.floor(toNumber(data.totalKinds))) || items.length;
    const totalCount = items.reduce((sum, item) => sum + Math.max(0, Math.floor(toNumber(item && item.count))), 0);
    return `背包概况: 物品种类${totalKinds} / 物品总数${totalCount}`;
}

function summarizeFriendsData(friendsData) {
    const list = Array.isArray(friendsData)
        ? friendsData
        : (friendsData && Array.isArray(friendsData.friends) ? friendsData.friends : []);
    const sampleNames = list
        .map(item => String((item && (item.name || item.remark)) || '').trim())
        .filter(Boolean)
        .slice(0, 3);
    const sampleText = sampleNames.length > 0 ? ` / 示例: ${sampleNames.join('、')}` : '';
    return `好友概况: 有效好友${list.length}${sampleText}`;
}

async function collectLiveDetails(accountId, runtimeStatus, dataProvider) {
    const connection = (runtimeStatus && runtimeStatus.connection && typeof runtimeStatus.connection === 'object') ? runtimeStatus.connection : {};
    const details = {
        farmLine: '',
        bagLine: '',
        friendLine: '',
        notes: [],
    };

    if (!connection.connected) {
        details.notes.push('账号离线，已跳过农场/背包/好友详情采集');
        return details;
    }

    const tasks = [
        Promise.resolve().then(() => dataProvider.getLands(accountId)),
        Promise.resolve().then(() => dataProvider.getBag(accountId)),
        Promise.resolve().then(() => dataProvider.getFriends(accountId)),
    ];
    const [landsRes, bagRes, friendsRes] = await Promise.allSettled(tasks);

    if (landsRes.status === 'fulfilled') {
        details.farmLine = summarizeLandsData(landsRes.value);
    } else {
        details.notes.push(`农场详情采集失败: ${landsRes.reason && landsRes.reason.message ? landsRes.reason.message : 'unknown'}`);
    }

    if (bagRes.status === 'fulfilled') {
        details.bagLine = summarizeBagData(bagRes.value);
    } else {
        details.notes.push(`背包详情采集失败: ${bagRes.reason && bagRes.reason.message ? bagRes.reason.message : 'unknown'}`);
    }

    if (friendsRes.status === 'fulfilled') {
        details.friendLine = summarizeFriendsData(friendsRes.value);
    } else {
        details.notes.push(`好友详情采集失败: ${friendsRes.reason && friendsRes.reason.message ? friendsRes.reason.message : 'unknown'}`);
    }

    return details;
}

function buildReportPayload(mode, account, runtimeStatus, diff, cfg, notes = [], liveDetails = {}) {
    const status = (runtimeStatus && runtimeStatus.status && typeof runtimeStatus.status === 'object') ? runtimeStatus.status : {};
    const connection = (runtimeStatus && runtimeStatus.connection && typeof runtimeStatus.connection === 'object') ? runtimeStatus.connection : {};
    const now = new Date();
    const window = buildModeWindow(mode, now);
    const accountName = String((account && (account.name || account.nick)) || status.name || runtimeStatus.accountName || runtimeStatus.accountId || '').trim() || `账号${runtimeStatus.accountId || ''}`;
    const platform = String(status.platform || account.platform || 'qq').trim() || 'qq';
    const connectLabel = connection.connected ? '在线' : '离线';
    const operationSummary = buildOperationSummary(diff);
    const lines = [
        `账号: ${accountName} (${runtimeStatus.accountId || account.id || ''})`,
        `平台: ${platform}`,
        `连接状态: ${connectLabel}`,
        `统计区间: ${window.label}`,
        `本时段收益: 经验 +${Math.max(0, Math.floor(toNumber(diff.exp)))} / 金币 +${Math.max(0, Math.floor(toNumber(diff.gold)))} / 点券 +${Math.max(0, Math.floor(toNumber(diff.coupon)))}`,
        `本时段动作: ${operationSummary}`,
        `当前面板: 等级 ${Math.max(0, Math.floor(toNumber(status.level)))} / 金币 ${Math.max(0, Math.floor(toNumber(status.gold)))} / 经验 ${Math.max(0, Math.floor(toNumber(status.exp)))}`,
        liveDetails.farmLine || '',
        liveDetails.bagLine || '',
        liveDetails.friendLine || '',
        `发送时间: ${formatDateTime(now)}`,
    ].filter(Boolean);
    if (notes.length > 0) {
        lines.push(`备注: ${notes.join('；')}`);
    }
    return {
        title: `${String(cfg.title || '经营汇报').trim()} · ${getReportHeadline(mode)} · ${accountName}`,
        content: lines.join('\n'),
        slot: window.slot,
    };
}

function buildReportChannelSignature(cfg = {}) {
    const channel = String(cfg.channel || '').trim().toLowerCase();
    if (channel === 'webhook') {
        return `${channel}:${String(cfg.endpoint || '').trim()}:${String(cfg.token || '').trim()}`;
    }
    if (channel === 'email') {
        return `${channel}:${String(cfg.smtpHost || '').trim()}:${String(cfg.smtpPort || '').trim()}:${String(cfg.smtpSecure || '').trim()}:${String(cfg.smtpUser || '').trim()}:${String(cfg.emailFrom || cfg.smtpUser || '').trim()}:${String(cfg.emailTo || '').trim()}`;
    }
    return `${channel}:${String(cfg.token || '').trim()}`;
}

function buildRestartReminderPayload(cfg = {}, groupedAccounts = []) {
    const now = new Date();
    const accountNames = groupedAccounts
        .map(item => String((item && (item.name || item.nick || item.id)) || '').trim())
        .filter(Boolean);
    const displayNames = accountNames.slice(0, 8);
    const extraCount = Math.max(0, accountNames.length - displayNames.length);
    const accountLine = displayNames.length > 0
        ? `${displayNames.join('、')}${extraCount > 0 ? ` 等 ${accountNames.length} 个账号` : ''}`
        : `共 ${groupedAccounts.length} 个账号`;
    const lines = [
        '服务器已完成重启，经营调度与推送链路已恢复。',
        `恢复时间: ${formatDateTime(now)}`,
        `关联账号: ${accountLine}`,
        '说明: 这是系统重启后的统一广播提醒，可用于确认容器/服务已重新上线。',
    ];
    return {
        title: `${String(cfg.title || '经营汇报').trim()} · 服务器重启提醒`,
        content: lines.join('\n'),
    };
}

function createRestartBroadcastBatchId() {
    return `restart_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function buildRestartBroadcastTaskName(batchId, signature) {
    const hash = crypto.createHash('sha1').update(`${batchId}:${signature}`).digest('hex').slice(0, 16);
    return `restart_broadcast_retry_${hash}`;
}

function createReportService(options = {}) {
    const {
        store,
        dataProvider,
        getAccounts,
        sendPushooMessage,
        log,
        addAccountLog,
        scheduler: injectedScheduler,
        restartBroadcastBatchId: injectedRestartBroadcastBatchId,
        restartBroadcastRetryDelayMs: injectedRestartBroadcastRetryDelayMs,
        restartBroadcastMaxAttempts: injectedRestartBroadcastMaxAttempts,
    } = options;

    const scheduler = injectedScheduler || createScheduler('account-report-service');
    let started = false;
    let scanning = false;
    let lastRetentionSweepDate = '';
    let restartBroadcastPrepared = false;
    const restartBroadcastBatchId = String(injectedRestartBroadcastBatchId || createRestartBroadcastBatchId());
    const restartBroadcastRetryDelayMs = Math.max(1000, Number.parseInt(injectedRestartBroadcastRetryDelayMs, 10) || RESTART_BROADCAST_DEFAULT_RETRY_DELAY_MS);
    const restartBroadcastMaxAttempts = Math.max(1, Number.parseInt(injectedRestartBroadcastMaxAttempts, 10) || RESTART_BROADCAST_DEFAULT_MAX_ATTEMPTS);
    const restartBroadcastStates = new Map();

    async function listAccounts() {
        const result = await Promise.resolve(typeof getAccounts === 'function' ? getAccounts() : { accounts: [] });
        if (Array.isArray(result)) return result;
        return Array.isArray(result && result.accounts) ? result.accounts : [];
    }

    function canSendByConfig(cfg) {
        if (!cfg || !cfg.enabled) return false;
        if (!cfg.channel) return false;
        if (cfg.channel === 'webhook') return !!String(cfg.endpoint || '').trim();
        if (cfg.channel === 'email') {
            const smtpHost = String(cfg.smtpHost || '').trim();
            const emailTo = String(cfg.emailTo || '').trim();
            const emailFrom = String(cfg.emailFrom || cfg.smtpUser || '').trim();
            return !!(smtpHost && emailTo && emailFrom);
        }
        return !!String(cfg.token || '').trim();
    }

    function isHourlyDue(cfg, state, now) {
        if (!cfg.enabled || !cfg.hourlyEnabled) return false;
        if (now.getMinutes() < Math.max(0, Math.min(59, Number.parseInt(cfg.hourlyMinute, 10) || 0))) return false;
        const slot = formatHourSlot(now);
        return String(state.lastHourlySlot || '') !== slot;
    }

    function isDailyDue(cfg, state, now) {
        if (!cfg.enabled || !cfg.dailyEnabled) return false;
        const targetHour = Math.max(0, Math.min(23, Number.parseInt(cfg.dailyHour, 10) || 0));
        const targetMinute = Math.max(0, Math.min(59, Number.parseInt(cfg.dailyMinute, 10) || 0));
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const targetMinutes = targetHour * 60 + targetMinute;
        if (currentMinutes < targetMinutes) return false;
        const slot = formatSlotDate(now);
        return String(state.lastDailySlot || '') !== slot;
    }

    async function pruneHistoryForAccount(accountId, cfg = null) {
        const normalizedAccountId = String(accountId || '').trim();
        if (!normalizedAccountId) {
            return { ok: false, affectedRows: 0, retentionDays: 0 };
        }
        const reportConfig = cfg && typeof cfg === 'object'
            ? cfg
            : (store.getReportConfig ? store.getReportConfig(normalizedAccountId) : null);
        const retentionDays = Math.max(0, Math.min(365, Number.parseInt(reportConfig && reportConfig.retentionDays, 10) || 0));
        if (retentionDays <= 0) {
            return { ok: true, affectedRows: 0, retentionDays };
        }
        try {
            return await pruneReportLogs(normalizedAccountId, { retentionDays });
        } catch (error) {
            logger.warn(`清理经营汇报历史失败(${normalizedAccountId}): ${error && error.message ? error.message : String(error)}`);
            return { ok: false, affectedRows: 0, retentionDays, error: error && error.message ? error.message : String(error) };
        }
    }

    async function runRetentionSweep(now = new Date()) {
        const sweepDate = formatSlotDate(now);
        if (lastRetentionSweepDate === sweepDate) return { ok: true, affectedRows: 0, skipped: true };
        const accounts = await listAccounts();
        let affectedRows = 0;
        try {
            for (const account of accounts) {
                const accountId = String(account && account.id || '').trim();
                if (!accountId) continue;
                const cfg = store.getReportConfig ? store.getReportConfig(accountId) : null;
                if (!cfg) continue;
                const result = await pruneHistoryForAccount(accountId, cfg);
                affectedRows += Number(result && result.affectedRows) || 0;
            }
            lastRetentionSweepDate = sweepDate;
            if (affectedRows > 0) {
                logger.info(`经营汇报历史自动清理完成: 删除 ${affectedRows} 条过期记录`);
            }
            return { ok: true, affectedRows };
        } catch (error) {
            logger.warn(`经营汇报历史定时清理失败: ${error && error.message ? error.message : String(error)}`);
            return { ok: false, affectedRows, error: error && error.message ? error.message : String(error) };
        }
    }

    async function sendReport(accountRef, mode, sendOptions = {}) {
        const accountId = await Promise.resolve(dataProvider.resolveAccountId(accountRef));
        if (!accountId) {
            return { ok: false, error: '账号不存在' };
        }

        const accounts = await listAccounts();
        const account = accounts.find(item => String(item && item.id) === String(accountId)) || { id: accountId };
        const reportConfig = store.getReportConfig ? store.getReportConfig(accountId) : null;
        const reportState = store.getReportState ? store.getReportState(accountId) : {};
        const ignoreEnabled = !!sendOptions.ignoreEnabled;
        const updateState = sendOptions.updateState !== false;

        if (!ignoreEnabled && (!reportConfig || !reportConfig.enabled)) {
            return { ok: false, error: '经营汇报未开启' };
        }

        if (!canSendByConfig({ ...(reportConfig || {}), enabled: true })) {
            return { ok: false, error: '经营汇报推送配置不完整' };
        }

        const runtimeStatus = await Promise.resolve(dataProvider.getStatus(accountId));
        const currentSnapshot = normalizeSnapshot(runtimeStatus);
        const notes = [];
        let diff;
        let nextState = reportState;

        if (mode === 'test') {
            diff = diffSnapshots(currentSnapshot, null);
            notes.push('测试发送不会改写定时汇报基线');
        } else if (mode === 'hourly') {
            diff = diffSnapshots(currentSnapshot, reportState.hourlyBaseline);
            if (diff.resetDetected) notes.push('检测到统计会话重置，本次按当前会话累计值汇报');
            nextState = {
                ...reportState,
                lastHourlySlot: String(sendOptions.slot || formatHourSlot(new Date())).trim(),
                hourlyBaseline: currentSnapshot,
            };
        } else {
            diff = diffSnapshots(currentSnapshot, reportState.dailyBaseline);
            if (diff.resetDetected) notes.push('检测到统计会话重置，本次按当前会话累计值汇报');
            nextState = {
                ...reportState,
                lastDailySlot: String(sendOptions.slot || formatSlotDate(new Date())).trim(),
                dailyBaseline: currentSnapshot,
            };
        }

        const liveDetails = await collectLiveDetails(accountId, runtimeStatus, dataProvider);
        const mergedNotes = [...notes, ...(liveDetails.notes || [])];
        const payload = buildReportPayload(mode, account, runtimeStatus, diff, reportConfig || {}, mergedNotes, liveDetails);
        const delivery = await sendPushooMessage({
            channel: reportConfig.channel,
            endpoint: reportConfig.endpoint,
            token: reportConfig.token,
            smtpHost: reportConfig.smtpHost,
            smtpPort: reportConfig.smtpPort,
            smtpSecure: reportConfig.smtpSecure,
            smtpUser: reportConfig.smtpUser,
            smtpPass: reportConfig.smtpPass,
            emailFrom: reportConfig.emailFrom,
            emailTo: reportConfig.emailTo,
            title: payload.title,
            content: payload.content,
        });

        try {
            await insertReportLog({
                accountId,
                accountName: account.name || account.nick || runtimeStatus.accountName || runtimeStatus.accountId || '',
                mode,
                ok: !!(delivery && delivery.ok),
                channel: reportConfig.channel,
                title: payload.title,
                content: payload.content,
                errorMessage: delivery && delivery.ok ? '' : String((delivery && delivery.msg) || '发送失败'),
            });
        } catch (e) {
            logger.warn(`记录经营汇报历史失败: ${e && e.message ? e.message : String(e)}`);
        }

        const pruneResult = await pruneHistoryForAccount(accountId, reportConfig);
        if (pruneResult && pruneResult.ok && Number(pruneResult.affectedRows) > 0) {
            logger.info(`${accountId} 经营汇报历史已自动清理 ${pruneResult.affectedRows} 条过期记录`);
        }

        if (delivery && delivery.ok && updateState && store.setReportState) {
            store.setReportState(accountId, nextState);
        }

        if (delivery && delivery.ok) {
            if (typeof addAccountLog === 'function') {
                addAccountLog('report_send', `${getReportHeadline(mode)}发送成功`, accountId, account.name || account.nick || '', { mode });
            }
            if (typeof log === 'function') {
                log('系统', `${account.name || account.nick || accountId} ${getReportHeadline(mode)}发送成功`, {
                    module: 'report',
                    event: 'report_send',
                    accountId: String(accountId),
                    mode,
                });
            }
            return { ok: true, delivery, preview: payload };
        }

        const errorMsg = String((delivery && delivery.msg) || '发送失败');
        if (typeof addAccountLog === 'function') {
            addAccountLog('report_send_failed', `${getReportHeadline(mode)}发送失败: ${errorMsg}`, accountId, account.name || account.nick || '', { mode });
        }
        logger.warn(`${accountId} ${getReportHeadline(mode)}发送失败: ${errorMsg}`);
        return { ok: false, error: errorMsg, delivery, preview: payload };
    }

    function addRestartBroadcastAccountLog(event, message, accountId, accountName, extra = {}) {
        if (typeof addAccountLog !== 'function') return;
        try {
            addAccountLog(event, message, accountId, accountName, extra);
        } catch (error) {
            logger.warn(`记录服务器重启提醒账号日志失败(${accountId || 'unknown'}): ${error && error.message ? error.message : String(error)}`);
        }
    }

    function scheduleRestartBroadcastRetry(state) {
        state.nextRetryAt = Date.now() + restartBroadcastRetryDelayMs;
        scheduler.setTimeoutTask(state.taskName, restartBroadcastRetryDelayMs, async () => {
            await sendRestartBroadcast();
        });
    }

    function handleRestartBroadcastFailure(state, errorMessage) {
        state.lastError = String(errorMessage || '发送失败');
        if (state.attempts < restartBroadcastMaxAttempts) {
            scheduleRestartBroadcastRetry(state);
            logger.warn(`服务器重启提醒发送失败: ${state.lastError}，将在 ${Math.round(restartBroadcastRetryDelayMs / 1000)} 秒后重试 (批次 ${restartBroadcastBatchId}, 第 ${state.attempts}/${restartBroadcastMaxAttempts} 次)`);
            return;
        }

        state.failed = true;
        state.nextRetryAt = 0;
        logger.warn(`服务器重启提醒最终发送失败: ${state.lastError} (批次 ${restartBroadcastBatchId}, 已尝试 ${state.attempts} 次)`);
    }

    async function deliverRestartBroadcast(state) {
        const { cfg, accounts: groupedAccounts } = state;
        const payload = buildRestartReminderPayload(cfg, groupedAccounts);
        let delivery;
        try {
            delivery = await sendPushooMessage({
                channel: cfg.channel,
                endpoint: cfg.endpoint,
                token: cfg.token,
                smtpHost: cfg.smtpHost,
                smtpPort: cfg.smtpPort,
                smtpSecure: cfg.smtpSecure,
                smtpUser: cfg.smtpUser,
                smtpPass: cfg.smtpPass,
                emailFrom: cfg.emailFrom,
                emailTo: cfg.emailTo,
                title: payload.title,
                content: payload.content,
            });
        } catch (error) {
            delivery = {
                ok: false,
                msg: error && error.message ? error.message : String(error),
            };
        }

        const delivered = !!(delivery && delivery.ok);
        state.lastError = delivered ? '' : String((delivery && delivery.msg) || '发送失败');

        for (const account of groupedAccounts) {
            const accountId = String(account && account.id || '').trim();
            const accountName = String((account && (account.name || account.nick)) || '').trim();
            if (!accountId) continue;
            if (delivered) {
                addRestartBroadcastAccountLog('report_restart_broadcast', '服务器重启提醒已广播', accountId, accountName, {
                    channel: cfg.channel,
                    batchId: restartBroadcastBatchId,
                    attempt: state.attempts,
                });
            } else {
                addRestartBroadcastAccountLog('report_restart_broadcast_failed', `服务器重启提醒发送失败: ${state.lastError}`, accountId, accountName, {
                    channel: cfg.channel,
                    batchId: restartBroadcastBatchId,
                    attempt: state.attempts,
                });
            }
        }

        if (delivered) {
            state.delivered = true;
            state.failed = false;
            state.nextRetryAt = 0;
            logger.info(`服务器重启提醒发送成功: 渠道 ${cfg.channel}, 覆盖 ${groupedAccounts.length} 个账号, 批次 ${restartBroadcastBatchId}, 第 ${state.attempts} 次尝试`);
            return;
        }

        handleRestartBroadcastFailure(state, state.lastError);
    }

    async function scanDueReports() {
        if (scanning) return;
        scanning = true;
        try {
            const now = new Date();
            await runRetentionSweep(now);
            const accounts = await listAccounts();
            for (const account of accounts) {
                const accountId = String(account && account.id || '').trim();
                if (!accountId) continue;
                const cfg = store.getReportConfig ? store.getReportConfig(accountId) : null;
                const state = store.getReportState ? store.getReportState(accountId) : {};
                if (!cfg || !cfg.enabled) continue;
                if (!canSendByConfig(cfg)) continue;

                if (isHourlyDue(cfg, state, now)) {
                    await sendReport(accountId, 'hourly', { slot: formatHourSlot(now) });
                }
                if (isDailyDue(cfg, state, now)) {
                    await sendReport(accountId, 'daily', { slot: formatSlotDate(now) });
                }
            }
        } catch (error) {
            logger.warn(`定时扫描经营汇报失败: ${error && error.message ? error.message : String(error)}`);
        } finally {
            scanning = false;
        }
    }

    async function sendRestartBroadcast() {
        try {
            if (!restartBroadcastPrepared) {
                const accounts = await listAccounts();
                const groupedChannels = new Map();

                for (const account of accounts) {
                    const accountId = String(account && account.id || '').trim();
                    if (!accountId) continue;
                    const cfg = store.getReportConfig ? store.getReportConfig(accountId) : null;
                    if (!cfg || !cfg.enabled) continue;
                    if (!canSendByConfig(cfg)) continue;

                    const signature = buildReportChannelSignature(cfg);
                    if (!signature) continue;
                    const existing = groupedChannels.get(signature);
                    if (existing) {
                        existing.accounts.push(account);
                    } else {
                        groupedChannels.set(signature, {
                            cfg,
                            accounts: [account],
                        });
                    }
                }

                restartBroadcastPrepared = true;
                for (const [signature, grouped] of groupedChannels.entries()) {
                    restartBroadcastStates.set(signature, {
                        batchId: restartBroadcastBatchId,
                        signature,
                        cfg: grouped.cfg,
                        accounts: grouped.accounts,
                        taskName: buildRestartBroadcastTaskName(restartBroadcastBatchId, signature),
                        attempts: 0,
                        delivered: false,
                        failed: false,
                        inFlight: false,
                        nextRetryAt: 0,
                        lastError: '',
                    });
                }
            }

            if (restartBroadcastStates.size === 0) {
                logger.info('未发现已启用的经营提醒渠道，跳过服务器重启广播');
                return;
            }

            for (const state of restartBroadcastStates.values()) {
                if (state.delivered || state.failed || state.inFlight) continue;
                if (state.nextRetryAt > Date.now()) continue;

                state.inFlight = true;
                state.nextRetryAt = 0;
                state.attempts += 1;
                try {
                    await deliverRestartBroadcast(state);
                } catch (error) {
                    handleRestartBroadcastFailure(state, error && error.message ? error.message : String(error));
                } finally {
                    state.inFlight = false;
                }
            }
        } catch (error) {
            logger.warn(`服务器重启提醒广播失败: ${error && error.message ? error.message : String(error)}`);
        }
    }

    function start() {
        if (started) return;
        started = true;
        scheduler.setIntervalTask('scan-account-reports', REPORT_SCAN_INTERVAL_MS, scanDueReports, {
            runImmediately: true,
        });
        logger.info('已启动经营汇报定时扫描服务');
        void sendRestartBroadcast();
    }

    function stop() {
        scheduler.clearAll();
        started = false;
    }

    return {
        start,
        stop,
        sendTestReport: async (accountRef) => await sendReport(accountRef, 'test', { ignoreEnabled: true, updateState: false }),
        sendHourlyReport: async (accountRef) => await sendReport(accountRef, 'hourly'),
        sendDailyReport: async (accountRef) => await sendReport(accountRef, 'daily'),
        scanDueReports,
        runRetentionSweep,
        sendRestartBroadcast,
        getRestartBroadcastState: () => ({
            batchId: restartBroadcastBatchId,
            states: Array.from(restartBroadcastStates.values()).map(state => ({
                batchId: state.batchId,
                signature: state.signature,
                taskName: state.taskName,
                attempts: state.attempts,
                delivered: state.delivered,
                failed: state.failed,
                inFlight: state.inFlight,
                nextRetryAt: state.nextRetryAt,
                lastError: state.lastError,
            })),
        }),
    };
}

module.exports = {
    createReportService,
};
