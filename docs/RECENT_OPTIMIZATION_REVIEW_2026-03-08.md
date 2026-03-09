# 近期优化复盘与公告同步记录 (2026-03-08)

## 1. 记录范围

本轮复盘覆盖以下近期优化链路：

- 公告系统与 `Update.log` 同步
- 设置页「经营汇报历史」筛选、统计与分页
- UI 全局配置持久化与多端同步
- 登录页背景预览相关构建链路
- 账号列表可读性与细节体验

## 2. 本轮确认过的更新

### 2.1 公告链路

- 本地公告源继续以 `logs/development/Update.log` 为准。
- 服务端公告数据继续由 `announcements` 表承载。
- 为降低人工维护风险，`Update.log` 解析已增强为按日期标题行切段，而不是强依赖空行。

### 2.2 设置页经营汇报历史

- 新增后端统计接口 `/api/reports/history/stats`，可返回总数、成功数、失败数、测试汇报数、小时汇报数、日报数。
- 前端支持结果筛选、关键词搜索、导出、批量删除、分页和本地视图偏好保留。
- 切换账号时的重复刷新已去掉，减少无效请求和闪动。

### 2.3 UI 配置持久化

- `theme / loginBackground / overlayOpacity / blur / colorTheme / performanceMode / timestamp` 已统一进入 `normalizeUIConfig()` 做后端归一化。
- `auto` 主题现已允许在服务端落库与回读，多端同步时不会再被强制改写成 `dark`。

## 3. 已发现的问题、影响与处理

### 3.1 `/api/announcement` 被全局鉴权误拦

- 现象：代码注释写明“无需认证，公开接口”，但真实访问返回 `401 Unauthorized`。
- 影响：登录页/公开区域无法直接读取公告；线上排查时也必须借管理员态绕过。
- 处理：已将 `/announcement` 加入 `PUBLIC_PATHS`。

### 3.2 `auto` 主题在服务端持久化时失真

- 现象：前端可以切到“自动跟随”，但服务端规范化逻辑只接受 `light` / `dark`，导致回读时被压回深色。
- 影响：多端或刷新后，管理员设置的自动模式会丢失。
- 处理：已更新 `normalizeUIConfig()` 与 `setUITheme()`，允许 `auto` 持久化。

### 3.3 经营汇报历史在切账号时重复拉取

- 现象：`currentAccountId` 变化时，`loadData()` 会刷新一次汇报历史，同时筛选 watcher 也会再次刷新。
- 影响：每次切换账号都会多打一轮 `/api/reports/history` 和 `/api/reports/history/stats`，增加噪声和潜在闪动。
- 处理：已将筛选 watcher 改为只监听筛选项，不再监听 `currentAccountId`。

### 3.4 `Update.log` 对人工排版过于敏感

- 现象：若两个公告块之间缺少空行，旧解析器会把相邻条目合并，导致同步少条目。
- 影响：公告数据库会遗漏版本记录，前台展示顺序和数量都可能异常。
- 处理：
  - 已补齐当前 `Update.log` 中的缺失分隔。
  - 已将解析逻辑改为按日期标题行切段。

### 3.5 登录背景编辑器脚本阻断构建

- 现象：登录背景预览相关方法尚未完全接入模板，但脚本已存在，`vue-tsc` 将其判定为未使用。
- 影响：前端构建失败，影响打包与部署。
- 处理：已采用最小保留方式让这组逻辑继续存在但不阻塞编译，未改业务行为。

## 4. 当前残余风险

- 公告同步目前仍以“标题 + 版本”或“标题 + 日期”去重。若未来同一天发布同标题但正文不同的补充公告，可能仍需更稳定的指纹去重策略。
- `Update.log` 现在虽然更稳健，但仍属于人工维护文本。若后续公告频率继续上升，建议引入脚本化校验或直接从结构化源生成。
- 设置页经营汇报统计当前是“基于当前筛选结果集”的统计口径。如果后续想显示“全量汇报总览”，需要和当前筛选统计拆成两套接口。

## 5. 下一步优化建议

- 为 `parseUpdateLog()` 增加单元测试，覆盖“缺失空行”“同一天多条公告”“无版本号条目”等情况。
- 为公告同步增加稳定哈希去重键，例如 `date + title + content hash`，避免只靠标题和版本。
- 为经营汇报历史请求增加取消前一请求的能力，防止快速切换筛选时旧响应覆盖新状态。
- 若后续准备再次上线服务器版本，建议把本轮 3 个代码修复一并发布：公开公告读取、`auto` 主题持久化、汇报历史去重拉取。

