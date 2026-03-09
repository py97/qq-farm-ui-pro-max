# 🚀 无感知自动启动配置指南

## ✅ 已实现的自动化功能

### 1. 进程守护
- ✅ 自动启动 OpenViking Python 服务
- ✅ 进程崩溃自动重启（最多 5 次）
- ✅ 定期健康检查（30 秒间隔）
- ✅ 故障自动恢复

### 2. 无感知集成
- ✅ 集成到主程序启动流程
- ✅ 后台静默运行
- ✅ 不阻塞主程序
- ✅ 失败不影响主功能

### 3. 开机自启动
- ✅ macOS launchd 支持
- ✅ Linux systemd 支持
- ✅ Windows NSSM 支持

## 📋 自动启动流程

```
┌─────────────────────────────────────────────────────┐
│          启动主程序 (npm start)                      │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│   core/client.js 自动调用 ai-autostart.start()      │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│   ai-autostart.js 检查守护进程是否运行              │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│   如果未运行：启动 ai-services-daemon.js            │
│   如果已运行：跳过启动                              │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│   ai-services-daemon.js 执行：                      │
│   1. 创建 Python 虚拟环境（如果需要）               │
│   2. 安装依赖（如果需要）                           │
│   3. 启动 OpenViking Flask 服务                     │
│   4. 启动健康检查循环                               │
│   5. 监控进程状态，故障自动重启                     │
└─────────────────────────────────────────────────────┘
```

## 🔧 使用方法

### 方式 1：正常启动（推荐）

**无需任何额外操作！**

```bash
# 像往常一样启动项目
npm start

# 或者
cd core
npm start
```

AI 服务会自动在后台启动，完全无感知！

### 方式 2：手动控制

```bash
# 查看状态
node ai-autostart.js status

# 启动服务
node ai-autostart.js start

# 停止服务
node ai-autostart.js stop

# 重启服务
node ai-autostart.js restart
```

## 🌐 开机自启动配置

### macOS

```bash
# 1. 运行配置脚本
chmod +x setup-macos-launchd.sh
./setup-macos-launchd.sh

# 2. 加载服务
launchctl load -w ~/Library/LaunchAgents/com.qqfarm.ai-services.plist

# 3. 验证
launchctl list | grep com.qqfarm.ai-services
```

**卸载方法：**
```bash
launchctl unload -w ~/Library/LaunchAgents/com.qqfarm.ai-services.plist
```

### Linux (systemd)

```bash
# 1. 编辑配置文件（修改用户名和路径）
sudo nano /etc/systemd/system/ai-services.service

# 2. 重新加载 systemd
sudo systemctl daemon-reload

# 3. 启用服务
sudo systemctl enable ai-services

# 4. 启动服务
sudo systemctl start ai-services

# 5. 查看状态
systemctl status ai-services
```

**查看日志：**
```bash
journalctl -u ai-services -f
```

### Windows

使用 NSSM (Non-Sucking Service Manager)：

```bash
# 1. 下载 NSSM: https://nssm.cc/download

# 2. 安装服务
nssm install AI-Services

# 3. 配置服务（图形界面）
# - Application: node.exe
# - Arguments: ai-services-daemon.js
# - Startup directory: 项目根目录

# 4. 启动服务
nssm start AI-Services
```

## 📊 监控和日志

### 查看服务状态

**Web 面板（集成到现有面板）：**
```
GET /api/ai/status    # 查看 AI 服务状态
GET /api/ai/logs      # 查看日志
POST /api/ai/restart  # 重启服务
```

**命令行：**
```bash
# 查看状态
node ai-autostart.js status

# 查看日志
tail -f logs/ai-services.log
tail -f logs/ai-services-error.log
```

### 日志文件位置

```
logs/
├── ai-services.log          # 主日志
├── ai-services-error.log    # 错误日志
├── ai-autostart.log         # 自动启动日志
└── ai-daemon.pid            # 守护进程 PID
```

## ⚙️ 配置选项

在 `ai-services-daemon.js` 中可配置：

