#!/usr/bin/env node

/**
 * AI 服务守护进程
 * 自动启动并监控 OpenViking 和 AI 助手服务
 * 无感知、自动执行、故障自重启
 */

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { resolveAiProjectRoot } = require('../../core/src/services/ai-workspace');

const DEFAULT_PROJECT_ROOT = path.join(__dirname, '..', '..');
const PROJECT_ROOT = (() => {
  return resolveAiProjectRoot(process.env.AI_SERVICE_PROJECT_ROOT || '', {
    baseDir: DEFAULT_PROJECT_ROOT,
  });
})();
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const PID_FILE = path.join(LOG_DIR, 'ai-daemon.pid');

// 配置
const CONFIG = {
  openVikingPort: process.env.OPENVIKING_PORT || 5432,
  openVikingUrl: process.env.OPENVIKING_URL || 'http://localhost:5432',
  restartDelay: 3000, // 重启延迟 3 秒
  healthCheckInterval: 30000, // 健康检查间隔 30 秒
  maxRestarts: 5, // 最大重启次数
  healthCheckTimeout: 5000, // 健康检查超时 5 秒
  startupTimeout: 15000, // 启动超时 15 秒
};

// 进程状态
let processes = {
  openViking: null,
  restartCounts: {
    openViking: 0,
  },
};
let isShuttingDown = false;
let pendingRestartTimer = null;
let openVikingStartPromise = null;
const ignoredExitPids = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 日志函数
function log(message, type = 'INFO') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${type}] ${message}`;
  console.log(logMessage);

  // 写入日志文件
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  const logFile = path.join(LOG_DIR, 'ai-services.log');
  fs.appendFileSync(logFile, logMessage + '\n');
}

function writePidFile() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function cleanupPidFile() {
  try {
    if (!fs.existsSync(PID_FILE)) {
      return;
    }
    const currentPid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (currentPid === process.pid) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // Ignore pid file cleanup failures on exit.
  }
}

function markOpenVikingExitIgnored(childProcess) {
  if (!childProcess || !childProcess.pid) return;
  ignoredExitPids.add(childProcess.pid);
}

function clearPendingRestart() {
  if (!pendingRestartTimer) return;
  clearTimeout(pendingRestartTimer);
  pendingRestartTimer = null;
}

function scheduleOpenVikingRestart() {
  clearPendingRestart();
  pendingRestartTimer = setTimeout(() => {
    pendingRestartTimer = null;
    startOpenViking().catch((error) => {
      log(`[OpenViking] 自动重启失败：${error.message}`, 'ERROR');
    });
  }, CONFIG.restartDelay);
}

function isExternalOpenVikingHandle(handle) {
  return Boolean(handle && handle.external === true);
}

function adoptExistingOpenViking() {
  clearPendingRestart();
  processes.openViking = {
    external: true,
    pid: null,
  };
  processes.restartCounts.openViking = 0;
}

// 检查 OpenViking 服务健康状态
async function checkHealth() {
  try {
    const response = await fetch(`${CONFIG.openVikingUrl}/health`, {
      signal: AbortSignal.timeout(CONFIG.healthCheckTimeout),
    });
    if (!response.ok) {
      return false;
    }
    const data = await response.json();
    return data.status === 'healthy';
  } catch (error) {
    return false;
  }
}

function isPortListening(port, host = '127.0.0.1') {
  const normalizedPort = Number.parseInt(port, 10);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ port: normalizedPort, host });
    const finalize = (listening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };

    socket.setTimeout(500);
    socket.once('connect', () => finalize(true));
    socket.once('timeout', () => finalize(false));
    socket.once('error', () => finalize(false));
  });
}

async function waitForOpenVikingReady(pythonProcess) {
  const deadline = Date.now() + CONFIG.startupTimeout;
  while (Date.now() < deadline) {
    if (pythonProcess.exitCode !== null) {
      throw new Error(`OpenViking 启动失败，进程提前退出 (${pythonProcess.exitCode})`);
    }
    if (await checkHealth()) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function launchOpenVikingProcess(venvPython, openVikingDir) {
  const pythonProcess = spawn(
    venvPython,
    ['app.py'],
    {
      cwd: openVikingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    }
  );

  processes.openViking = pythonProcess;

  pythonProcess.stdout.on('data', (data) => {
    log(`[OpenViking] ${data.toString().trim()}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    log(`[OpenViking] ${data.toString().trim()}`, 'ERROR');
  });

  pythonProcess.on('error', (error) => {
    log(`[OpenViking] 进程错误：${error.message}`, 'ERROR');
  });

  pythonProcess.on('exit', (code) => {
    const ignoredExit = ignoredExitPids.delete(pythonProcess.pid);
    log(`[OpenViking] 进程退出，代码：${code}`, 'WARN');

    if (processes.openViking === pythonProcess) {
      processes.openViking = null;
    }

    if (ignoredExit || isShuttingDown) {
      log('[OpenViking] 当前退出属于受控关闭，跳过自动重启', 'INFO');
      return;
    }

    if (processes.restartCounts.openViking < CONFIG.maxRestarts) {
      processes.restartCounts.openViking++;
      log(`[OpenViking] 将在 ${CONFIG.restartDelay}ms 后重启 (第${processes.restartCounts.openViking}次尝试)`, 'WARN');
      scheduleOpenVikingRestart();
      return;
    }

    log('[OpenViking] 达到最大重启次数，停止重启', 'ERROR');
  });

  let ready = false;
  try {
    ready = await waitForOpenVikingReady(pythonProcess);
  } catch (error) {
    markOpenVikingExitIgnored(pythonProcess);
    if (pythonProcess.pid && pythonProcess.exitCode === null) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', pythonProcess.pid, '/f', '/t']);
      } else {
        process.kill(pythonProcess.pid, 'SIGTERM');
      }
    }
    throw error;
  }

  if (!ready) {
    markOpenVikingExitIgnored(pythonProcess);
    if (pythonProcess.pid && pythonProcess.exitCode === null) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', pythonProcess.pid, '/f', '/t']);
      } else {
        process.kill(pythonProcess.pid, 'SIGTERM');
      }
    }
    throw new Error('OpenViking 启动超时');
  }

  clearPendingRestart();
  log('[OpenViking] 服务启动成功', 'SUCCESS');
  processes.restartCounts.openViking = 0;
}