## 6. 本轮验证

- `node -c core/src/controllers/admin.js`
- `node -c core/src/models/store.js`
- `pnpm -C web exec vue-tsc -b`
- `pnpm -C web build`

## 7. 本轮补充优化（登录背景 / 汇报统计 / 精细出售）

### 7.1 已纳入的新增功能

- 登录页背景新增了内置预设、本地上传、遮罩透明度、模糊度四项能力。
- 主界面现在可以按 `backgroundScope` 继承同一张背景，并单独配置业务页的遮罩强度与模糊度。
- 主题抽屉支持一键套用匹配的主题背景预设，颜色主题和氛围背景能同时切换。
- 经营汇报历史新增统计卡片、排序、视图偏好记忆以及“最新失败”快捷入口。
- 背包出售链路由“按合并显示项出售”升级为“按原始背包条目和 UID 拆分出售”。
- 启动账号时，数据库中的完整账号记录现在会覆盖列表缓存，避免新登录态被旧快照回填。

### 7.2 已确认的发布风险

- `core/src/cluster/worker-client.js` 使用了 `socket.io-client`，但之前 `core/package.json` 没声明该运行时依赖。
- 影响：Docker / 二进制发布在集群 Worker 场景下，存在运行时缺模块风险。
- 处理：本轮已补到 `core/package.json`。
- 补充确认：本地执行 `pnpm install` 刷新 workspace 依赖后，`pnpm -C core build:release` 已无该项 `pkg` 警告。

### 7.3 当前影响判断

- 登录背景上传能力会把文件落到 `data/ui-backgrounds/`，目前没有自动清理旧背景文件的机制。
- 外链背景预设仍依赖第三方图床可访问性，若远端防盗链或失效，预设图可能无法显示。
- 本轮已发现并补齐樱花与赛博主题缺失的内置 SVG 资源，否则主题抽屉的一键背景功能会出现静态资源 404。
- 汇报历史统计当前是“基于当前筛选结果”的统计，不是全量总览，这一点需要在后续文案和接口设计上继续保持清晰。

### 7.4 建议

- 为登录背景上传增加“删除旧自定义背景”或“定期清理未引用文件”的机制，避免 `data/ui-backgrounds/` 长期膨胀。
- 将外链背景预设逐步替换为本地托管资源，减少第三方图片站的可用性波动。
- 若后续继续扩充经营汇报分析，建议增加“全量统计”和“当前筛选统计”两套独立口径，避免用户误解。

## 8. 本轮热修补丁（前端 lint / CI）

- GitHub `main` 分支本轮首次推送后，失败点已定位在 `pnpm -C web lint`，不是前端构建或后端打包。
- 处理方式：对 `Settings.vue` 的主题联动卡片绑定、`ui-appearance.ts` 的类型声明、若干 Vue 文件的 UnoCSS/样式顺序做了最小规范收口。
- 结果：`pnpm -C web lint`、`pnpm -C web build`、`pnpm -C core build:release` 已重新通过。
- 结论：本轮新增功能链路本身可用，`v4.5.10` 主要是把远端 CI 与当前前端规范基线重新对齐。

## 9. 二次复查补充（2026-03-08 23:10）

### 9.1 新确认的问题

- **主题整套联动在重构后参数不完整**:
  `getThemeAppearanceConfig()` 一度只返回登录页背景与登录页遮罩/模糊参数，导致“5 套主题联动方案”和“主题锁定背景”在切换主题后，主界面遮罩/模糊参数并不会一起更新。
- **主界面视觉预设处于半接入状态**:
  `workspaceVisualPreset`、`UI_WORKSPACE_VISUAL_PRESETS` 和对应的服务端持久化都已经接入，但设置页没有实际入口，只能靠临时绑定数组避免 lint 报未使用。

### 9.2 影响判断与处理

- **用户感知层面**:
  主题卡片文案宣称会同步“主界面参数”，但实际行为只改登录页，属于明确的功能感知不一致。
- **维护层面**:
  主界面视觉预设在代码层存在、在界面层缺席，后续很容易被误判成“功能已上线”，增加复查和交接成本。
