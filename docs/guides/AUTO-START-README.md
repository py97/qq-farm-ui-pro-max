# 🎉 无感知自动启动 - 完成总结

## ✅ 已完成的功能

### 1. 进程守护系统
- ✅ **ai-services-daemon.js** - 主守护进程
  - 自动启动 OpenViking Python 服务
  - 进程崩溃自动重启（最多 5 次）
  - 定期健康检查（30 秒间隔）
  - 故障自动恢复
  - 优雅关闭支持

### 2. 自动启动器
- ✅ **ai-autostart.js** - 自动启动管理
  - 检查守护进程状态
  - 防止重复启动
  - 提供命令行工具
  - 导出 API 供程序调用

### 3. 主程序集成
- ✅ **core/client.js** - 已集成自动启动
  - 启动时自动调用 AI 服务
  - 后台静默运行
  - 失败不影响主程序
  - 完全无感知

### 4. 状态监控
- ✅ **core/src/controllers/aiStatus.js** - HTTP 监控接口
  - `/api/ai/status` - 查看服务状态
  - `/api/ai/logs` - 查看日志
  - `/api/ai/start` - 启动服务
  - `/api/ai/stop` - 停止服务
  - `/api/ai/restart` - 重启服务

### 5. 开机自启动配置
- ✅ **setup-macos-launchd.sh** - macOS launchd 配置
- ✅ **ai-services.systemd** - Linux systemd 配置
- ✅ **ai-services.nssm** - Windows NSSM 配置

### 6. 测试和工具
- ✅ **test-autostart.js** - 自动化测试脚本
- ✅ **package.json** - 添加快捷命令

## 📦 文件清单

```
qq-farm-bot-ui-main/
├── ai-services-daemon.js          ⭐ 守护进程（核心）
├── ai-autostart.js                ⭐ 自动启动器
├── test-autostart.js              📝 测试脚本
├── setup-macos-launchd.sh         🔧 macOS 配置
├── ai-services.systemd            🔧 Linux 配置
├── ai-services.nssm               🔧 Windows 配置
│
├── core/
│   ├── client.js                  ⭐ 已集成自动启动
│   └── src/controllers/
│       └── aiStatus.js            📊 状态监控接口
│
├── logs/                          📁 日志目录（自动创建）
│   ├── ai-services.log
│   ├── ai-services-error.log
│   └── ai-daemon.pid
│
└── 文档/
    ├── AUTO-START-GUIDE.md        📖 自动启动指南
    ├── README.AI.md               📖 AI 功能文档
    └── QUICKSTART.AI.md           📖 快速入门
```

## 🚀 使用方法

### 方式 1：正常使用（推荐）

**完全无感知！就像往常一样启动项目即可：**

```bash
# 使用 pnpm
pnpm start

# 或直接运行 core
cd core
npm start
```

AI 服务会在后台自动启动，无需任何额外操作！

### 方式 2：使用快捷命令

```bash
# 查看 AI 服务状态
pnpm status:ai

# 启动 AI 服务
pnpm start:ai

# 停止 AI 服务
pnpm stop:ai

# 重启 AI 服务
pnpm restart:ai

# 查看日志
pnpm logs:ai

# 运行测试
pnpm test:ai
```

### 方式 3：命令行工具

```bash
# 查看状态
node ai-autostart.js status

# 启动
node ai-autostart.js start

# 停止
node ai-autostart.js stop

# 重启
node ai-autostart.js restart
```

## 🎯 自动化流程

```
用户启动项目 (npm start / pnpm start)
        ↓
core/client.js 自动调用 ai-autostart.start()
        ↓
ai-autostart.js 检查守护进程
        ↓
    ┌───┴───┐
    │       │
已运行   未运行
    │       │
    │       ↓
    │   启动 ai-services-daemon.js
    │       ↓
    │   创建 Python 虚拟环境（如需要）
    │       ↓
    │   安装依赖（如需要）
    │       ↓
    │   启动 OpenViking 服务
    │       ↓
    │   启动健康检查
    │       ↓
    └──→ 后台持续运行
            ↓
        定期健康检查（30 秒）
            ↓
        发现故障自动重启
```

## 📊 监控和管理

### Web 面板集成

AI 状态监控接口已集成到现有 Web 面板：

```javascript
// 查看状态
GET /api/ai/status

// 查看日志
GET /api/ai/logs

// 控制服务
POST /api/ai/start
POST /api/ai/stop
POST /api/ai/restart
```

### 命令行监控

```bash
# 实时查看状态
watch -n 2 'node ai-autostart.js status'

# 实时查看日志
tail -f logs/ai-services.log

# 查看错误日志
tail -f logs/ai-services-error.log
```

## 🔧 配置选项

### 守护进程配置

在 `ai-services-daemon.js` 中：

```javascript
const CONFIG = {
  openVikingPort: 5432,              // OpenViking 端口
  restartDelay: 3000,                // 重启延迟（毫秒）
  healthCheckInterval: 30000,        // 健康检查间隔（毫秒）
  maxRestarts: 5,                    // 最大重启次数
  healthCheckTimeout: 5000,          // 健康检查超时（毫秒）
};
```

### 环境变量

在 `.env` 文件中配置：

```bash
# OpenViking 服务地址
OPENVIKING_URL=http://localhost:5432

# OpenViking 端口
OPENVIKING_PORT=5432

# 可选：允许 AI 服务启停和日志读取的额外工作目录（逗号 / 分号 / 换行分隔）
AI_SERVICE_ALLOWED_CWDS=/absolute/workspace-one,/absolute/workspace-two
```

