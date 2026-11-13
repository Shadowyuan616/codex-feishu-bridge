# Codex Feishu Bridge

在飞书里操作开发机上**已有的 Codex session**：浏览目录与会话、查看最新进展、发送任务、
在运行中补充指令、处理审批或中断当前轮次。桥接服务常驻开发机，本地电脑或 SSH 断开后仍可使用。

```text
飞书 App ──长连接（仅出站）── lark-cli ── Codex Feishu Bridge ── Unix socket ── Codex daemon
                                                                              │
                                                     终端 codex --remote ──────┘
```

- **无需入站端口**：通过飞书长连接收发事件，开发机只需出站网络。
- **一台机器一个机器人**：每台开发机使用独立的飞书应用 / profile，切换机器人即切换机器。
- **与终端共享会话**：连接同一个 Codex daemon，不改变会话原有的模型、权限和工作目录。
- **不保存密钥**：凭据由 Codex CLI 和飞书 CLI 各自管理。

## 快速开始：让智能体安装

把下面的提示词发给能连接目标开发机、且支持 `SKILL.md` 的智能体（如 Codex）：

```text
请安装 https://github.com/Shadowyuan616/codex-feishu-bridge/tree/main/skills/install-codex-feishu-bridge 中的 Skill，并用它在我的开发机配置本项目；复用已有登录，不中断运行中的 session。
```

Skill 会先确认目标机器、允许操作的用户和项目目录，再完成安装、配置与验收；
浏览器登录、应用发布、管理员授权等需要你本人完成的步骤，会给出具体入口。