- **当前处理**:
  - 已恢复主题整套联动的主界面参数同步。
  - 已在设置页补上主界面视觉预设可视化卡片。
  - 已删除仅用于规避 lint 的占位绑定，改为真实模板接入。

### 9.3 目前剩余风险与建议

- **主题联动范围回退已补正**:
  原本在开启“主题锁定背景”后从右侧抽屉切主题，或直接点击抽屉中的“套用主题背景”，会把已保存的 `global` 背景范围默认写回 `login_and_app`。现已改为保留用户当前作用范围，仅在非全局模式下继续套用“登录页 + 主界面”主题联动。
- **主题联动混合态提示已补正**:
  实测联调发现，`workspaceVisualPreset` 会保留上一次手动选择的业务页风格，而“主题锁定背景”会单独注入当前主题的主界面遮罩/模糊参数，导致设置页顶部一度误显示为某个预设。现已改为按真实组合识别，混合态统一显示为“主题联动自定义”，避免把“海报沉浸版 / 控制台弱化版”等名称误当成当前实际参数。
- **整套主题已补齐业务页风格写入**:
  当前已为 5 套主题明确补上业务页风格映射，并把 `workspaceVisualPreset` 一并纳入主题联动保存链路。实测 `Ocean` 整套在开启 `themeBackgroundLinked` 且作用范围为 `global` 时，保存后服务端返回值已同步为 `workspaceVisualPreset: pure_glass`，不再残留旧的手动预设值。
- **地块类道具多选已补正**:
  背包详情里像浇水、除草、除虫、播种这类带 `land_ids` 的使用操作，原先允许选中的地块数超过当前物品库存，前端又会把 `count` 截断成库存上限，形成“文案显示按已选地块数消耗，但请求实际只带较小 count”的不一致。现已改为在 UI 侧按库存数量限制可选地块，并在使用成功后立即刷新土地列表状态。
- **兼容 UseRequest 的 fallback 分支已补写 land_ids**:
  `warehouse.useItem()` 在遇到旧接口编码兼容分支时，原先只写了 `{ item: { id, count } }`，没有继续携带 `land_ids`。这会让土地类道具在特殊兼容路径下失去目标地块参数。现已在 fallback 请求中补齐 repeated `land_ids` 字段。
- **后续建议**:
  建议补一条最小化的 `bag/use` 集成校验，至少覆盖“土地类道具 + `land_ids` + fallback 编码”的请求体构造。当前 `lint` / `build` / `node --check` 能兜住语法和构建，但仍无法替代真实协议层回归。
- **外链字体告警**:
  已处理。`web/uno.config.ts` 已移除 Google Fonts 在线拉取，改为本地字体栈，`pnpm -C web build` 不再出现此前的 Web Fonts 拉取失败告警。
- **背景与图标缓存增长**:
  已处理。服务端已新增未引用背景和过期生成图标缓存的清理逻辑，风险从“无清理机制”降为“后续按实际容量观察阈值是否需要再调优”。
- **背景预设可用性**:
  已处理当前已知外链项。示例背景 `sample-red-horse` 已改为本地 SVG 资源，当前登录背景预设已不再依赖第三方图片站。

### 9.4 补充验证

- `node --check core/src/config/gameConfig.js`
- `node --check core/src/controllers/admin.js`
- `node --check core/src/models/store.js`
- `node --check core/src/services/ui-assets.js`
- `node --check core/src/services/mall.js`
- `pnpm test:ui-assets`
- `pnpm -C web check:ui-appearance`
- `pnpm -C web lint`
- `pnpm -C web build`
- `pnpm -C core build:release`

## 10. 建议执行结果（2026-03-08 23:35）

### 10.1 已执行项

- **自动清理未引用背景文件**:
  已新增 `core/src/services/ui-assets.js`，在服务端启动、保存主题配置、上传新背景时都会清理过期且未引用的 `ui-backgrounds` 文件。
- **自动清理过期生成图标缓存**:
  `gameConfig` 加载时会清理过期或无效的 `data/asset-cache/item-icons` 生成 SVG 缓存，避免长期累积。
- **主题联动最小自动校验**:
  已新增 `web/scripts/check-ui-appearance.mjs`，会校验主题背景配置是否同时包含登录页和主界面参数。
- **本地化字体与示例背景**:
  已移除 UnoCSS 的在线字体拉取，并把示例酒红背景改为仓库内置 `crimson-velvet.svg`。

### 10.2 补充验证

