# 部署、恢复与验收

本文描述当前实现的部署方法。具体机器的版本、路径、应用订阅和收发结果需要单独
记录；本文件不声称 dev-a、dev-c、dev-b 均已安装或验收。

## 每台机器的运行身份

每台开发机有自己的 worker、飞书应用/profile、允许的操作者、项目根目录和状态库。
worker 与目标 Codex daemon 使用同一操作系统用户，能够访问同一个 Unix socket。
确认实际 `HOME`、`CODEX_HOME`、Node 和 CLI 路径；SSH 默认登录环境未必与现有
Codex 进程一致。不要为方便部署覆盖现有 shell 配置、全局 Node、Codex 登录或任务。

为减少启动环境差异，Node、飞书 CLI、仓库、配置和 socket 均使用绝对路径。
共享模式设置 `codex.socketPath` 和空 `codex.args`。socket 使用 WebSocket 握手及
帧协议；`app-server proxy` 只是原始字节转发，并不是 JSONL 转换器。不要直接把
JSON 行写给 proxy。`--stdio` 仅是独立进程备选，无法共享另一进程中的活动会话。

worker 不负责启动、停止或升级已有共享 daemon。它退出时关闭自己的连接和飞书
消费者；由 Codex daemon 承载的任务不应被当作 worker 子进程管理。

## 状态与文件系统

`stateDir` 保存 `state.sqlite`、WAL/SHM 辅助文件、实例锁和 `health.json`，必须是
本机专用、权限为 0700 的目录。配置、数据库、日志按 0600 管理。配置及状态中有
对话内容和授权标识，不提交到 Git。

SQLite WAL 依赖同主机共享内存与文件锁语义，应将活跃数据库放在已经核验的本地
XFS/ext4 等文件系统，**不要放在 GPFS/NFS 或未经验证的跨主机共享文件系统**。
“集群持久卷”不自动等于适用的 SQLite WAL 存储。先查挂载类型和实际设备，再选
`stateDir`。代码和非秘密模板可以留在集群共享卷；配置、日志和数据库按各自要求
放置，不因它们属于同一个项目而强制放在同一卷。

本地磁盘是否在开发容器重建后保留，必须由平台配置或重建验收证明。若只有临时
本地盘，可以先实现进程恢复，但不能宣称机器重建后数据仍在。备份活跃 SQLite
应使用 SQLite 一致性备份方法，或停掉本 worker 后备份完整状态；不要只复制活跃
数据库主文件而漏掉 WAL。备份恢复只做单机单实例恢复，不能两台机器同时写一个库。

## 首次运行

在仓库内执行：

```sh
npm ci
npm run build
npm test
python3 -m unittest discover -s deploy -p 'test_*.py'
cp config.example.json config.local.json
chmod 600 config.local.json
```

修改全部样例占位符。`allowedUsers` 必须填真实 `ou_...` open_id；
`ou_REPLACE_WITH_YOUR_OPEN_ID` 不是真实用户，验证失败是预期行为。
`allowedRoots` 必须已经存在，配置会解析符号链接后的真实路径。

```sh
npm start -- --config /absolute/path/config.local.json --check-config
npm start -- --config /absolute/path/config.local.json --doctor
npm start -- --config /absolute/path/config.local.json
```

前两个命令分别验证配置与 Codex 只读连接。`--doctor` 不订阅飞书事件、不发测试
消息、不验证 app secret 或机器人权限。前台运行成功后，仍需从飞书私聊执行
`/help`、点击目录/会话按钮，并在明确的测试会话里检查完整收发。

## 飞书权限与订阅

现有应用“能够发消息”并不证明“能够接收指令”。核对机器人能力、用户可用范围、
已配置 bot 身份和实际 `profile`。文本私聊路径使用消息接收和机器人发送权限；
当前 CLI 回调消费者还要求 `im:message:readonly`。缺少哪些权限以 CLI 的结构化
错误和开放平台为准，不为未来功能批量申请群聊、文件或通讯录权限。

- 事件：`im.message.receive_v1`，长连接模式。
- 菜单事件：`application.bot.menu_v6`，长连接模式。
- 回调：`card.action.trigger`，在回调配置中单独订阅。
- 权限/订阅变更后发布新应用版本，完成组织所需审核，再重新验证。

