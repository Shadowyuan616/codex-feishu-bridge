# Codex 会话连接与能力边界

2026-10-30 核对：本机 `codex-cli 0.147.0` 帮助、其生成的 JSON Schema、OpenAI 官方文档及 `rust-v0.147.0` 源码；另经 dev-a 0.165 的只读探测纠正传输层。部署时仍需核对各开发机实际版本；协议标记为 experimental 的字段会变化。

## 同一个会话需要同一个运行中的服务

每台开发机复用一个独立于飞书 worker 的已有 Codex daemon。worker 配置 `codex.socketPath`，由 `SocketCodexClient` 通过 Unix socket 上的 WebSocket 连接 daemon；关闭或重启 worker 只关闭自己的连接，不停止 daemon。配置中不自动回退为 `codex app-server --stdio`。

**Unix control socket 并非逐行 JSON。** 已核验版本在该 socket 上完成 HTTP WebSocket 升级，然后在 WebSocket 消息中传 JSON RPC。`codex app-server proxy --sock ...` 是原始字节隧道，不能把它当作 JSONL 子进程直接发 `initialize`。`SocketCodexClient` 用 `ws` 库执行完整握手；`CodexClient` 仅用于明确选择的独立 `app-server --stdio` 后端，该独立模式不能附着另一个进程的活动会话。

终端也应连接同一 daemon：

```sh
codex --remote unix:// resume SESSION_ID
```

`unix://` 使用 Codex 默认 socket；自定义 socket 时终端用 `--remote unix:///absolute/socket`，worker 配置 `socketPath: "/absolute/socket"`。部署时保证相同用户、`CODEX_HOME`、Codex 版本和 socket。本项目的服务模板不会启动、停止或重启现有 daemon。若机器没有 daemon，需要另行规划首次启动及历史会话迁移，不能为了安装桥接服务重启已承载任务的 daemon。

0.147.0 的普通 TUI 只有在发现已有默认 daemon 且启动配置可重放时才复用它。某些 `-c`、profile 和其他启动覆盖会使 TUI 使用嵌入的独立服务。因此，**一个已在独立终端进程中运行的会话，不能被另一个 app-server 强制接管**。它可以读历史，但恢复写入会遇到 `thread <id> already has an active writer`。需等该会话安全退出后再通过共同 daemon 恢复；不复制日志，不创建替代会话伪装接管，不杀已有任务。

官方源码证据：[TUI 连接选择](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/tui/src/lib.rs#L836)、[运行会话附着](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/tui/src/lib.rs#L1731)、[独立进程写锁测试](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/thread_resume.rs#L262)。

## 协议与会话导航

共享 daemon 使用 WebSocket 消息中的 JSON RPC；只有独立 stdio 模式使用逐行 JSON。每条连接先 `initialize`，等待成功后发送 `initialized`；连接能力设 `experimentalApi: true`。客户端请求 ID、服务端审批 ID、飞书消息 ID 属于不同命名空间。

| 操作 | 方法与关键参数 |
| --- | --- |
| 列会话 | `thread/list`: `limit`, `cursor`, `sortKey: "updated_at"` |
| 按目录筛选 | `thread/list`: `cwd`，精确路径匹配 |
| 只读历史 | `thread/read`: `threadId`, `includeTurns: true` |
| 恢复并订阅 | `thread/resume`: `threadId` |
| 新指令 | `turn/start`: `threadId`, `input: [{type: "text", text: "..."}]` |
| 运行中调整 | `turn/steer`: `threadId`, `expectedTurnId`, `input` |
| 中断 | `turn/interrupt`: `threadId`, `turnId` |

会话列表应传 `modelProviders: []`，并显式列出所支持的 `sourceKinds`（如 `cli`, `vscode`, `appServer`, `exec`），避免默认筛选遗漏会话。分页游标是不透明值，不从会话 ID 自行构造。恢复时不覆盖原模型、权限或工作目录。

`thread/read` 不订阅事件。`thread/resume` 会附着并订阅已有运行会话，重放待审批项。`thread/loaded/list` 只反映当前连接的服务内存，不能据此判断另一独立进程是否占用会话。运行中调整必须使用刚读取的 turn ID；ID 过期后刷新状态，不把旧调整静默发给下一轮。

0.147.0 的 `thread/turns/list`、`excludeTurns` 等字段需要 experimental 能力。桥接先读 `thread/read` 元数据，再用 `thread/turns/list` 的 `limit: 2`、`sortDirection: "desc"`、`itemsView: "full"` 获取最新两轮，避免每次轮询下载全部历史。只在明确的 method-not-found（或指明该方法的 unknown variant）时退回 `thread/read includeTurns: true`；超时、权限错误或不支持某种存储格式不会触发全历史重试。旧服务器的全历史回退仍受 8 MiB 单帧限制，超限应升级服务端分页能力。生成完整 schema：

```sh
codex app-server generate-json-schema --experimental --out /path/to/schema
```

## 输出、审批与恢复

- `item/agentMessage/delta` 提供 `{threadId, turnId, itemId, delta}`。流式卡片需要节流，以 `item/completed` 的完整文本收尾。
- `turn/completed` 表示一轮结束，应区分完成、失败、中断；不要全部显示成成功。
- `thread/status/changed` 提供等待审批等状态。
- `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 是服务端请求。返回同一个请求 ID：`{"id": 123, "result": {"decision": "accept"}}`，或 `decline`/`cancel`，仅呈现该版本支持的选项。
- `item/tool/requestUserInput` 的回答结构为 `{"answers":{"question_id":{"answers":["回答"]}}}`。问题 ID 不等于请求 ID。
- `serverRequest/resolved` 携带 `{threadId, requestId}`；另一客户端完成审批后应立即使飞书旧按钮失效。

待审批项可能在 `thread/resume` 后重放，应以服务器请求身份去重。审批按钮必须绑定用户、机器、连接代次、thread、turn 和请求，不能批准“最近一个请求”。未实现的权限/MCP 交互须明确显示不支持，不得自动批准。官方测试：[命令审批重放](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/thread_resume.rs#L3878)、[文件审批重放](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/thread_resume.rs#L4015)。

连接断开或超时意味着执行结果可能未知。两种客户端都拒绝未完成请求，不自动重连和重放；主服务可由 supervisor 恢复，恢复后先查历史与运行状态。即使有 `clientUserMessageId` 也不能据此假定服务端提供完整幂等事务。需要持久 inbox/outbox，并对状态不明的用户指令执行对账。

JSON 解析器拒绝非协议数据、超长帧及无限积压；stdio 模式的 stderr 只排空，不记录凭据或模型全文。共享模式终止只关闭本客户端的 WebSocket；stdio 模式只终止自己创建的独立子进程。

daemon 故障仍可能中断模型 turn；历史可恢复不等于所有外部操作都恰好执行一次。飞书可以覆盖会话、消息、进展、审批和中断等语义交互；终端像素 UI 与任意交互式程序是另外的能力，不能笼统宣称完全等价。

参考：[官方 App Server 文档](https://developers.openai.com/codex/app-server)、[Unix socket WebSocket 实现](https://github.com/openai/codex/blob/main/codex-rs/app-server-transport/src/transport/unix_socket.rs)。代码测试覆盖模拟 JSONL 子进程和真实临时 Unix WebSocket 服务（包括多客户端和关闭一个连接后服务继续响应）；不把模拟通过描述为真实飞书联调成功。