// 启动 OpenViking 服务
function startOpenViking() {
  if (openVikingStartPromise) {
    return openVikingStartPromise;
  }

  openVikingStartPromise = (async () => {
    if (await checkHealth()) {
      if (!isExternalOpenVikingHandle(processes.openViking)) {
        log('[OpenViking] 检测到端口上已有健康实例，守护进程改为接管现有服务', 'WARN');
      }
      adoptExistingOpenViking();
      return;
    }

    if (await isPortListening(CONFIG.openVikingPort)) {
      throw new Error(`OpenViking 端口 ${CONFIG.openVikingPort} 已被占用，但健康检查未通过，请先释放端口`);
    }

    if (isExternalOpenVikingHandle(processes.openViking)) {
      processes.openViking = null;
    }

    const openVikingDir = path.join(PROJECT_ROOT, 'services', 'openviking');
    if (!fs.existsSync(openVikingDir)) {
      throw new Error(`OpenViking 目录不存在: ${openVikingDir}`);
    }

    const venvPython = process.platform === 'win32'
      ? path.join(openVikingDir, 'venv', 'Scripts', 'python.exe')
      : path.join(openVikingDir, 'venv', 'bin', 'python');

    if (!fs.existsSync(venvPython)) {
      log('Python 虚拟环境不存在，正在创建...', 'WARN');
      await createVenv(openVikingDir);
      await installDependencies(openVikingDir);
    }

    await launchOpenVikingProcess(venvPython, openVikingDir);
  })().finally(() => {
    openVikingStartPromise = null;
  });

  return openVikingStartPromise;
}

// 创建虚拟环境
async function createVenv(dir) {
  return new Promise((resolve, reject) => {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const venvProcess = spawn(pythonCmd, ['-m', 'venv', 'venv'], {
      cwd: dir,
      stdio: 'inherit',
    });

    venvProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`创建虚拟环境失败，退出码：${code}`));
      }
    });
  });
}

