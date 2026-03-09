#!/usr/bin/env node

/**
 * AI 服务自动启动器
 * 集成到项目启动流程，无感知自动启动 AI 服务
 */

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { resolveAiProjectRoot } = require('../../core/src/services/ai-workspace');

const DEFAULT_PROJECT_ROOT = path.join(__dirname, '..', '..');
const AI_DAEMON_SCRIPT = path.join(__dirname, 'ai-services-daemon.js');

function resolveProjectRoot(input) {
  return resolveAiProjectRoot(input || process.env.AI_SERVICE_PROJECT_ROOT || '', {
    baseDir: DEFAULT_PROJECT_ROOT,
  });
}

function getRuntimePaths(options = {}) {
  const projectRoot = resolveProjectRoot(options.cwd || options.projectRoot);
  const logDir = path.join(projectRoot, 'logs');
  return {
    projectRoot,
    logDir,
    logFile: path.join(logDir, 'ai-autostart.log'),
    pidFile: path.join(logDir, 'ai-daemon.pid'),
  };
}

function parseCliOptions(argv = []) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i] || '');
    if (token === '--cwd' || token === '--project-root') {
      options.cwd = argv[i + 1] || '';
      i++;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      options.cwd = token.slice('--cwd='.length);
      continue;
    }
    if (token.startsWith('--project-root=')) {
      options.cwd = token.slice('--project-root='.length);
    }
  }
  return options;
}

function ensureLogDir(paths) {
  if (!fs.existsSync(paths.logDir)) {
    fs.mkdirSync(paths.logDir, { recursive: true });
  }
}

function log(message, options = {}) {
  const paths = getRuntimePaths(options);
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);

  ensureLogDir(paths);
  fs.appendFileSync(paths.logFile, logMessage + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getOpenVikingUrl() {
  return process.env.OPENVIKING_URL
    || `http://127.0.0.1:${process.env.OPENVIKING_PORT || '5432'}`;
}

function getManagedPorts() {
  return {
    openVikingPort: Number.parseInt(process.env.OPENVIKING_PORT || '5432', 10),
    agfsPort: Number.parseInt(process.env.OPENVIKING_AGFS_PORT || '8080', 10),
  };
}

function isPidRunning(pid) {
  const normalizedPid = Number.parseInt(pid, 10);
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 10000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 10000);
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await sleep(200);
  }
  return !isPidRunning(pid);
}

function isPortListening(port, host = '127.0.0.1') {
  const normalizedPort = Number.parseInt(port, 10);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ port: normalizedPort, host });
    const finalize = (isListening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(isListening);
    };

    socket.setTimeout(500);
    socket.once('connect', () => finalize(true));
    socket.once('timeout', () => finalize(false));
    socket.once('error', () => finalize(false));
  });
}

async function waitForPortRelease(port, timeoutMs = 10000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 10000);
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) {
      return true;
    }
    await sleep(200);
  }
  return !(await isPortListening(port));
}

async function waitForManagedPortsRelease(options = {}) {
  const ports = Object.values(getManagedPorts()).filter(port => Number.isFinite(port) && port > 0);

  for (const port of ports) {
    const released = await waitForPortRelease(port, options.timeoutMs || 12000);
    if (!released) {
      log(`[AI 服务] 端口 ${port} 仍未释放，后续启动可能继续冲突`, options.context || {});
    }
  }
}

async function getOpenVikingStatus() {
  const url = getOpenVikingUrl();
  const { openVikingPort: port } = getManagedPorts();
  const portListening = await isPortListening(port);
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return {
        running: false,
        healthy: false,
        portListening,
        url,
        workspace: '',
      };
    }
    const data = await response.json();
    return {
      running: true,
      healthy: data.status === 'healthy',
      portListening,
      url,
      workspace: data.workspace || '',
    };
  } catch {
    return {
      running: false,
      healthy: false,
      portListening,
      url,
      workspace: '',
    };
  }
}

function createRuntimeMode(id, label, detail) {
  return { id, label, detail };
}