### 目录白名单说明

- 未显式传入 `cwd` 时，AI 服务默认只在当前项目根目录下启动、停止和读日志。
- 传入 `--cwd`、`--project-root` 或调用 `/api/ai/*?cwd=...` 时，目录必须等于项目根目录，或出现在 `AI_SERVICE_ALLOWED_CWDS` 白名单中。
- 目录存在但不在允许范围内时，HTTP 接口会返回 `400`，命令行启动器会直接拒绝执行并输出错误信息。

## 🎓 快速测试

### 1. 运行自动化测试

```bash
pnpm test:ai
```

### 2. 手动验证

```bash
# 1. 启动项目
pnpm start

# 2. 等待 10 秒

# 3. 在新终端查看状态
node ai-autostart.js status
# 应显示：✅ AI 服务守护进程正在运行

# 如果状态异常，直接输出诊断报告
node ai-autostart.js doctor

# 4. 检查 OpenViking 服务
curl http://localhost:5432/health
# 应返回：{"status":"healthy",...}
```

### 3. 测试自动重启

```bash
# 1. 找到 OpenViking 进程
ps aux | grep "python.*app.py"

# 2. 杀死进程
kill -9 <PID>

# 3. 等待 5 秒

# 4. 检查是否自动重启
curl http://localhost:5432/health
```

## 🌐 开机自启动

### macOS

```bash
# 1. 运行配置脚本
./setup-macos-launchd.sh

# 2. 加载服务
launchctl load -w ~/Library/LaunchAgents/com.qqfarm.ai-services.plist

# 3. 验证
launchctl list | grep com.qqfarm.ai-services
```

### Linux

```bash
# 1. 复制配置文件
sudo cp ai-services.systemd /etc/systemd/system/

# 2. 启用服务
sudo systemctl enable ai-services
sudo systemctl start ai-services

# 3. 查看状态
systemctl status ai-services
```

### Windows

使用 NSSM 安装为 Windows 服务（参考 AUTO-START-GUIDE.md）

## 📈 日志管理

### 日志文件

```
logs/
├── ai-services.log          # 主日志（所有日志）
├── ai-services-error.log    # 错误日志
├── ai-autostart.log         # 自动启动日志
└── ai-daemon.pid            # 守护进程 PID
```

### 日志轮转（建议配置）

**Linux (logrotate):**
```bash
# /etc/logrotate.d/ai-services
/path/to/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}
```

**macOS (newsyslog):**
```bash
# /etc/newsyslog.d/ai-services
/path/to/logs/*.log  644  7  100  *  Z
```

## 🔍 故障排查

### 问题 1：服务未自动启动

**检查主程序日志：**
```bash
tail -f logs/ai-autostart.log
```

**手动测试：**
```bash
node ai-autostart.js start
```

### 问题 2：反复重启

**查看错误：**
```bash
tail -f logs/ai-services.log
```

**常见原因：**
- Python 虚拟环境问题
- 依赖未安装
- `5432` 被已有 OpenViking / PostgreSQL / 残留实例占用
- `8080` 被残留 AGFS 实例占用

**解决方法：**
```bash
cd services/openviking
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**优先检查状态：**
```bash
node scripts/service/ai-autostart.js status --cwd .
# 可能出现：
# - ✅ 守护模式
# - ⚠️ 外部实例模式
# - ⚠️ 残留实例/端口冲突
# - ❌ 未运行

node scripts/service/ai-autostart.js doctor --cwd .
# 会额外输出：
# - 当前运行模式（managed / external / conflict / offline）
# - PID 文件是否 stale
# - 5432 / 8080 的监听进程
# - 最近日志和建议操作
```

### 问题 3：无法访问服务

**检查健康状态：**
```bash
curl http://localhost:5432/health
```

**查看端口占用：**
```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

## ✨ 特性总结

### 🎯 完全无感知
- ✅ 无需手动启动
- ✅ 无需额外配置
- ✅ 失败不影响主程序
- ✅ 后台静默运行

### 🛡️ 高度可靠
- ✅ 进程崩溃自动重启
- ✅ 定期健康检查
- ✅ 最大重启次数限制
- ✅ 详细的日志记录

### 🔧 易于管理
- ✅ 简单的命令行工具
- ✅ Web 面板集成
- ✅ 开机自启动支持
- ✅ 完整的监控功能

### 🌍 跨平台
- ✅ macOS (launchd)
- ✅ Linux (systemd)
- ✅ Windows (NSSM)

## 🎉 使用场景

### 开发环境
```bash
# 就像往常一样
pnpm dev

# AI 服务已自动在后台运行！
```

### 生产环境
```bash
# 启动生产版本
pnpm start

# 配置开机自启动后，重启也会自动运行
```

### 打包后
打包后的可执行文件也会自动启动 AI 服务！

## 📞 帮助

**文档：**
- [AUTO-START-GUIDE.md](AUTO-START-GUIDE.md) - 详细指南
- [README.AI.md](README.AI.md) - AI 功能文档
- [QUICKSTART.AI.md](QUICKSTART.AI.md) - 快速入门

**命令：**
```bash
# 查看帮助
node ai-autostart.js --help

# 查看状态
pnpm status:ai

# 查看日志
pnpm logs:ai
```

---

## 🎊 完成！

**现在，你只需要像往常一样启动项目，AI 服务就会自动在后台运行，完全无感知！**

```bash
pnpm start
```

就这么简单！✨