```javascript
const CONFIG = {
  openVikingPort: 5432,              // OpenViking 端口
  openVikingUrl: 'http://localhost:5432',
  restartDelay: 3000,                // 重启延迟（毫秒）
  healthCheckInterval: 30000,        // 健康检查间隔（毫秒）
  maxRestarts: 5,                    // 最大重启次数
  healthCheckTimeout: 5000,          // 健康检查超时（毫秒）
};
```

## 🔍 故障排查

### 问题 1：AI 服务未自动启动

**检查主程序日志：**
```bash
tail -f logs/ai-autostart.log
```

**手动测试启动：**
```bash
node ai-autostart.js start
```

### 问题 2：守护进程反复重启

**查看错误日志：**
```bash
tail -f logs/ai-services-error.log
```

**常见原因：**
- Python 虚拟环境未创建
- 依赖未安装
- 端口被占用

**解决方法：**
```bash
# 手动初始化
cd openviking-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 问题 3：OpenViking 服务无法访问

**检查健康状态：**
```bash
curl http://localhost:5432/health
```

**查看进程：**
```bash
ps aux | grep "python.*app.py"
```

**重启服务：**
```bash
node ai-autostart.js restart
```

## 📈 性能优化

### 降低资源占用

配置文件中的参数：

```javascript
// macOS launchd
<key>LowPriorityIO</key>
<true/>
<key>Nice</key>
<integer>10</integer>

// Linux systemd
Nice=10
IOSchedulingClass=idle
```

### 调整健康检查频率

```javascript
// 降低检查频率（默认 30 秒）
healthCheckInterval: 60000  // 改为 60 秒

// 或提高检查频率
healthCheckInterval: 15000  // 改为 15 秒
```

## 🎯 验证自动化

### 测试步骤

1. **启动主程序**
   ```bash
   npm start
   ```

2. **等待 10 秒**

3. **检查 AI 服务状态**
   ```bash
   node ai-autostart.js status
   # 应该显示：✅ AI 服务守护进程正在运行

   node ai-autostart.js doctor
   # 异常时可直接看到 PID / 端口 / 近期日志诊断
   
   curl http://localhost:5432/health
   # 应该返回：{"status":"healthy","workspace":"..."}
   ```

4. **测试自动重启**
   ```bash
   # 找到 OpenViking 进程
   ps aux | grep "python.*app.py"
   
   # 杀死进程
   kill -9 <PID>
   
   # 等待 5 秒，检查是否自动重启
   curl http://localhost:5432/health
   ```

5. **查看日志**
   ```bash
   tail -f logs/ai-services.log
   ```

## ✨ 特性总结

### 完全无感知

- ✅ 无需手动启动 AI 服务
- ✅ 无需额外配置
- ✅ 失败不影响主程序
- ✅ 后台静默运行

### 高度可靠

- ✅ 进程崩溃自动重启
- ✅ 定期健康检查
- ✅ 最大重启次数限制
- ✅ 详细的日志记录

### 易于管理

- ✅ 简单的命令行工具
- ✅ Web 面板集成
- ✅ 开机自启动支持
- ✅ 完整的监控功能

### 跨平台支持

- ✅ macOS (launchd)
- ✅ Linux (systemd)
- ✅ Windows (NSSM)

## 🎉 使用示例

### 日常使用

```bash
# 就像往常一样启动项目
npm start

# 然后就可以直接使用了！
# AI 服务已经在后台自动运行
```

### 在代码中使用

```javascript
const { qwenAIAssistant } = require('./core/src/services/qwenAIAssistant');

// 直接使用，无需担心服务是否启动
const result = await qwenAIAssistant.generateCode(
  '创建快速排序函数',
  'javascript'
);
```

### 查看状态

```bash
# 快速查看
node ai-autostart.js status

# 或者访问 Web 面板
# http://localhost:3000/api/ai/status
```

## 📞 帮助

如有问题，请查看：

1. 日志文件：`logs/ai-*.log`
2. 系统日志：`journalctl -u ai-services` (Linux) 或 Console.app (macOS)
3. 文档：README.AI.md

---

**现在，你只需要像往常一样启动项目，AI 服务就会自动在后台运行！** 🎉
