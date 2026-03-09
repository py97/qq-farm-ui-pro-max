/**
 * AI 服务状态监控和日志系统
 * 提供 HTTP 接口查看服务状态和日志
 */

const express = require('express');
const fs = require('fs');
const net = require('net');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const { determineRuntimeMode, inspectListeningProcess } = require('../../../scripts/service/ai-autostart');
const {
  describeAllowedAiProjectRoots,
  isAiWorkspaceError,
  resolveAiProjectRoot,
} = require('../services/ai-workspace');

const router = express.Router();
const PROJECT_ROOT = path.join(__dirname, '../../..');
const AI_AUTOSTART_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'service', 'ai-autostart.js');

const CONFIG = {
  openVikingUrl: process.env.OPENVIKING_URL || 'http://localhost:5432',
  aiAutostartScript: AI_AUTOSTART_SCRIPT,
  maxLogLines: 1000,
};

function resolveRequestedCwd(rawInput) {
  return resolveAiProjectRoot(rawInput, { baseDir: PROJECT_ROOT });
}

function logRejectedWorkspace(rawInput, error) {
  console.warn(`[AI 状态] 已拒绝目录请求: ${String(rawInput || '').trim() || '<default>'} -> ${error.message}`);
}

function respondAiStatusError(res, error, rawInput) {
  if (isAiWorkspaceError(error)) {
    logRejectedWorkspace(rawInput, error);
    res.status(400).json({
      success: false,
      error: error.message,
      code: error.code,
      requestedPath: error.requestedPath || '',
      allowedRoots: Array.isArray(error.allowedRoots)
        ? error.allowedRoots
        : describeAllowedAiProjectRoots({ baseDir: PROJECT_ROOT }).split(', '),
    });
    return true;
  }
  return false;
}

function runAiAutostart(action, res, requestedCwd) {
  const actionLabel = {
    start: '启动',
    stop: '停止',
    restart: '重启',
  }[action] || action;
  const cwd = resolveRequestedCwd(requestedCwd);
  execFile(process.execPath, [CONFIG.aiAutostartScript, action, '--cwd', cwd], {
    cwd,
  }, (error, stdout, stderr) => {
    if (error) {
      res.status(500).json({
        success: false,
        error: stderr || error.message,
      });
      return;
    }

    res.json({
      success: true,
      message: `AI 服务${actionLabel}指令已发送`,
      output: stdout,
      cwd,
    });
  });
}

function resolveLogDir(requestedCwd) {
  const cwd = resolveRequestedCwd(requestedCwd);
  return path.join(cwd, 'logs');
}

function getOpenVikingPort() {
  try {
    const parsed = new URL(CONFIG.openVikingUrl);
    return Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
  } catch {
    return 5432;
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

/**
 * 获取 AI 服务状态
 */
router.get('/status', async (req, res) => {
  try {
    const logDir = resolveLogDir(req.query?.cwd);
    const status = {
      daemon: {
        running: false,
        pid: null,
      },
      openViking: {
        running: false,
        healthy: false,
        portListening: false,
        url: CONFIG.openVikingUrl,
      },
      timestamp: new Date().toISOString(),
    };
    
    // 检查守护进程
    const pidFile = path.join(logDir, 'ai-daemon.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'));
      try {
        process.kill(pid, 0);
        status.daemon.running = true;
        status.daemon.pid = pid;
      } catch (error) {
        // 进程不存在
        fs.unlinkSync(pidFile);
      }
    }
    
    // 检查 OpenViking 服务
    status.openViking.portListening = await isPortListening(getOpenVikingPort());
    status.openViking.listenerDetected = inspectListeningProcess(getOpenVikingPort()).lines.length > 0;

    try {
      const response = await axios.get(`${CONFIG.openVikingUrl}/health`, {
        timeout: 5000,
      });
      status.openViking.running = true;
      status.openViking.healthy = response.data.status === 'healthy';
      status.openViking.workspace = response.data.workspace;
      status.openViking.detectedWithoutDaemon = !status.daemon.running;
    } catch (error) {
      status.openViking.running = false;
      status.openViking.healthy = false;
      status.openViking.detectedWithoutDaemon = false;
    }

    status.mode = determineRuntimeMode({
      daemonRunning: status.daemon.running,
      openViking: status.openViking,
    }, {
      listenerDetected: status.openViking.listenerDetected,
    });
    
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    if (!respondAiStatusError(res, error, req.query?.cwd)) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
});

/**
 * 获取服务日志
 */
router.get('/logs', (req, res) => {
  try {
    const { type = 'ai-services', lines = 100 } = req.query;
    const logFile = path.join(resolveLogDir(req.query?.cwd), `${type}.log`);
    
    if (!fs.existsSync(logFile)) {
      return res.json({
        success: true,
        data: {
          lines: [],
          message: '日志文件不存在',
        },
      });
    }
    
    const content = fs.readFileSync(logFile, 'utf8');
    const allLines = content.split('\n').filter(line => line.trim());
    const recentLines = allLines.slice(-Number.parseInt(lines));
    
    res.json({
      success: true,
      data: {
        lines: recentLines,
        total: allLines.length,
        file: logFile,
      },
    });
  } catch (error) {
    if (!respondAiStatusError(res, error, req.query?.cwd)) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
});

/**
 * 获取实时日志（WebSocket）
 */
router.get('/logs/stream', (req, res) => {
  // 这里可以实现 Server-Sent Events 或 WebSocket
  // 简单实现：返回最近的日志
  try {
    const { type = 'ai-services' } = req.query;
    const logFile = path.join(resolveLogDir(req.query?.cwd), `${type}.log`);

    if (!fs.existsSync(logFile)) {
      return res.send('日志文件不存在');
    }

    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').slice(-50);

    res.set('Content-Type', 'text/plain');
    res.send(lines.join('\n'));
  } catch (error) {
    if (!respondAiStatusError(res, error, req.query?.cwd)) {
      res.status(500).send(error.message);
    }
  }
});

/**
 * 重启 AI 服务
 */
router.post('/restart', async (req, res) => {
  try {
    runAiAutostart('restart', res, req.body?.cwd || req.query?.cwd);
  } catch (error) {
    if (!respondAiStatusError(res, error, req.body?.cwd || req.query?.cwd)) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
});

/**
 * 停止 AI 服务
 */
router.post('/stop', async (req, res) => {
  try {
    runAiAutostart('stop', res, req.body?.cwd || req.query?.cwd);
  } catch (error) {
    if (!respondAiStatusError(res, error, req.body?.cwd || req.query?.cwd)) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
});

/**
 * 启动 AI 服务
 */
router.post('/start', async (req, res) => {
  try {
    runAiAutostart('start', res, req.body?.cwd || req.query?.cwd);
  } catch (error) {
    if (!respondAiStatusError(res, error, req.body?.cwd || req.query?.cwd)) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
});

module.exports = router;
