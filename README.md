# Codex Feishu Bridge

在手机飞书里选择开发机上的**已有 Codex session**、查看最新进展、发送任务或补充
运行中的指令。开发机持续运行桥接服务，Mac 和 SSH 断开后仍可使用。

每台机器使用自己的飞书机器人/profile，连接该机已有的 Codex daemon；切换机器人
就是切换机器。只需要出站网络，不需要开放公网入站端口。

## 让智能体安装

复制这段提示词给能连接目标开发机的 Codex 或其他支持 `SKILL.md` 的智能体：

```text
请安装 https://github.com/Shadowyuan616/codex-feishu-bridge/tree/main/skills/install-codex-feishu-bridge 中的 Skill，并用它在我的开发机配置本项目；复用已有登录，不中断运行中的 session。
```

Skill 会先确认目标机器、允许控制的用户和项目目录，再安装、配置和验证。
浏览器登录、应用发布或管理员授权需要你本人完成时，它会给出具体入口。

也可以克隆仓库后，将 `skills/install-codex-feishu-bridge` 整个目录复制到智能体
支持的 Skill 目录，再在新对话中调用 `$install-codex-feishu-bridge`。
例如 Codex 当前支持 `~/.agents/skills/`；已有版本也可能使用
`${CODEX_HOME:-$HOME/.codex}/skills/`，以当前客户端发现到的 Skill 目录为准。
安装已有同名 Skill 前先比较，避免覆盖你的定制版本。
[Skill 原文](skills/install-codex-feishu-bridge/SKILL.md) · [Codex Skill 文档](https://developers.openai.com/codex/skills)

## 你能在飞书里做什么

| 入口 | 行为 |
| --- | --- |
| 选择目录 | 编号＋末级目录名，下方展示完整路径；每页 8 项。 |
| 选择会话 | 按 active → idle → notLoaded 排序；显示最近提示词摘要，编号与选择按钮对应。 |
| 最新进展 | 在对话底部新发进展卡片，展示范围以最新模型回复为终点。 |
| 更多操作 | 服务状态、帮助、解除绑定、中断当前轮次；菜单中断需要再次确认。 |
| 直接发送文字 | 空闲时开始新一轮；运行中补充给当前轮次。 |
| 审批或问答卡片 | 处理支持的命令/文件单次审批与结构化用户问答。 |

没有固定菜单时，也可以发送 `/dirs`、`/sessions`、`/status`、`/more`。
`/sessions /完整目录` 按目录筛选；`/select 会话ID` 载入指定会话。
`/unbind` 解除绑定，`/health` 查看服务状态。后台自动更新原状态卡片，最终回复按需
分卡发送；主动点击“最新进展”才新发快照，避免轮询刷屏。

## 手动安装

以下步骤都在**运行 Codex 的目标开发机**上完成，并使用拥有既有 Codex 和飞书配置
的同一操作系统用户。多台机器分别执行，不共享 SQLite 状态目录。

### 阶段 1：准备环境和代码

需要 Git、Node.js **22.13+**（推荐已安装的 Node 24）、Python **3.9+**，以及支持
daemon/Unix socket 的 Codex CLI 和支持 `event consume` 的飞书 CLI。

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

缺少 CLI 时，按官方方式安装；已经安装并在运行任务的环境直接复用，不自动升级：

```sh
npm install -g @openai/codex
npx @larksuite/cli@latest install
```

来源：[Codex CLI](https://developers.openai.com/codex/cli)、[飞书官方 CLI](https://github.com/larksuite/cli)。
本项目曾在 Codex daemon 0.162–0.165、飞书 CLI 1.0.97–1.0.98 上验证；这些是已测版本，
不代表对其他版本的完整兼容承诺。当前安装以命令能力和后续自检为准。

### 阶段 2：确认共享 Codex daemon

```sh
codex app-server daemon version
```

使用输出中已有 daemon 的真实 control socket，记为 `BRIDGE_SOCKET`。它通常位于
Codex 主目录的 `app-server-control/app-server-control.sock`，不要仅凭默认路径猜测。
`CODEX_HOME`、操作系统用户与已有会话必须一致。

仅在**尚无 daemon、也没有需要保持的独立运行会话**的新环境中，先按提示登录，再启动：

```sh
codex login
codex app-server daemon start
codex app-server daemon version
```

以后在终端与飞书共享会话时，终端也连接同一个 daemon：

```sh
# 把路径替换为上一步核对的真实 socket
BRIDGE_SOCKET="/absolute/existing-codex-home/app-server-control/app-server-control.sock"
codex --remote "unix://$BRIDGE_SOCKET" resume
```

如果没有已有 session，可用 `codex --remote "unix://$BRIDGE_SOCKET" -C /absolute/project`
先建立一个测试会话。本项目只选择已有会话。
正在独立终端/其他 app-server 中运行的会话不能被强行接管；不要杀进程或重启 daemon
来解决写锁问题。更多说明见 [协议与连接边界](docs/codex-protocol.md)。

### 阶段 3：配置飞书机器人和事件

**已有应用**：使用已有 profile；不重新创建应用、不覆盖凭据。
**新应用**：可以通过 CLI 创建一个命名 profile，按输出链接在浏览器完成：

```sh
lark-cli config init --new --name dev-a
```

已有手工创建的应用也可用 `lark-cli config init --name dev-a` 交互配置。
App Secret 只交给飞书 CLI 的本地凭据管理；非交互配置使用其 `--app-secret-stdin`，
不把密钥粘贴到聊天、命令参数、README 或 Git。桥接使用 **bot 身份**，不需要为了
此功能额外执行面向日历/文档等功能的用户 OAuth 授权。

在应用后台开启机器人能力，确认你在应用可用范围内。按功能添加以下权限：

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收私聊消息 |
| `im:message:send_as_bot` | 机器人发送消息 |
| `im:message:readonly` | 当前 CLI 卡片回调及消息回读 |
| `application:bot.menu:write` | 配置四项个性化固定菜单 |

在“事件与回调”中配置**长连接**：

- 事件订阅：`im.message.receive_v1`、`application.bot.menu_v6`。
- 回调订阅：`card.action.trigger`，它在回调配置中单独添加。
- 保存，并按后台提示发布版本、完成审核。缺少权限以当前 CLI 和后台提示为准。

只发送成功不代表按钮能点击。可以用短时消费者检查订阅；缺项时 CLI 会给出授权或
配置指引，按它补齐对应项目：

```sh
BRIDGE_PROFILE="dev-a"
lark-cli --profile "$BRIDGE_PROFILE" event consume application.bot.menu_v6 --as bot --timeout 3s
lark-cli --profile "$BRIDGE_PROFILE" event consume card.action.trigger --as bot --timeout 3s
```

取得**该应用下你自己的 open_id**：在开发机执行下面的只读监听，然后由你在飞书私聊
该机器人发送“绑定”。核对发送者是你本人，把返回的 `sender_id` 私下填入下一步。
不同应用下的 open_id 可能不同，不要从别人的配置复制。

```sh
lark-cli --profile "$BRIDGE_PROFILE" event consume im.message.receive_v1 \
  --as bot --max-events 1 --timeout 90s --jq '{sender_id,chat_type}'
```

### 阶段 4：生成私有配置

先选好允许操作的项目根目录，以及可靠的**本地持久状态目录**。
Linux 可用 `findmnt -T /chosen/state/parent` 检查存储；SQLite WAL 状态库不要放到
NFS/GPFS 等共享文件系统。配置可放持久卷，状态数据库的存储条件需独立核实。

将示例中的路径和用户 ID 换成真实值：

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

此命令只生成文件，**不登录、不启动服务、不修改正在运行的 session**：

- `config.local.json`：用户白名单、项目范围、CLI 路径和共享 socket。
- `bridge.env`：供 systemd 使用的运行路径。
- `bot-menu.local.json`：该用户的四项菜单配置。

输出目录权限为 `700`，文件为 `600`；已有文件会拒绝覆盖。
支持重复 `--root`、`--user`；多用户会额外生成 `bot-menu-2.local.json` 等文件。
CLI 不在 PATH 时可用 `--lark-bin`、`--codex-bin`、`--python-bin` 指定绝对路径；
工作区绑定的飞书配置可补 `--lark-cwd`。完整选项：`npm run configure -- --help`。
手工配置可参考 [config.example.json](config.example.json)，占位符不能通过校验。

### 阶段 5：设置四个固定菜单

```sh
lark-cli --profile "$BRIDGE_PROFILE" api POST /open-apis/bot/v3/bot_menu \
  --as bot --params '{"user_id_type":"open_id"}' \
  --data "@$BRIDGE_CONFIG_DIR/bot-menu.local.json"
```

多用户时对各自的菜单文件分别执行。四项名称为“选择目录、选择会话、最新进展、
更多操作”，使用推送事件 `codex_dirs`、`codex_sessions`、`codex_status`、`codex_more`。
应用已有自定义菜单时，先保留现有配置，确认本次是要替换该用户菜单。

在手机上确认菜单常驻输入框上方。此个性化接口没有展示策略参数；若客户端显示为
切换式菜单，在开发者后台将机器人自定义菜单设为**悬浮菜单**并发布，要求飞书 7.22+。
[官方菜单指南](https://open.feishu.cn/document/client-docs/bot-v3/bot-customized-menu) ·
[个性化菜单 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot_menu/set_bot_menu)

### 阶段 6：前台自检和真实收发

```sh
npm start -- --config "$BRIDGE_CONFIG_DIR/config.local.json" --check-config
npm start -- --config "$BRIDGE_CONFIG_DIR/config.local.json" --doctor
npm start -- --config "$BRIDGE_CONFIG_DIR/config.local.json"
```

`--check-config` 验证格式和目录；`--doctor` 检查 CLI 版本和 Codex 只读连接。
它们都不能替代飞书收发验收。前台服务就绪后，在飞书选择目录与**独立测试 session**，
发送 `只回复 BRIDGE_OK，不要调用工具。`，确认回答卡片到达，再点击“最新进展”。

菜单订阅未完成时，现有消息/卡片功能继续运行，菜单消费者每 60 秒重试；完成授权后
自动接通。完整模板见 [验收清单](docs/acceptance.md)。

### 阶段 7：持久运行

前台验收通过后，用 Ctrl+C 停止**桥接前台进程**，再选择一种监督方式。

**有用户 systemd：** 默认配置生成目录可直接配合仓库模板。

```sh
mkdir -p "$HOME/.config/systemd/user"
# 若已有同名服务，先比较和备份，不覆盖正在管理的实例。
cp -n deploy/codex-feishu-bridge.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now codex-feishu-bridge.service
systemctl --user status codex-feishu-bridge.service
```

自定义了配置输出目录时，先修改 unit 中的 `EnvironmentFile` 为真实 `bridge.env`。
用户服务能否登出后存活取决于 user manager/linger；需要管理员协助时只处理该服务。
不能使用用户 systemd 时，可由管理员采用 [system service 模板](deploy/codex-feishu-bridge-system.service)。
代理或其他必要环境只写到私有 `bridge.env`，不要提交、打印或覆盖系统全局配置。

**无 systemd 的容器：** 将下列命令交给平台 startup hook 或已有进程管理器：

```sh
python3 deploy/supervise.py \
  --state-dir "$BRIDGE_STATE/supervisor" \
  --log-dir "$BRIDGE_STATE/logs" \
  -- "$(command -v node)" "$PWD/dist/src/main.js" \
  --config "$BRIDGE_CONFIG_DIR/config.local.json"
```

在 startup hook 中使用核对后的绝对路径，不依赖交互 shell 的变量。
`nohup` 仅能防 SSH 断开，不能保证容器重建后自动启动；重建恢复还需要代码/配置、
本地状态和 Codex daemon 的恢复方案。不要同时启动两个监督器管理同一实例。
详见 [部署说明](deploy/README.md)与[运维说明](docs/operations.md)。

安装后在另一终端检查：

```sh
npm start -- --config "$BRIDGE_CONFIG_DIR/config.local.json" --health
```

确认三种消费者 ready、消息队列正常，再断开 SSH 用手机操作。

## 数据与权限边界

桥接会把所选 session 的提示词、模型输出和审批内容发送到你配置的飞书应用。
`allowedUsers` 限制操作者，`allowedRoots` 限制可见项目目录；它们不替代 Codex
原有的工具权限和审批设置。只给需要的人和目录授权。

- 凭据由 Codex/飞书 CLI 管理，本项目不需要保存 App Secret 或 OpenAI API Key。
- 本地 SQLite 含会话内容、用户标识和审批数据；配置、数据库、日志、备份和真实验收
  记录都不能公开。仓库附带忽略规则和隐私扫描，但它们不能代替发布前人工检查。
- 支持私聊文本及服务发出的卡片按钮；群聊和输入图片/文件/语音尚不支持。
- 只载入已有 session，不提供任意 shell/TUI、创建 session 或修改模型设置的完整界面。
- 一个 session 绑定一个控制对话和操作者；未知审批类型不会被自动批准。
- 指令提交后回执丢失会标记结果待核对，不在恢复时盲目重放。

## 开发、隐私检查与复用

```sh
npm run check
npm test
npm run build
python3 -m unittest discover -s deploy -p 'test_*.py'
npm run privacy:check
# 发布前：完整克隆中检查全部可达历史与提交邮箱
npm run privacy:check -- --history
# 提交前只检查暂存文件
npm run privacy:check -- --staged
```

CI 自动扫描工作树中的真实身份标识、秘密模式和运行文件。独立审计与历史清理方法见
[SECURITY.md](SECURITY.md)。提交作者建议使用 GitHub 提供的 noreply 邮箱。

卡片构建复用[飞书官方 OpenClaw 插件](https://github.com/larksuite/openclaw-lark)固定版本
的 MIT 纯函数子集，不依赖整个 OpenClaw。保留[第三方声明](THIRD_PARTY_NOTICES.md)
及[原始许可证](vendor/openclaw-lark/LICENSE)。
交互方案与其他开源实现的取舍见[选型记录](docs/open-source-selection.md)。