function determineRuntimeMode(runtimeStatus, options = {}) {
  const daemonRunning = Boolean(runtimeStatus && runtimeStatus.daemonRunning);
  const openViking = runtimeStatus && runtimeStatus.openViking || {};
  const listenerDetected = Boolean(options.listenerDetected || openViking.listenerDetected);
  const healthy = Boolean(openViking.healthy);
  const portOccupied = Boolean(openViking.portListening || listenerDetected);

  if (daemonRunning && healthy) {
    return createRuntimeMode('managed', '守护模式', '守护进程正在管理 OpenViking，服务健康');
  }

  if (daemonRunning && portOccupied) {
    return createRuntimeMode('managed_conflict', '守护模式异常', '守护进程仍在运行，但端口占用或健康检查失败');
  }

  if (daemonRunning) {
    return createRuntimeMode('managed_starting', '守护模式启动中', '守护进程正在运行，等待 OpenViking 就绪');
  }

  if (!daemonRunning && healthy) {
    return createRuntimeMode('external', '外部实例模式', 'OpenViking 正在外部运行，当前未由守护进程管理');
  }

  if (portOccupied) {
    return createRuntimeMode('conflict', '残留实例/端口冲突', '端口已被占用，但健康检查未通过');
  }

  return createRuntimeMode('offline', '未运行', '守护进程和 OpenViking 当前都未运行');
}

function getPidFileStatus(options = {}) {
  const paths = getRuntimePaths(options);
  const status = {
    file: paths.pidFile,
    exists: false,
    pid: null,
    running: false,
    stale: false,
  };

  if (!fs.existsSync(paths.pidFile)) {
    return status;
  }

  status.exists = true;
  status.pid = Number.parseInt(fs.readFileSync(paths.pidFile, 'utf8'), 10);
  status.running = isPidRunning(status.pid);
  status.stale = !status.running;
  return status;
}

function inspectListeningProcess(port) {
  if (process.platform === 'win32') {
    return {
      available: false,
      lines: [],
      error: '当前平台未启用 lsof 检查',
    };
  }

  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });

  if (result.error) {
    return {
      available: false,
      lines: [],
      error: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      available: true,
      lines: [],
      error: '',
    };
  }

  const lines = String(result.stdout || '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(1);

  return {
    available: true,
    lines,
    error: '',
  };
}

function readRecentLogLines(logFile, limit = 12) {
  if (!fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs.readFileSync(logFile, 'utf8')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean);

  return lines.slice(-Math.max(1, Number(limit) || 12));
}

async function getRuntimeStatus(options = {}) {
  const ports = getManagedPorts();
  const listenerInspection = inspectListeningProcess(ports.openVikingPort);
  const runtimeStatus = {
    daemonRunning: isDaemonRunning(options),
    openViking: await getOpenVikingStatus(),
    projectRoot: getRuntimePaths(options).projectRoot,
  };
  runtimeStatus.openViking.listenerDetected = listenerInspection.lines.length > 0;
  runtimeStatus.mode = determineRuntimeMode(runtimeStatus, {
    listenerDetected: runtimeStatus.openViking.listenerDetected,
  });
  return runtimeStatus;
}

async function collectDoctorSnapshot(options = {}) {
  const paths = getRuntimePaths(options);
  const ports = getManagedPorts();
  const pidFile = getPidFileStatus(options);
  const runtimeStatus = await getRuntimeStatus(options);
  const agfsListening = await isPortListening(ports.agfsPort);

  return {
    projectRoot: paths.projectRoot,
    ports,
    pidFile,
    runtimeStatus,
    openVikingListeners: inspectListeningProcess(ports.openVikingPort),
    agfsListening,
    agfsListeners: inspectListeningProcess(ports.agfsPort),
    recentServiceLogs: readRecentLogLines(path.join(paths.logDir, 'ai-services.log')),
    recentAutostartLogs: readRecentLogLines(paths.logFile),
  };
}

