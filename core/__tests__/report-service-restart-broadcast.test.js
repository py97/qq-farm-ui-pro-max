const test = require('node:test');
const assert = require('node:assert/strict');

const reportServiceModulePath = require.resolve('../src/services/report-service');
const databaseModulePath = require.resolve('../src/services/database');
const loggerModulePath = require.resolve('../src/services/logger');

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

function createSchedulerMock() {
    const timeoutTasks = new Map();

    return {
        setTimeoutTask(taskName, delayMs, taskFn) {
            timeoutTasks.set(String(taskName), {
                delayMs: Math.max(0, Number(delayMs) || 0),
                taskFn,
            });
        },
        setIntervalTask() {
            return null;
        },
        clearAll() {
            timeoutTasks.clear();
        },
        getTimeoutNames() {
            return Array.from(timeoutTasks.keys());
        },
        getDelay(taskName) {
            const task = timeoutTasks.get(String(taskName));
            return task ? task.delayMs : 0;
        },
        async runTimeout(taskName) {
            const key = String(taskName);
            const task = timeoutTasks.get(key);
            if (!task) {
                throw new Error(`timeout task not found: ${key}`);
            }
            timeoutTasks.delete(key);
            await task.taskFn();
        },
    };
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('restart broadcast retries once and does not resend after delivery', async () => {
    const restoreDatabase = mockModule(databaseModulePath, {
        async insertReportLog() {
            return { ok: true };
        },
        async pruneReportLogs() {
            return { ok: true, affectedRows: 0 };
        },
    });
    const restoreLogger = mockModule(loggerModulePath, {
        createModuleLogger() {
            return {
                info() {},
                warn() {},
                error() {},
            };
        },
    });

    try {
        delete require.cache[reportServiceModulePath];
        const { createReportService } = require(reportServiceModulePath);
        const scheduler = createSchedulerMock();
        const deliveries = [];
        const accountLogs = [];
        let sendAttempts = 0;

        const service = createReportService({
            store: {
                getReportConfig(accountId) {
                    if (!accountId) return null;
                    return {
                        enabled: true,
                        channel: 'webhook',
                        endpoint: 'https://example.com/hook',
                        token: 'same-token',
                        title: '经营汇报',
                    };
                },
            },
            dataProvider: {},
            getAccounts() {
                return [
                    { id: '1001', name: '账号A' },
                    { id: '1002', name: '账号B' },
                ];
            },
            async sendPushooMessage(payload) {
                deliveries.push(payload);
                sendAttempts += 1;
                if (sendAttempts === 1) {
                    return { ok: false, msg: 'gateway timeout' };
                }
                return { ok: true, msg: 'ok' };
            },
            addAccountLog(event, message, accountId, accountName, meta) {
                accountLogs.push({ event, message, accountId, accountName, meta });
            },
            scheduler,
            restartBroadcastRetryDelayMs: 1000,
            restartBroadcastMaxAttempts: 2,
            restartBroadcastBatchId: 'restart_test_batch',
        });

        await service.sendRestartBroadcast();

        assert.equal(deliveries.length, 1);
        assert.equal(accountLogs.filter(item => item.event === 'report_restart_broadcast_failed').length, 2);

        const firstState = service.getRestartBroadcastState();
        assert.equal(firstState.batchId, 'restart_test_batch');
        assert.equal(firstState.states.length, 1);
        assert.equal(firstState.states[0].attempts, 1);
        assert.equal(firstState.states[0].delivered, false);
        assert.equal(firstState.states[0].failed, false);
        assert.ok(firstState.states[0].nextRetryAt > 0);
        assert.deepEqual(scheduler.getTimeoutNames(), [firstState.states[0].taskName]);
        assert.equal(scheduler.getDelay(firstState.states[0].taskName), 1000);

        await wait(1100);
        await scheduler.runTimeout(firstState.states[0].taskName);

        assert.equal(deliveries.length, 2);
        assert.equal(accountLogs.filter(item => item.event === 'report_restart_broadcast').length, 2);

        const finalState = service.getRestartBroadcastState();
        assert.equal(finalState.states[0].attempts, 2);
        assert.equal(finalState.states[0].delivered, true);
        assert.equal(finalState.states[0].failed, false);
        assert.equal(finalState.states[0].nextRetryAt, 0);

        await service.sendRestartBroadcast();
        assert.equal(deliveries.length, 2);
    } finally {
        delete require.cache[reportServiceModulePath];
        restoreDatabase();
        restoreLogger();
    }
});