- `pnpm test:ui-assets`
- `pnpm -C web check:ui-appearance`
- `pnpm -C web lint`
- `pnpm -C web build`
- `pnpm -C core build:release`

## 11. 补充复查（2026-03-09）

### 11.1 本轮新增确认

- **SMTP 邮件汇报已全链路接入**:
  `reportConfig.channel` 新增 `email`，设置页已可维护 `smtpHost / smtpPort / smtpSecure / smtpUser / smtpPass / emailFrom / emailTo`，服务端归一化、配置校验、汇报可用性判断和推送下发链路已保持一致。
- **账号保存后立即持久化**:
  管理端保存账号成功后会直接调用 `persistAccountsNow()`，减少扫码登录成功后尚未等到批量落库就异常退出的风险。
- **好友拉取兼容模式改为按账号缓存**:
  `SyncAll / GetAll` 的探测结果现在以账号维度缓存，不再一个账号切到兼容模式后影响整台机器所有账号。
- **好友日志噪声已压低**:
  好友列表调试日志和周期状态日志增加 TTL 去重，长时间挂机时更容易看见真正的新异常。
- **背包使用链路继续补正**:
  `worker` 已补齐 `useBagItem` 调用面，土地类道具在旧编码 fallback 分支也会继续携带 `land_ids`。

### 11.2 本轮验证

- `git diff --check`
- `node --check core/src/services/smtp-mailer.js`
- `node --check core/src/services/push.js`
- `node --check core/src/services/report-service.js`
- `node --check core/src/config-validator.js`

## 12. 二次复查续记（2026-03-09）

### 12.1 本轮纳入记录的新增调整

- 部署脚本已补齐“显式传入 `ADMIN_PASSWORD` 即同步数据库 admin 哈希”的落库动作，不再只修改 `.env`。
- `update-app.sh` 已补齐从当前 shell 环境回写 `ADMIN_PASSWORD / WEB_PORT` 等变量到部署目录 `.env` 的逻辑，修复更新场景下参数被忽略的问题。
- 账号模式相关元信息已进入运行态账号快照，账号列表和账号归属页可以直接展示 `accountMode / harvestDelay / accountZone`。
- SMTP 邮件汇报链路已经形成“设置页表单 → 服务端归一化 → 发送器 → 推送总线”的完整闭环。

### 12.2 本轮新发现的问题

#### 12.2.1 重启广播仍是单次触发、失败后不补发

- 代码位置：`core/src/services/report-service.js`
- 现状：`sendRestartBroadcast()` 在首次进入时立即把 `restartBroadcastTriggered` 置为 `true`，后续即使推送失败、SMTP 暂时不可用或外部 webhook 短时超时，也不会在当前进程生命周期内再次尝试。
- 风险：如果容器刚拉起时外部依赖还没完全就绪，服务器重启提醒会直接丢失，且不会自动补发。
- 影响：管理员会误以为“服务没有重启广播能力”或“消息链路完全中断”，增加定位成本。

#### 12.2.2 `modeScope` 目前仍未进入真实运行时决策

- 代码位置：
  - 设置说明与展示：`web/src/views/Settings.vue`
  - 存储与接口：`core/src/models/store.js`、`core/src/controllers/admin.js`、`core/src/runtime/data-provider.js`
  - 运行时消费：当前好友/农场逻辑主要仍只读取 `accountMode`
- 现状：`zoneScope / requiresGameFriend / fallbackBehavior` 已进入持久化和返回值，也已经出现在设置页风险说明里。
- 风险：界面宣称“当前账号区服”“必须互为游戏好友”“否则按独立账号降级”，但运行时没有看到对应约束真正参与好友巡查或农场调度判定。
- 影响：用户会误以为系统已经具备“按区服 / 游戏好友自动降级”的真实行为约束，形成配置预期与运行结果不一致。

#### 12.2.3 设置保存链路仍可能出现“部分成功、整体报错”

- 代码位置：
  - 前端：`web/src/stores/setting.ts`
  - 后端：`core/src/controllers/admin.js`
- 现状：保存设置时，前端先调用 `/api/accounts/:id/mode`，随后再调用 `/api/settings/save`。
- 风险：如果第二步校验失败、网络超时或后端抛错，模式切换和同区其他主号的降级可能已经落库，但前端会把本次操作整体视为失败。
- 影响：用户在界面上收到“保存失败”提示后再次重试，容易触发重复广播、重复写库和误判当前真实状态。