function formatDoctorReport(snapshot) {
  const lines = [];
  const { runtimeStatus, pidFile, ports } = snapshot;
  const openVikingListenerDetected = runtimeStatus.openViking.portListening || snapshot.openVikingListeners.lines.length > 0;
  const agfsListenerDetected = snapshot.agfsListening || snapshot.agfsListeners.lines.length > 0;
  const resolvedMode = determineRuntimeMode(runtimeStatus, {
    listenerDetected: openVikingListenerDetected,
  });
  let openVikingSummary = '未监听';
  if (runtimeStatus.openViking.healthy) {
    openVikingSummary = '健康';
  } else if (runtimeStatus.openViking.portListening) {
    openVikingSummary = '端口占用但健康失败';
  } else if (snapshot.openVikingListeners.lines.length > 0) {
    openVikingSummary = '本机检测到监听，但当前探针无法连通';
  }

  let agfsSummary = '未监听';
  if (snapshot.agfsListening) {
    agfsSummary = '端口监听中';
  } else if (snapshot.agfsListeners.lines.length > 0) {
    agfsSummary = '本机检测到监听，但当前探针无法连通';
  }

  lines.push('AI 服务诊断报告');
  lines.push(`项目目录: ${snapshot.projectRoot}`);
  lines.push(`运行模式: ${resolvedMode.label} (${resolvedMode.id})`);
  lines.push(`守护进程: ${runtimeStatus.daemonRunning ? '运行中' : '未运行'}`);
  lines.push(`OpenViking (${ports.openVikingPort}): ${openVikingSummary}`);
  lines.push(`AGFS (${ports.agfsPort}): ${agfsSummary}`);

  if (pidFile.exists) {
    lines.push(`PID 文件: ${pidFile.file} -> ${pidFile.pid}${pidFile.stale ? ' (stale)' : ''}`);
  } else {
    lines.push(`PID 文件: ${pidFile.file} (不存在)`);
  }

  if (runtimeStatus.openViking.workspace) {
    lines.push(`OpenViking 工作目录: ${runtimeStatus.openViking.workspace}`);
  }

  lines.push('');
  lines.push('监听进程');
  if (snapshot.openVikingListeners.available) {
    if (snapshot.openVikingListeners.lines.length > 0) {
      lines.push(`- ${ports.openVikingPort}:`);
      snapshot.openVikingListeners.lines.forEach((line) => lines.push(`  ${line}`));
    } else {
      lines.push(`- ${ports.openVikingPort}: 无监听进程`);
    }
  } else {
    lines.push(`- ${ports.openVikingPort}: 无法获取 (${snapshot.openVikingListeners.error})`);
  }

  if (snapshot.agfsListeners.available) {
    if (snapshot.agfsListeners.lines.length > 0) {
      lines.push(`- ${ports.agfsPort}:`);
      snapshot.agfsListeners.lines.forEach((line) => lines.push(`  ${line}`));
    } else {
      lines.push(`- ${ports.agfsPort}: 无监听进程`);
    }
  } else {
    lines.push(`- ${ports.agfsPort}: 无法获取 (${snapshot.agfsListeners.error})`);
  }

  const suggestions = [];
  if (pidFile.stale) {
    suggestions.push(`发现 stale PID 文件: ${pidFile.file}`);
  }
  if (!runtimeStatus.daemonRunning && runtimeStatus.openViking.healthy) {
    suggestions.push('守护未运行，但 OpenViking 已在外部运行；若要重新切回守护管理，请先确认是否需要保留当前实例');
  }
  if (runtimeStatus.openViking.portListening && !runtimeStatus.openViking.healthy) {
    suggestions.push(`OpenViking 端口 ${ports.openVikingPort} 已被占用但健康检查失败，优先处理残留监听进程`);
  }
  if (!runtimeStatus.openViking.portListening && snapshot.openVikingListeners.lines.length > 0) {
    suggestions.push(`当前探针无法直连 ${ports.openVikingPort}，但 lsof 已发现监听进程；优先以本机监听结果为准`);
  }
  if (agfsListenerDetected) {
    suggestions.push(`AGFS 端口 ${ports.agfsPort} 仍被占用；如果 OpenViking 启动日志出现 AGFS port is already in use，需要先清理它`);
  }
  if (openVikingListenerDetected || agfsListenerDetected) {
    suggestions.push(`可先执行: lsof -nP -iTCP:${ports.openVikingPort} -sTCP:LISTEN 和 lsof -nP -iTCP:${ports.agfsPort} -sTCP:LISTEN`);
  }
  if (suggestions.length === 0) {
    suggestions.push('未发现明显异常');
  }

  lines.push('');
  lines.push('建议');
  lines.push(`- 当前模式说明: ${resolvedMode.detail}`);
  suggestions.forEach((item) => lines.push(`- ${item}`));

  const recentLogs = [
    ...snapshot.recentServiceLogs.slice(-6),
    ...snapshot.recentAutostartLogs.slice(-4),
  ].slice(-10);

  if (recentLogs.length > 0) {
    lines.push('');
    lines.push('最近日志');
    recentLogs.forEach((line) => lines.push(line));
  }

  return lines.join('\n');
}

// 检查是否已启动
function isDaemonRunning(options = {}) {
  const paths = getRuntimePaths(options);
  if (!fs.existsSync(paths.pidFile)) {
    return false;
  }

  const pid = parseInt(fs.readFileSync(paths.pidFile, 'utf8'));
  try {
    // 检查进程是否存在
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 进程不存在，删除 PID 文件
    fs.unlinkSync(paths.pidFile);
    return false;
  }
}