也可以手动安装 Skill：克隆仓库后，把 `skills/install-codex-feishu-bridge` 整个目录复制到
智能体的 Skill 目录，在新对话中调用 `$install-codex-feishu-bridge`。Codex 当前支持
`~/.agents/skills/`，部分版本使用 `${CODEX_HOME:-$HOME/.codex}/skills/`，以客户端实际识别的
目录为准。已有同名 Skill 时先比较，避免覆盖你的定制。
参考：[Skill 原文](skills/install-codex-feishu-bridge/SKILL.md) · [Codex Skill 文档](https://developers.openai.com/codex/skills)

## 在飞书里能做什么

| 操作 | 说明 |
| --- | --- |
| 选择目录 | 列出可用项目目录，每页 8 项，显示编号、末级目录名和完整路径。 |
| 选择会话 | 按 active → idle → notLoaded 排序，显示最近提示词摘要。 |
| 最新进展 | 在对话底部新发一张进展卡片，内容截至最新一条模型回复。 |
| 更多操作 | 服务状态、使用帮助、解除绑定、中断当前轮次（需二次确认）。 |
| 直接发文字 | 会话空闲时开始新一轮；运行中则补充到当前轮次。 |
| 审批 / 问答卡片 | 处理命令和文件变更的单次审批，以及结构化提问。 |

运行过程中，服务会更新原有状态卡片，最终回复按需分卡发送；只有点击“最新进展”才会新发快照，避免刷屏。

没有固定菜单时，可用文本命令：

| 命令 | 作用 |
| --- | --- |
| `/dirs` | 选择目录 |
| `/sessions [完整目录]` | 选择会话，可按目录筛选 |
| `/select 会话ID` | 载入指定会话 |
| `/status` | 最新进展 |
| `/more` | 更多操作 |
| `/unbind` | 解除绑定（不会中断 Codex 任务） |
| `/health` | 服务状态 |
| `/help` | 帮助 |

## 手动安装

> [!IMPORTANT]
> 以下步骤都在**运行 Codex 的目标开发机**上，以拥有现有 Codex 和飞书配置的**同一操作系统用户**执行。
> 多台机器分别安装，不共享 SQLite 状态目录。

### 1. 准备环境和代码

依赖：Git、Node.js 22.13+（推荐 Node 24）、Python 3.9+、支持 daemon / Unix socket 的
Codex CLI、支持 `event consume` 的飞书 CLI。

```sh
node --version
python3 --version
codex --version
lark-cli --version

git clone https://github.com/Shadowyuan616/codex-feishu-bridge.git
cd codex-feishu-bridge
npm ci --ignore-scripts
npm run build
```

缺少 CLI 时按官方方式安装；已安装且有任务在运行的环境直接复用，不要升级：

```sh
npm install -g @openai/codex
npx @larksuite/cli@latest install
```

来源：[Codex CLI](https://developers.openai.com/codex/cli) · [飞书官方 CLI](https://github.com/larksuite/cli)。
已验证版本：Codex daemon 0.162–0.165、飞书 CLI 1.0.97–1.0.98（不代表其他版本不兼容，以后续自检为准）。

### 2. 确认共享 Codex daemon

```sh
codex app-server daemon version
```

从输出中取得现有 daemon 的真实 control socket 路径，记为 `BRIDGE_SOCKET`
（通常是 Codex 主目录下的 `app-server-control/app-server-control.sock`，但不要凭默认路径猜测）。
`CODEX_HOME` 和操作系统用户必须与已有会话一致。

仅当机器上**没有 daemon、也没有需要保留的运行中会话**时，才登录并启动：

```sh
codex login
codex app-server daemon start
codex app-server daemon version
```

终端要与飞书共享会话，也需连接同一个 daemon：

```sh
# 替换为上一步核对的真实路径
BRIDGE_SOCKET="/absolute/existing-codex-home/app-server-control/app-server-control.sock"
codex --remote "unix://$BRIDGE_SOCKET" resume
```

本项目只载入已有会话。如果还没有会话，可先用
`codex --remote "unix://$BRIDGE_SOCKET" -C /absolute/project` 创建一个测试会话。

> [!WARNING]
> 在独立终端或其他 app-server 中运行的会话持有写锁，无法被接管。不要通过杀进程或重启 daemon
> 解决，应等该会话退出后再通过共享 daemon 恢复。详见 [协议与连接边界](docs/codex-protocol.md)。

### 3. 配置飞书机器人和事件

**准备 profile**

- 已有应用：直接使用已有 profile，不重建应用、不覆盖凭据。
- 新建应用：运行以下命令，按输出链接在浏览器中完成创建：

  ```sh
  lark-cli config init --new --name dev-a
  ```

- 已手动创建的应用：用 `lark-cli config init --name dev-a` 交互配置。

App Secret 只交给飞书 CLI 本地保存（非交互场景用 `--app-secret-stdin`），不要粘贴到聊天、
命令参数、README 或 Git。桥接使用 **bot 身份**，不需要日历、文档等用户 OAuth 授权。

**开通能力与权限**

在开发者后台开启机器人能力，确认你在应用可用范围内，并添加以下权限：

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收私聊消息 |
| `im:message:send_as_bot` | 以机器人身份发送消息 |
| `im:message:readonly` | 卡片回调及消息回读 |
| `application:bot.menu:write` | 配置个性化固定菜单 |

**配置长连接事件与回调**

在“事件与回调”中选择**长连接**方式：

- 事件订阅：`im.message.receive_v1`、`application.bot.menu_v6`
- 回调订阅：`card.action.trigger`（在回调配置中单独添加）

保存后按提示发布版本并完成审核。如仍缺权限，以 CLI 和后台提示为准。

**验证订阅**

消息能发送不代表按钮能点击。用短时消费者检查，缺项时 CLI 会给出配置指引：

```sh
BRIDGE_PROFILE="dev-a"
lark-cli --profile "$BRIDGE_PROFILE" event consume application.bot.menu_v6 --as bot --timeout 3s
lark-cli --profile "$BRIDGE_PROFILE" event consume card.action.trigger --as bot --timeout 3s
```

**获取你的 open_id**

同一用户在不同应用下的 open_id 不同，不要从其他配置复制。运行下面的只读监听，
然后用你本人的飞书私聊机器人发送“绑定”，确认发送者是你后记下返回的 `sender_id`：

```sh
lark-cli --profile "$BRIDGE_PROFILE" event consume im.message.receive_v1 \
  --as bot --max-events 1 --timeout 90s --jq '{sender_id,chat_type}'
```

### 4. 生成私有配置

选定允许操作的项目根目录和**本地持久状态目录**。

> [!WARNING]
> 状态库是 SQLite（WAL 模式），不要放在 NFS、GPFS 等共享文件系统上。Linux 可用
> `findmnt -T /chosen/state/parent` 检查。配置文件可以放在持久卷上。

把示例值替换为真实值后执行：

```sh
BRIDGE_CONFIG_DIR="$HOME/.config/codex-feishu-bridge"
BRIDGE_PROJECT="/absolute/project-root"
BRIDGE_STATE="/absolute/local-persistent/bridge-state"
BRIDGE_USER="ou_REPLACE_WITH_YOUR_OPEN_ID"

npm run configure -- \
  --host dev-a \
  --root "$BRIDGE_PROJECT" \
  --user "$BRIDGE_USER" \
  --socket "$BRIDGE_SOCKET" \
  --state-dir "$BRIDGE_STATE" \
  --profile "$BRIDGE_PROFILE" \
  --output "$BRIDGE_CONFIG_DIR"
```

该命令只生成文件，**不登录、不启动服务、不影响运行中的会话**。输出目录权限 `700`、文件 `600`，
已存在的文件不会被覆盖。

| 文件 | 内容 |
| --- | --- |
| `config.local.json` | 用户白名单、项目范围、CLI 路径和共享 socket |
| `bridge.env` | systemd 使用的运行路径 |
| `bot-menu.local.json` | 该用户的四项固定菜单 |

常用选项（完整列表见 `npm run configure -- --help`）：

- `--root`、`--user` 可重复指定；多用户会额外生成 `bot-menu-2.local.json` 等文件。
- CLI 不在 `PATH` 中时，用 `--lark-bin`、`--codex-bin`、`--python-bin` 指定绝对路径。
- 飞书配置绑定在特定工作目录时，用 `--lark-cwd` 指定。

手工编写可参考 [config.example.json](config.example.json)，其中的占位符无法通过校验。

### 5. 设置固定菜单

```sh
lark-cli --profile "$BRIDGE_PROFILE" api POST /open-apis/bot/v3/bot_menu \
  --as bot --params '{"user_id_type":"open_id"}' \
  --data "@$BRIDGE_CONFIG_DIR/bot-menu.local.json"
```

多用户时对每个菜单文件分别执行。四个菜单项为“选择目录、选择会话、最新进展、更多操作”，
对应推送事件 `codex_dirs`、`codex_sessions`、`codex_status`、`codex_more`。
如果应用已有自定义菜单，先备份并确认要替换该用户的菜单。

在手机上确认菜单常驻在输入框上方。如果显示为切换式菜单，在开发者后台把机器人自定义菜单
设为**悬浮菜单**并发布（需飞书 7.22+）。
参考：[菜单指南](https://open.feishu.cn/document/client-docs/bot-v3/bot-customized-menu) · [个性化菜单 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot_menu/set_bot_menu)

### 6. 自检与收发验收

```sh
npm start -- --config "$BRIDGE_CONFIG_DIR/config.local.json" --check-config  # 校验配置格式和目录
npm start -- --config "$BRIDGE_CONFIG_DIR/config.local.json" --doctor        # 检查 CLI 版本和 Codex 只读连接
npm start -- --config "$BRIDGE_CONFIG_DIR/config.local.json"                 # 前台运行
```

自检通过不等于飞书收发正常。前台服务就绪后：

1. 在飞书中选择目录和一个**独立的测试会话**。
2. 发送 `只回复 BRIDGE_OK，不要调用工具。`，确认收到回答卡片。
3. 点击“最新进展”，确认新发进展卡片。

若菜单订阅尚未生效，消息和卡片功能照常可用，菜单消费者每 60 秒重试，授权完成后自动接通。
完整清单见 [验收模板](docs/acceptance.md)。

### 7. 持久运行

验收通过后按 `Ctrl+C` 停止前台进程，再**选择一种**监督方式（不要让两个监督器管理同一实例）。

**方式 A：用户级 systemd**

```sh
mkdir -p "$HOME/.config/systemd/user"
# 已有同名服务时先比较和备份
cp -n deploy/codex-feishu-bridge.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now codex-feishu-bridge.service
systemctl --user status codex-feishu-bridge.service
```

- unit 默认读取 `~/.config/codex-feishu-bridge/bridge.env`；自定义了配置目录时，先修改其中的 `EnvironmentFile`。
- 登出后服务能否继续运行取决于 user manager / linger 配置；用户服务不可用时，可由管理员使用
  [system service 模板](deploy/codex-feishu-bridge-system.service)。
- 代理等额外环境变量只写入私有的 `bridge.env`，不要提交或修改系统全局配置。

**方式 B：无 systemd 的容器**

把以下命令交给平台的 startup hook 或已有进程管理器（使用核对后的绝对路径，不依赖交互式 shell 变量）：

```sh
python3 deploy/supervise.py \
  --state-dir "$BRIDGE_STATE/supervisor" \
  --log-dir "$BRIDGE_STATE/logs" \
  -- "$(command -v node)" "$PWD/dist/src/main.js" \
  --config "$BRIDGE_CONFIG_DIR/config.local.json"
```

> [!NOTE]
> `nohup` 只能防止 SSH 断开导致退出，不能在容器重建后自动启动。重建后的恢复还需规划代码、
> 配置、本地状态和 Codex daemon。详见 [部署说明](deploy/README.md) 和 [运维说明](docs/operations.md)。

**最终检查**

```sh
npm start -- --config "$BRIDGE_CONFIG_DIR/config.local.json" --health
```

确认三个事件消费者（消息、卡片回调、菜单）均为 ready、消息队列正常后，即可断开 SSH，用手机操作。

## 数据与权限边界

桥接会把所选会话的提示词、模型输出和审批内容发送到你配置的飞书应用。
`allowedUsers` 限制谁能操作，`allowedRoots` 限制可见的项目目录；二者**不替代** Codex 自身的
工具权限和审批设置。请只授权必要的人和目录。

- 本地 SQLite 含会话内容、用户标识和审批数据。配置、数据库、日志、备份和真实验收记录都不要公开；
  仓库的忽略规则和隐私扫描不能代替发布前的人工检查。
- 仅支持私聊文本和服务发出的卡片按钮；暂不支持群聊及图片、文件、语音输入。
- 只载入已有会话；不提供任意 shell / TUI、新建会话或修改模型设置的功能。
- 一个会话只绑定一个控制对话和操作者；未知类型的审批不会被自动批准。
- 指令提交后若回执丢失，会标记为“待核对”，恢复时不会自动重放。

## 开发与隐私检查

```sh
npm run check                                        # 类型检查
npm test                                             # 单元测试
npm run build
python3 -m unittest discover -s deploy -p 'test_*.py' # 监督器测试

npm run privacy:check                                # 扫描工作树
npm run privacy:check -- --staged                    # 提交前：仅扫描暂存文件
npm run privacy:check -- --history                   # 发布前：在完整克隆中扫描全部历史和提交邮箱
```

CI 会自动扫描工作树中的真实身份标识、密钥模式和运行文件。审计与历史清理方法见
[SECURITY.md](SECURITY.md)；提交作者建议使用 GitHub noreply 邮箱。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/remote-preflight.md](docs/remote-preflight.md) | 安装前检查 |
| [docs/codex-protocol.md](docs/codex-protocol.md) | Codex 会话连接与能力边界 |
| [docs/acceptance.md](docs/acceptance.md) | 分机器验收模板 |
| [docs/operations.md](docs/operations.md) | 部署、恢复与验收 |
| [deploy/README.md](deploy/README.md) | 持久运行方式 |
| [docs/open-source-selection.md](docs/open-source-selection.md) | 开源方案选型与卡片复用 |
| [SECURITY.md](SECURITY.md) | 隐私与安全维护 |

## 致谢与许可

卡片构建复用了 [飞书官方 OpenClaw 插件](https://github.com/larksuite/openclaw-lark) 固定版本中的
MIT 纯函数子集，不依赖完整的 OpenClaw。详见 [第三方声明](THIRD_PARTY_NOTICES.md) 与
[原始许可证](vendor/openclaw-lark/LICENSE)。