### 12.3 当前建议

- 为服务器重启提醒增加一次延迟重试，并在账号日志或内存态中保留幂等键，避免既丢消息又重复轰炸。
- 若近期还不会把 `modeScope` 接入好友扫描和农场策略层，建议先降低设置页文案承诺，避免把“数据模型已建好”误传达成“行为已经生效”。
- 将账号模式切换并入统一的 `/api/settings/save` 提交链路，或至少只在账号模式发生实际变化时才单独调用 `/api/accounts/:id/mode`。

### 12.4 本轮验证

- `node --check core/src/services/report-service.js`
- `node --check core/src/models/store.js`
- `node --check core/src/controllers/admin.js`
- `node --check core/src/runtime/data-provider.js`
- `node --check core/src/services/farm.js`
- `bash -n scripts/deploy/fresh-install.sh`
- `bash -n scripts/deploy/update-app.sh`
- `node --test core/__tests__/store-account-mode.test.js core/__tests__/store-trial-config.test.js`

### 12.5 延伸建议

- `smtp-mailer` 采用的是手写 SMTP 协议实现，当前适合纯文本经营汇报；如果后面要支持更复杂的 HTML 模板、附件或更复杂的认证兼容，建议补集成测试并考虑是否引入成熟邮件库。
- 好友拉取模式虽然已按账号缓存，但仍建议在 QQ / 微信混跑环境各做一次实机回归，确认探测结论不会受平台风控瞬时波动误导。
- 背包土地类道具的 `land_ids` fallback 已补齐，但这类问题更偏协议兼容，后续最好补一条最小集成回归，而不是只依赖构建和静态检查。

### 12.6 已执行修复（2026-03-09）

- **设置保存链路已统一**:
  设置页保存时已取消额外的 `/api/accounts/:id/mode` 前置调用，账号模式切换、主号唯一化和普通设置保存现在统一走 `/api/settings/save` 后端链路处理。
- **邮件重启广播已补齐 `smtpUser` 区分**:
  `buildReportChannelSignature()` 现已把 SMTP 登录账号纳入 `email` 渠道分组键，降低“同发件人别名、同收件箱、不同认证账号”时的配置串用风险。
- **新增后端回归测试**:
  已新增统一保存链路和重启广播分组逻辑的 2 条测试，避免后续重构再次引入相同回归。

### 12.7 本轮后仍未完成的事项

- **`modeScope` 仍未真正接入运行时**:
  本轮修复的是“保存一致性”和“广播分组”问题，`zoneScope / requiresGameFriend / fallbackBehavior` 仍主要停留在存储与展示层，后续还需要进入好友/农场决策代码。

### 12.6 补充修复与再验证（2026-03-09）

#### 12.6.1 本轮新增确认与已修复项

- **农场补种死循环已补闭环**:
  复查近期补种链路时，确认 `PlantService.Plant code=1001008` 会把“已种植”地块持续打回失败日志，而旧逻辑仍会按误判空地继续“选种 -> 购种 -> 种植”。现已补三层收口：
  - `resolveLandLifecycle()` 不再把“`plant` 存在但阶段数据缺失”的土地直接算成空地。
  - `autoPlantEmptyLands()` 在购种前会再次拉取土地状态，只对复核后仍为空地的目标地块购买。
  - 对明确返回“土地已种植”的地块增加短期冷却，并按真实 `plantedLandIds` 记账，不再把 `0` 成功种植也记成 `种植3`。
- **服务器重启提醒的渠道分组签名已补正**:
  复查 `report-service` 时发现，重启广播按渠道聚合时，`webhook` 只使用 `endpoint` 做签名，`email` 也未纳入端口/TLS/认证账号维度。若两组账号共用同一 webhook 地址但 token 不同，或同主机不同端口/加密策略，会被错误合并到同一推送批次。现已把 `token / smtpPort / smtpSecure / smtpUser` 纳入签名。
- **设置页保存的账号模式副作用已压低**:
  之前 `saveSettings()` 每次保存都会额外打一遍 `/api/accounts/:id/mode`，即使账号模式根本没变，也会重复触发主号唯一性检查和 worker 配置广播。现已改为仅在 `accountMode` 真实变化时才调用模式切换接口。