// 启动守护进程
function startDaemon(options = {}) {
  return new Promise((resolve, reject) => {
    const paths = getRuntimePaths(options);

    if (isDaemonRunning(options)) {
      log(`[AI 服务] 守护进程已在运行，无需重复启动 (目录: ${paths.projectRoot})`, options);
      resolve();
      return;
    }

    log(`[AI 服务] 正在启动 AI 服务守护进程 (目录: ${paths.projectRoot})...`, options);

    const nodeProcess = spawn(process.execPath, [AI_DAEMON_SCRIPT], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      cwd: paths.projectRoot,
      env: {
        ...process.env,
        AI_SERVICE_PROJECT_ROOT: paths.projectRoot,
      },
    });

    // 保存 PID
    ensureLogDir(paths);
    fs.writeFileSync(paths.pidFile, nodeProcess.pid.toString());

    log(`[AI 服务] 守护进程已启动 (PID: ${nodeProcess.pid})`, options);

    nodeProcess.unref(); // 让父进程可以独立退出

    // 等待一下确保启动成功
    setTimeout(() => {
      resolve();
    }, 2000);
  });
}

// 停止守护进程
async function stopDaemon(options = {}, stopOptions = {}) {
  const paths = getRuntimePaths(options);
  if (!fs.existsSync(paths.pidFile)) {
    log('[AI 服务] 守护进程未运行', options);
    return false;
  }

  const pid = parseInt(fs.readFileSync(paths.pidFile, 'utf8'));
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', pid, '/f', '/t']);
    } else {
      process.kill(pid, 'SIGTERM');
    }

    const waitForExitEnabled = stopOptions.waitForExit !== false;
    const exited = waitForExitEnabled
      ? await waitForProcessExit(pid, stopOptions.timeoutMs || 10000)
      : true;

    if (fs.existsSync(paths.pidFile) && !isPidRunning(pid)) {
      fs.unlinkSync(paths.pidFile);
    }

    if (exited) {
      log('[AI 服务] 守护进程已停止', options);
    } else {
      log('[AI 服务] 停止指令已发送，进程仍在退出中', options);
    }
    return exited;
  } catch (error) {
    log(`[AI 服务] 停止守护进程失败：${error.message}`, options);
    return false;
  }
}

// 主函数
async function main() {
  const action = process.argv[2];
  const options = parseCliOptions(process.argv.slice(3));
  
  switch (action) {
    case 'start':
      await startDaemon(options);
      break;
      
    case 'stop':
      await stopDaemon(options);
      break;
      
    case 'restart':
      await stopDaemon(options, { waitForExit: true, timeoutMs: 12000 });
      await waitForManagedPortsRelease({ timeoutMs: 12000, context: options });
      await startDaemon(options);
      break;
      
    case 'status':
      {
        const runtimeStatus = await getRuntimeStatus(options);
        if (runtimeStatus.daemonRunning) {
          if (runtimeStatus.openViking.healthy) {
            console.log(`✅ ${runtimeStatus.mode.label} (${runtimeStatus.projectRoot})，OpenViking 健康：${runtimeStatus.openViking.url}`);
          } else if (runtimeStatus.openViking.portListening) {
            console.log(`⚠️ ${runtimeStatus.mode.label} (${runtimeStatus.projectRoot})，但 OpenViking 端口已被占用且健康检查失败：${runtimeStatus.openViking.url}`);
          } else {
            console.log(`⚠️ ${runtimeStatus.mode.label} (${runtimeStatus.projectRoot})，OpenViking 尚未就绪：${runtimeStatus.openViking.url}`);
          }
        } else if (runtimeStatus.openViking.healthy) {
          console.log(`⚠️ ${runtimeStatus.mode.label} (${runtimeStatus.projectRoot})，OpenViking 已在外部运行：${runtimeStatus.openViking.url}`);
        } else if (runtimeStatus.openViking.portListening) {
          console.log(`⚠️ ${runtimeStatus.mode.label} (${runtimeStatus.projectRoot})，OpenViking 端口已被占用但健康检查失败：${runtimeStatus.openViking.url}`);
        } else {
          console.log(`❌ ${runtimeStatus.mode.label} (${runtimeStatus.projectRoot})`);
        }
        break;
      }

    case 'doctor':
      {
        const snapshot = await collectDoctorSnapshot(options);
        console.log(formatDoctorReport(snapshot));
        break;
      }
      
    default:
      // 默认启动
      await startDaemon(options);
  }
}

// 导出函数供其他模块调用
module.exports = {
  collectDoctorSnapshot,
  determineRuntimeMode,
  formatDoctorReport,
  getOpenVikingStatus,
  inspectListeningProcess,
  getRuntimeStatus,
  getPidFileStatus,
  start: startDaemon,
  stop: stopDaemon,
  isRunning: isDaemonRunning,
};

// 如果是直接运行则执行 main
if (require.main === module) {
  main().catch((error) => {
    log(`[AI 服务] 错误：${error.message}`);
    process.exit(1);
  });
}
