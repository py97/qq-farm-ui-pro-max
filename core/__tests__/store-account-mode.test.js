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
                    if (String(sql).includes('SELECT * FROM accounts')) {
                        return [[]];
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

test('ensureMainAccountUnique only downgrades same-owner accounts in the same zone', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'store-account-mode-'));
    const dataDir = path.join(tempRoot, 'data');
    const storeFile = path.join(dataDir, 'store.json');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify({ accountConfigs: {}, defaultAccountConfig: {}, accounts: [] }, null, 2), 'utf8');

    const restoreRuntimePaths = mockModule(runtimePathsModulePath, createRuntimePathsMock(tempRoot));
    const restoreMysql = mockModule(mysqlDbModulePath, createMysqlMock());

    try {
        delete require.cache[storeModulePath];
        const store = require(storeModulePath);

        store.addOrUpdateAccount({ name: 'QQ主号A', platform: 'qq', uin: '10001', username: 'admin' });
        store.addOrUpdateAccount({ name: 'QQ主号B', platform: 'qq', uin: '10002', username: 'admin' });
        store.addOrUpdateAccount({ name: '微信主号', platform: 'wx_car', uin: 'wx-10003', username: 'admin' });

        const accounts = store.getAccounts().accounts;
        const qqA = accounts.find(item => String(item.uin) === '10001');
        const qqB = accounts.find(item => String(item.uin) === '10002');
        const wechat = accounts.find(item => String(item.uin) === 'wx-10003');

        assert.ok(qqA);
        assert.ok(qqB);
        assert.ok(wechat);

        store.applyAccountMode(qqA.id, 'main');
        store.applyAccountMode(qqB.id, 'main');
        store.applyAccountMode(wechat.id, 'main');

        const downgraded = await store.ensureMainAccountUnique(qqA.id, 'admin');

        assert.equal(store.getConfigSnapshot(qqA.id).accountMode, 'main');
        assert.equal(store.getConfigSnapshot(qqB.id).accountMode, 'alt');
        assert.equal(store.getConfigSnapshot(wechat.id).accountMode, 'main');
        assert.deepEqual(
            downgraded.map(item => item.id),
            [String(qqB.id)],
        );

        await wait(3200);
    } finally {
        delete require.cache[storeModulePath];
        restoreRuntimePaths();
        restoreMysql();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