- **新增 store 用例已补齐 MySQL 初始化 mock**:
  `store.js` 新增 `isMysqlInitialized()` 依赖后，两条新增单测需要同步 mock。现已补齐，避免测试环境在模块加载阶段因缺少该导出而直接中断。

#### 12.6.2 本轮影响判断

- **对农场自动化的影响**:
  当前影响主要集中在“误判空地导致反复买种子”的资源浪费和日志噪声。补丁落地后，预期日志会从连续的“购买种子 + 1001008 失败”切换为“种植前复核跳过”或“冷却期内跳过复种”。
- **对经营汇报的影响**:
  若不修正广播签名，服务器重启提醒在多账号、多渠道并行时存在串组风险，最坏情况下会把某一账号组的通知发到另一组 webhook/token 上，造成错误告警或漏告警。
- **对设置保存的影响**:
  重复触发 `/mode` 不会直接破坏配置，但会制造一次无意义的模式重放、额外的账号降级检查和 worker 广播；在多账号面板里会放大为不必要的运行态抖动。

#### 12.6.3 当前仍建议关注

- `smtp-mailer` 现阶段仍以文本邮件为主，建议后续补一条真实 SMTP 集成回归，至少覆盖 `465 SSL` 和 `587 STARTTLS` 两种最常见配置。

#### 12.6.4 本轮补充验证

- `git diff --check`
- `node --check core/src/models/store.js`
- `node --check core/src/services/report-service.js`
- `node --check core/src/services/farm.js`
- `pnpm -C web exec vue-tsc --noEmit`
- `node --test core/__tests__/store-account-mode.test.js core/__tests__/store-trial-config.test.js`

#### 12.6.5 建议项已实施落地（2026-03-09）

- **服务器重启提醒已补重试与幂等批次**:
  `sendRestartBroadcast()` 现已引入启动批次号、渠道级状态表和单任务名重试。首次发送失败后会延迟重试 1 次，且只有成功送达才会标记 `delivered`；同一批次下重复触发不会再次轰炸已成功渠道。
- **重启提醒失败路径已避免状态卡死**:
  发送异常、账号日志写入异常和调度回调现在已拆开处理，即使单个账号日志写失败，也不会把该渠道永久卡在 `inFlight`。
- **AI 服务 `cwd` 已收口到项目根 / 白名单**:
  `aiStatus` 控制器、`ai-autostart.js` 和 `ai-services-daemon.js` 现在统一走 `ai-workspace.js` 解析目录。默认仅允许当前项目根；若需多工作区，必须通过 `AI_SERVICE_ALLOWED_CWDS` 显式放行。
- **新增回归测试已覆盖关键闭环**:
  新增 `report-service-restart-broadcast.test.js`，验证“首发失败 -> 定时重试 -> 成功后不重复发送”；新增 `ai-workspace.test.js`，验证“默认拒绝任意目录 / 白名单允许额外工作区”。

#### 12.6.6 `modeScope` 运行时已正式接入（2026-03-09）

- **新增统一运行时解析器**:
  `core/src/services/account-mode-policy.js` 现会基于当前账号配置、同 owner 对端账号、区服和最近一次好友快照，统一解析 `effectiveMode / collaborationEnabled / degradeReason`。
- **好友巡查已消费 `effectiveMode`**:
  好友模块不再只盯着 `accountMode`。当 `fallbackBehavior=strict_block` 且未命中“同区 + 游戏好友”条件时，会临时按更保守模式执行，主动阻断偷菜与捣乱等高风险动作。
- **农场策略已消费 `effectiveMode`**:
  收获延迟、防偷 60 秒抢收和秒收前置判断已统一切到运行时有效模式；同时顺手修正了两处旧偏差：
  - `safe` 预设虽然配置了 `harvestDelay`，但旧逻辑只对 `alt` 生效，实际并不会延迟收获。
  - `antiStealHarvest()` 旧代码误读 `config.mode`，会让模式阻断判断失真。
- **运行态状态已补充模式结果**:
  Worker 状态和账号列表现在已能带回 `effectiveMode / collaborationEnabled / degradeReason`，并已在账号列表显式展示。
- **冷启动好友关系已补缓存预热**:
  Worker 登录成功后会优先读取最近一次 Redis 好友缓存并预热运行时快照，尽量缩短 `requiresGameFriend` 在冷启动阶段的未知窗口。
- **前端账号列表已补显式提示**:
  账号页现在会同时显示“配置模式”“当前生效模式”“独立执行/协同命中状态”，用户不再需要翻日志判断是否已经发生降级。