服务会等待消息和卡片消费者都报告 ready。菜单订阅尚未开通时，保留原有收发，
菜单消费者每 60 秒重新检查，授权后自动恢复；`lark.ready` 在三种消费者全部
就绪后才为 true。卡片能发出但按钮失效时，先检查回调订阅与
发布状态。消息和卡片回调共享 CLI 事件基础设施；不要在本项目排障时停止其他
应用或已有会话使用的共享 event bus。

### 输入框固定菜单

固定四项：**选择目录、选择会话、最新进展、更多操作**，分别配置推送事件
`codex_dirs`、`codex_sessions`、`codex_status`、`codex_more`。不要设置成发送
文字消息。仅允许白名单用户的这四种菜单事件；其他 event key 不会作为模型指令。

开发者后台可在机器人自定义菜单中选择 **悬浮菜单**（飞书 7.22+），发布后生效。
CLI 创建的应用也可使用 `deploy/bot-menu.example.json`，替换为该应用下实际的
用户 open_id，通过官方个性化机器人菜单 API 配置仅此用户可见的四项菜单：

```sh
lark-cli --profile YOUR_PROFILE api POST /open-apis/bot/v3/bot_menu \
  --as bot --params '{"user_id_type":"open_id"}' --data @bot-menu.local.json
```

该 API 要求 `application:bot.menu:write`，响应应逐项核对名称和 `event_key`；
单独 GET 需要 `application:bot.menu:readonly`。个性化接口没有展示样式参数，
需在手机端确认常驻输入框上方。不要把有不同权限和应用来源限制的 v7 应用管理
API 当作同一接口。原菜单如果存在，应先保存可恢复的配置。

菜单事件还需要单独订阅。运行 `lark-cli event consume application.bot.menu_v6
--as bot --timeout 3s` 检查；若提示 `failed_precondition`，使用 CLI 返回的
官方授权链接为已有应用增量添加该事件。此流程需要应用操作者本人确认；不要
因此覆盖其他事件或卡片回调。确认后本服务自动重试连接，无需重启 Codex。

菜单事件本身不带 chat_id。服务只从已验证的用户单聊历史恢复映射，或向该允许
用户发送一次带幂等标识的欢迎消息，从回执取得真实单聊 ID。解绑保留此映射，
因此之后仍可点击固定菜单。菜单不会创建群聊。

主动点击“最新进展”、输入 `/status` 或点卡片刷新时，在聊天底部发送一张新的
进展快照；同一事件重投只发送一次。后台仍原位更新原状态卡片，避免轮询刷屏。
“更多操作”的中断入口需确认具体会话和轮次，旧确认卡片不能停止后续新轮次。

目录和会话选择均每页显示 8 项，提供上一页、下一页；条目旁的全宽按钮使用与
标题相同的“序号＋名称”，避免手机端三列按钮把名称截成相同开头。目录以末级
名称为标题，完整路径作为次级信息。会话先去重，再按 active、idle、notLoaded
排序，同一状态按最近更新时间排序；active 标题为绿色，其他状态为灰色。
会话卡片展示最近一条用户输入的开头，不重复显示目录或会话 ID。

最近提示词通过只读历史分页取得，优先从 `thread/items/list` 倒序查找，包括
同一轮中后来追加的输入；`thread.preview` 通常是首条输入，不能替代最近提示词。
仅为当前页读取摘要，限制并发和总耗时。图片消息使用占位说明，读取失败则明确
提示暂不可用。列目录、列会话和读取摘要不会恢复、订阅或中断这些 session；
真实路径和会话 ID 仍保存在按钮回调中，用于精确选择。

