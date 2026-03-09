const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const storeModulePath = require.resolve('../src/models/store');
const runtimePathsModulePath = require.resolve('../src/config/runtime-paths');
const mysqlDbModulePath = require.resolve('../src/services/mysql-db');

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

function createRuntimePathsMock(rootDir) {
    const dataDir = path.join(rootDir, 'data');
    return {
        getDataFile(filename) {
            return path.join(dataDir, filename);
        },
        ensureDataDir() {
            fs.mkdirSync(dataDir, { recursive: true });
            return dataDir;
        },
    };
}

function createMysqlMock(dbRows = []) {
    return {
        isMysqlInitialized() {
            return false;
        },
        getPool() {
            return {
                async query(sql) {
                    if (String(sql).includes('SELECT * FROM account_configs')) {
                        return [dbRows];
                    }
                    return [[]];
                },
            };
        },
        async transaction(handler) {
            return await handler({
                async query() {
                    return [[]];
                },
            });
        },
    };
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('trial card config persists to store.json and reloads without falling back to defaults', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'store-trial-config-'));
    const dataDir = path.join(tempRoot, 'data');
    const storeFile = path.join(dataDir, 'store.json');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify({ accountConfigs: {}, defaultAccountConfig: {} }, null, 2), 'utf8');

    const restoreRuntimePaths = mockModule(runtimePathsModulePath, createRuntimePathsMock(tempRoot));
    const restoreMysql = mockModule(mysqlDbModulePath, createMysqlMock());

    try {
        delete require.cache[storeModulePath];
        let store = require(storeModulePath);

        store.setTrialCardConfig({
            enabled: false,
            days: 7,
            dailyLimit: 9,
            cooldownMs: 2 * 60 * 60 * 1000,
            adminRenewEnabled: false,
            userRenewEnabled: true,
            maxAccounts: 3,
        });

        await wait(3200);

        const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
        assert.deepEqual(saved.trialCardConfig, {
            enabled: false,
            dailyLimit: 9,
            cooldownMs: 2 * 60 * 60 * 1000,
            days: 7,
            maxAccounts: 3,
            adminRenewEnabled: false,
            userRenewEnabled: true,
        });

        delete require.cache[storeModulePath];
        store = require(storeModulePath);
        await wait(50);

        assert.deepEqual(store.getTrialCardConfig(), {
            enabled: false,
            dailyLimit: 9,
            cooldownMs: 2 * 60 * 60 * 1000,
            days: 7,
            maxAccounts: 3,
            adminRenewEnabled: false,
            userRenewEnabled: true,
        });
    } finally {
        delete require.cache[storeModulePath];
        restoreRuntimePaths();
        restoreMysql();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