#### 12.6.7 本轮新增影响判断

- **对默认用户配置的影响**:
  默认 `fallbackBehavior=standalone` 下，本轮不会突然改变既有主号/小号的常规行为，主要新增的是“运行时真实判定”和“可观测的降级原因”。
- **对显式开启 `strict_block` 的影响**:
  这类账号在未命中同区/游戏好友条件时，现在会真实降到更保守模式；这是本轮最主要的行为变化，属于按配置兑现约束，不是兼容性回归。
- **对风险控制的正向影响**:
  `safe` 模式的收获延迟终于实际生效，且防偷抢收不会再因为读取错字段而越过模式约束。

#### 12.6.8 当前仍建议继续优化

- **好友关系判断仍依赖最近一次好友快照**:
  冷启动、网络抖动或好友列表暂时拉取失败时，会出现 `friend_relation_unknown` 窗口；若用户同时启用了 `strict_block`，账号会先按保守模式运行，等好友快照建立后再恢复/确认。
- **建议补冷启动预热**:
  后续可以考虑在 Worker 启动时预读 Redis / DB 中的好友缓存，把 `requiresGameFriend` 的首轮判断从“纯实时探测”升级为“缓存预热 + 实时刷新”。
- **建议把有效模式直接展示到前端**:
  后端数据已经齐全，下一步最值得做的是把 `effectiveMode / degradeReason` 直接显示在账号列表或设置页，降低排查成本。

#### 12.6.9 本轮补充验证

- `node --check core/src/services/account-mode-policy.js`
- `node --check core/src/services/friend/friend-scanner.js`
- `node --check core/src/services/farm.js`
- `node --check core/src/core/worker.js`
- `node --check core/src/runtime/data-provider.js`
- `node --check core/src/runtime/runtime-state.js`
- `node --test core/__tests__/account-mode-policy.test.js`
- `node --test core/__tests__/store-account-mode.test.js core/__tests__/data-provider-save-settings.test.js core/__tests__/report-service-restart-broadcast.test.js core/__tests__/store-trial-config.test.js`
- `git diff --check`

#### 12.6.10 前端运行态可视化已补齐（2026-03-09）

- **设置页已直接显示当前运行态判定**:
  `web/src/views/Settings.vue` 现会同时展示“配置模式 / 当前生效模式 / 协同命中或独立执行状态 / 降级原因”。用户不再需要切到账号列表或翻日志，切换账号后即可直接看到当前运行时是否按协同模式生效。
- **账号归属页已补模式运行态信息**:
  `web/src/views/AccountOwnership.vue` 的模式列现在不再只显示静态 `accountMode`，而会继续补出“生效模式”或“独立执行原因”，管理员在排查同 owner 账号是否真正命中协同时更直观。
- **账号管理页的表格排序状态已恢复持久化闭环**:
  `Accounts.vue` 初始化时会恢复本地保存的表格排序状态，并在用户切换排序后自动回写存储；这同时把之前遗留的 `readTableSortState / persistTableSortState / applyQueryState` 未接入问题一起收口了。

#### 12.6.11 本轮额外发现并处理的前端构建阻塞

- **`Settings.vue` 的设置对象读取需要显式宽化类型**:
  `useSettingStore()` 当前导出的 `settings` 类型仍偏向“全局设置”字段，不完全覆盖账号维度字段；本轮已改为在账号设置拼装函数内显式走 `any` 读取，保证运行时字段访问不阻塞 `vue-tsc`。
- **`Accounts.vue` 之前存在“半接入导致构建失败”的代码路径**:
  表格排序恢复、URL 查询恢复和批量结果提示这组函数原先存在接线不完整的问题；本轮已恢复初始化链路并保留批量操作提示与复制筛选链接入口，避免再触发 `TS6133`/`TS2304`。
- **`core/src/models/store.js` 有一处尾随空格会阻塞 `git diff --check`**:
  本轮已顺手清掉，避免后续继续影响发布前自检。

#### 12.6.12 本轮追加验证

- `pnpm -C web exec vue-tsc --noEmit`
- `pnpm -C web build`
- `git diff --check`

### 12.6.10 OpenViking 本地开发链路补充修正（2026-03-09）

#### 12.6.10.1 本轮新增修正