// 安装依赖
async function installDependencies(dir) {
  return new Promise((resolve, reject) => {
    const pipCmd = process.platform === 'win32'
      ? path.join(dir, 'venv', 'Scripts', 'pip.exe')
      : path.join(dir, 'venv', 'bin', 'pip');

    const pipProcess = spawn(pipCmd, ['install', '-r', 'requirements.txt'], {
      cwd: dir,
      stdio: 'inherit',
    });

    pipProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`安装依赖失败，退出码：${code}`));
      }
    });
  });
}

// 定期健康检查
function startHealthCheck() {
  setInterval(async () => {
    try {
      if (!processes.openViking) {
        log('[健康检查] OpenViking 进程不存在，尝试重启...', 'WARN');
        processes.restartCounts.openViking = 0; // 重置计数
        await startOpenViking();
        return;
      }

      const healthy = await checkHealth();
      if (isExternalOpenVikingHandle(processes.openViking)) {
        if (healthy) {
          return;
        }
        log('[健康检查] 已接管的 OpenViking 外部实例失联，尝试重新拉起守护实例...', 'WARN');
        processes.openViking = null;
        processes.restartCounts.openViking = 0;
        await startOpenViking();
        return;
      }

      if (!healthy) {
        log('[健康检查] OpenViking 服务不健康，尝试重启...', 'WARN');

        // 杀死进程
        if (processes.openViking.pid) {
          markOpenVikingExitIgnored(processes.openViking);
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', processes.openViking.pid, '/f', '/t']);
          } else {
            process.kill(processes.openViking.pid, 'SIGKILL');
          }
        }

        // 重启
        processes.restartCounts.openViking = 0; // 重置计数
        await startOpenViking();
      }
    } catch (error) {
      log(`[健康检查] 执行失败：${error.message}`, 'ERROR');
    }
  }, CONFIG.healthCheckInterval);

  log(`[健康检查] 已启动，间隔：${CONFIG.healthCheckInterval / 1000}秒`);
}

// 优雅关闭
function gracefulShutdown(signal) {
  isShuttingDown = true;
  clearPendingRestart();
  log(`[守护进程] 收到信号：${signal}，正在关闭服务...`);

  const shutdown = () => {
    if (isExternalOpenVikingHandle(processes.openViking)) {
      log('[守护进程] 当前 OpenViking 为外部实例，守护进程退出时不主动关闭', 'INFO');
      processes.openViking = null;
    }

    if (processes.openViking) {
      log('[守护进程] 关闭 OpenViking 服务...');
      const childProcess = processes.openViking;
      markOpenVikingExitIgnored(childProcess);

      // 调用 shutdown 接口
      fetch(`${CONFIG.openVikingUrl}/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(CONFIG.healthCheckTimeout),
      })
        .catch(() => { }) // 忽略错误
        .finally(() => {
          if (!childProcess || !childProcess.pid) return;
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', childProcess.pid, '/f', '/t']);
          } else {
            process.kill(childProcess.pid, 'SIGTERM');
          }
        });
    }

    setTimeout(() => {
      log('[守护进程] 已关闭所有服务');
      process.exit(0);
    }, 2000);
  };

  shutdown();
}

// 主函数
async function main() {
  writePidFile();
  log('[守护进程] AI 服务守护进程启动', 'SUCCESS');
  log('[守护进程] 配置:', 'INFO');
  log(`  - OpenViking 端口：${CONFIG.openVikingPort}`);
  log(`  - 健康检查间隔：${CONFIG.healthCheckInterval / 1000}秒`);
  log(`  - 最大重启次数：${CONFIG.maxRestarts}`);

  // 启动 OpenViking 服务
  try {
    await startOpenViking();
    log('[守护进程] OpenViking 服务已就绪', 'SUCCESS');
  } catch (error) {
    log(`[守护进程] 启动 OpenViking 失败：${error.message}`, 'ERROR');
    process.exit(1);
  }

  // 启动健康检查
  startHealthCheck();

  // 监听关闭信号
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  if (process.platform === 'win32') {
    process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
  }
}

// 运行
process.on('exit', cleanupPidFile);

main().catch((error) => {
  log(`[守护进程] 启动失败：${error.message}`, 'ERROR');
  process.exit(1);
});
