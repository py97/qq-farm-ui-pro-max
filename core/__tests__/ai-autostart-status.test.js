const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const {
    determineRuntimeMode,
    formatDoctorReport,
    getRuntimeStatus,
} = require('../../scripts/service/ai-autostart');

test('getRuntimeStatus reports external healthy OpenViking without daemon pid', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-autostart-status-'));
    const originalAllowed = process.env.AI_SERVICE_ALLOWED_CWDS;
    const originalPort = process.env.OPENVIKING_PORT;
    const originalUrl = process.env.OPENVIKING_URL;
    const originalFetch = global.fetch;
    const originalCreateConnection = net.createConnection;
    const port = 5432;

    process.env.AI_SERVICE_ALLOWED_CWDS = tempDir;
    process.env.OPENVIKING_PORT = String(port);
    process.env.OPENVIKING_URL = `http://127.0.0.1:${port}`;
    net.createConnection = () => {
        const socket = new EventEmitter();
        socket.setTimeout = () => {};
        socket.destroy = () => {};
        process.nextTick(() => socket.emit('connect'));
        return socket;
    };
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            status: 'healthy',
            workspace: './openviking_data',
        }),
    });

    try {
        const status = await getRuntimeStatus({ cwd: tempDir });
        assert.equal(status.daemonRunning, false);
        assert.equal(status.openViking.running, true);
        assert.equal(status.openViking.healthy, true);
        assert.equal(status.openViking.portListening, true);
        assert.equal(status.mode.id, 'external');
        assert.equal(status.mode.label, '外部实例模式');
        assert.equal(status.openViking.workspace, './openviking_data');
        assert.equal(status.projectRoot, fs.realpathSync(tempDir));
    } finally {
        net.createConnection = originalCreateConnection;
        global.fetch = originalFetch;
        process.env.AI_SERVICE_ALLOWED_CWDS = originalAllowed;
        process.env.OPENVIKING_PORT = originalPort;
        process.env.OPENVIKING_URL = originalUrl;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('getRuntimeStatus detects daemon pid file when process is alive', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-autostart-daemon-'));
    const logsDir = path.join(tempDir, 'logs');
    const pidFile = path.join(logsDir, 'ai-daemon.pid');
    const originalAllowed = process.env.AI_SERVICE_ALLOWED_CWDS;
    const originalPort = process.env.OPENVIKING_PORT;
    const originalFetch = global.fetch;
    const originalCreateConnection = net.createConnection;

    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));

    process.env.AI_SERVICE_ALLOWED_CWDS = tempDir;
    process.env.OPENVIKING_PORT = '65534';
    net.createConnection = () => {
        const socket = new EventEmitter();
        socket.setTimeout = () => {};
        socket.destroy = () => {};
        process.nextTick(() => socket.emit('error', new Error('ECONNREFUSED')));
        return socket;
    };
    global.fetch = async () => ({
        ok: false,
        json: async () => ({}),
    });

    try {
        const status = await getRuntimeStatus({ cwd: tempDir });
        assert.equal(status.daemonRunning, true);
        assert.equal(status.openViking.running, false);
        assert.equal(status.openViking.healthy, false);
        assert.equal(status.openViking.portListening, false);
        assert.equal(status.mode.id, 'managed_starting');
    } finally {
        net.createConnection = originalCreateConnection;
        global.fetch = originalFetch;
        process.env.AI_SERVICE_ALLOWED_CWDS = originalAllowed;
        process.env.OPENVIKING_PORT = originalPort;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('determineRuntimeMode classifies managed and conflict states', () => {
    assert.deepEqual(
        determineRuntimeMode({
            daemonRunning: true,
            openViking: {
                healthy: true,
                portListening: true,
            },
        }),
        {
            id: 'managed',
            label: '守护模式',
            detail: '守护进程正在管理 OpenViking，服务健康',
        },
    );

    assert.deepEqual(
        determineRuntimeMode({
            daemonRunning: false,
            openViking: {
                healthy: false,
                portListening: true,
            },
        }),
        {
            id: 'conflict',
            label: '残留实例/端口冲突',
            detail: '端口已被占用，但健康检查未通过',
        },
    );
});

test('formatDoctorReport highlights stale pid files and occupied ports', () => {
    const report = formatDoctorReport({
        projectRoot: '/tmp/project',
        ports: {
            openVikingPort: 5432,
            agfsPort: 8080,
        },
        pidFile: {
            file: '/tmp/project/logs/ai-daemon.pid',
            exists: true,
            pid: 12345,
            running: false,
            stale: true,
        },
        runtimeStatus: {
            daemonRunning: false,
            openViking: {
                healthy: false,
                portListening: true,
                workspace: '',
                url: 'http://127.0.0.1:5432',
            },
        },
        openVikingListeners: {
            available: true,
            lines: ['Python 73429 user 16u IPv4 TCP *:5432 (LISTEN)'],
            error: '',
        },
        agfsListening: true,
        agfsListeners: {
            available: true,
            lines: ['Python 73429 user 18u IPv4 TCP *:8080 (LISTEN)'],
            error: '',
        },
        recentServiceLogs: ['service-line'],
        recentAutostartLogs: ['autostart-line'],
    });

    assert.match(report, /运行模式: 残留实例\/端口冲突 \(conflict\)/);
    assert.match(report, /当前模式说明: 端口已被占用，但健康检查未通过/);
    assert.match(report, /stale PID 文件/);
    assert.match(report, /端口 5432 已被占用但健康检查失败/);
    assert.match(report, /AGFS 端口 8080 仍被占用/);
    assert.match(report, /Python 73429 user 16u IPv4 TCP \*:5432 \(LISTEN\)/);
    assert.match(report, /service-line/);
});