官方参考：[菜单使用指南](https://open.feishu.cn/document/client-docs/bot-v3/bot-customized-menu)、
[个性化菜单 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot_menu/set_bot_menu)、
[菜单事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v6/bot/events/menu)。

## 持续运行的两种方式

### 可用的用户 systemd

仓库提供 `deploy/codex-feishu-bridge.service` 与 `deploy/bridge.env.example`。
按机器真实路径填写环境文件，再安装到该用户的 systemd 目录：

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-feishu-bridge.service
systemctl --user status codex-feishu-bridge.service
```

这些命令是管理员/操作者的安装步骤，不因文档存在而已经执行。用户 systemd 在
登出后是否存续依赖平台的 user manager/linger 配置。服务与 supervisor 共用锁，
不要再给同一 worker 启动第二套监督器。

### 没有 systemd 的开发容器

Python 3.9+ 可运行仓库自带监督器：

```sh
python3 /absolute/repo/deploy/supervise.py \
  --state-dir /absolute/local-persistent/bridge-state/supervisor \
  --log-dir /absolute/private/logs/codex-feishu-bridge \
  -- /absolute/node /absolute/repo/dist/src/main.js \
  --config /absolute/private/config.local.json
```

监督器使用独占锁，worker 退出后以 1–60 秒退避重启；稳定两分钟后重置退避。
日志每份默认 5 MiB，保留三份轮转备份。只停止自己创建的 worker 进程组，不停止
独立存在的共享 Codex daemon。`supervisor.lock` 文件正常退出后仍保留，文件存在
并不代表锁还被持有；不要只凭旧 PID 文件终止一个进程。

`nohup` 只解决 SSH 断开，**不提供容器重建后的启动机制**。无 systemd 的机器还
需接入集群提供的持久 startup hook 或已有进程管理器，确保网络、持久卷、身份
环境与 daemon 可用后启动监督器。这个 hook 尚需按平台实际能力配置和验证。

## 健康检查与故障处置

```sh
npm start -- --config /absolute/path/config.local.json --health
```

`health.json` 每 10 秒更新，超过 60 秒未更新会报告 `stale: true` 并返回非零。
飞书 `/health` 能查看连接状态、待处理指令、结果不确定的指令和未送达卡片数量。
健康快照只能证明进程近期报告了状态，不替代一次真实收发。

| 现象 | 检查与处置 |
| --- | --- |
| worker 不能启动 | 检查 Node 版本、绝对路径、配置占位符、工作目录、状态目录及已有实例锁。 |
| Unix socket 连接失败 | 检查同用户、socket 真实路径、权限和 daemon 状态；不要自动回退 stdio 或重启承载任务的 daemon。 |
| 会话 writer conflict | 目标会话被独立客户端持有；等它安全退出后，通过共同 daemon 恢复。不能强杀进程来“接管”。 |
| 能发卡片但收不到消息/按钮 | 检查 bot 权限、两种消费者、应用可用范围、事件/回调分别订阅以及应用版本发布。 |
| “请求结果需核对” | 先读 `/status` 和实际文件/任务状态，再决定是否重新输入；服务不会重放这条模型指令。 |
| 审批按钮过期 | 断线、另一个客户端处理过请求或绑定改变都会使旧按钮失效；重新查看当前会话，不能复用旧 token。 |
| “未支持的交互” | 在连接同一 daemon 的终端处理该 MCP/权限请求。 |
| 持续 unsent | 检查发送权限、网络与脱敏日志；新消息无回执且超过约 50 分钟重试窗口时会冻结，需人工核对实际消息，避免重复发送。 |

暂时网络失败会退避重试。认证/权限错误不会自动执行登录或扩大权限。不要在日志
里启用原始令牌、凭据、全部 RPC 或完整对话调试输出。只重启本 bridge worker，
不改变正在运行的训练、传输、其他 Codex 会话或共享控制文件。

## 分机器验收清单

1. 记录机器标识、用户、Node/Codex/飞书 CLI 版本、socket、profile 和文件系统类型。
2. 验证指定操作者能收到菜单和状态卡；未授权用户、群聊和转发卡片不能执行命令。
3. 验证目录过滤、选择既有 session、工作目录与最新进展都对应同一会话。
4. 在指定测试会话发送一条无副作用任务，确认输入、输出、最终卡片与服务器历史一致。
5. 验证运行中补充、单次批准/拒绝、问答以及中断；旧会话卡不得操作新绑定。
6. 重启本 worker，验证绑定和投递恢复；提交结果不确定的指令不得重放。
7. 断开 Mac/SSH 后，从手机确认服务仍可收发。
8. 整机/容器重建验收另行安排安全窗口；先验证 startup hook、存储保留和 daemon
   恢复，再声称重建自动恢复。不能为测试中断生产任务。

持久化和幂等保护减少重复执行风险，但不承诺任意外部操作恰好执行一次。请将实际
回执和测试结果与部署机器一起记录，而不是用模拟测试结果代替线上验收。