- **OpenViking 默认端口已统一改为 `5432`**:
  `aiStatus`、AI 守护脚本、上下文客户端、OpenViking Python 服务和相关测试/示例环境文件已统一切到 `http://localhost:5432`，避免继续与 macOS 自带 AirTunes 常见占用端口 `5000` 冲突。
- **根目录 AI 脚本已移除对 `axios` 的隐式依赖**:
  复测本地 AI 守护链路时发现，`scripts/service/ai-services-daemon.js` 与 `services/openviking/client.js` 在仓库根目录直接运行时会因找不到 `axios` 立即退出。现已改为使用 Node 内置 `fetch`，减少额外安装要求，也避免守护进程“刚拉起就秒退”的假启动。
- **运行配置已同步收口**:
  项目根 `.env`、`core/.env.ai`、`services/openviking/.env` 与 `.env.example` 已同步到 `5432`，避免默认值、模板文件和实际本地运行参数各说各话。

#### 12.6.10.2 本轮影响判断

- **对本地 AI 开发环境的影响**:
  重启本地 AI 守护或 OpenViking 后，健康检查和上下文客户端将默认改走 `5432`。如果用户机器上恰好有 PostgreSQL 占用该端口，则需要手动再改成其他未占用端口。
- **对主程序业务链路的影响**:
  这次调整仅作用于本地 OpenViking / AI 开发辅助链路，不影响农场调度、经营汇报和账号运行时逻辑。

#### 12.6.10.3 本轮补充验证

- `node --check core/src/controllers/aiStatus.js`
- `node --check scripts/service/ai-services-daemon.js`
- `node --check core/src/services/contextManager.js`
- `node --check services/openviking/client.js`
- `python3 -m py_compile services/openviking/app.py`

### 12.6.11 OpenViking 守护链路补充收口（2026-03-09）

#### 12.6.11.1 本轮新增修正

- **守护进程会先识别并接管已健康的 `5432` 实例**:
  `ai-services-daemon.js` 启动前会先做健康检查，若端口上已经有可用 OpenViking，则不再重复拉起第二个 Python 进程，避免“已有实例存活，但守护继续撞端口”的假启动。
- **启动成功判定改为“进程存活 + 健康就绪”**:
  原先固定等待后只要健康接口能通就记为成功，容易把旧实例的健康状态误当成新子进程成功。现在改为轮询子进程本身的退出状态，若提前退出会直接判定失败并回收。
- **状态输出补齐“外部实例”和“端口占用但不健康”两类场景**:
  `ai-autostart status` 与 `/api/ai/status` 新增端口占用识别，能区分“守护未运行但服务仍在外部运行”和“端口残留监听但健康检查失败”，减少排查歧义。
- **守护进程退出时会主动清理自己的 PID 文件**:
  `ai-services-daemon.js` 现在会在启动时覆盖写入 `logs/ai-daemon.pid`，并在退出时仅删除属于自身 PID 的文件，减少 stale pid 导致的误报。
- **新增 `doctor` 诊断入口**:
  `node scripts/service/ai-autostart.js doctor --cwd .` 会汇总守护状态、PID 文件、`5432/8080` 监听进程和最近日志，方便本地 AI 开发链路排查残留实例。
- **运行状态新增统一模式标识**:
  `status`、`doctor` 和 `/api/ai/status` 现在统一输出 `managed / managed_starting / external / conflict / offline` 模式，减少“同一现场不同地方显示不同结论”的情况。

#### 12.6.11.2 运行态发现

- **当前机器仍有历史残留实例占用 `5432`**:
  复测时 `lsof -nP -iTCP:5432 -sTCP:LISTEN` 仍能看到旧的 `services/openviking` Python 进程占口，但当前沙箱中的 `curl/fetch` 无法直接探活它，说明本次代码修正之外，还需要人工清理旧残留实例后才能得到完全干净的启停验证结果。
- **`8080` 的 AGFS 也曾出现残留占用**:
  启动日志里出现过 `AGFS port 8080 is already in use`。这类残留会让守护进程在 OpenViking 主进程尚未绑定 `5432` 前就提前失败，需要一起检查。

#### 12.6.11.3 本轮补充验证

- `node --check scripts/service/ai-services-daemon.js`
- `node --check scripts/service/ai-autostart.js`
- `node --check core/src/controllers/aiStatus.js`
- `node --test core/__tests__/ai-autostart-status.test.js`
- `git diff --check`
