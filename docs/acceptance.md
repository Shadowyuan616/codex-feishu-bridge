# 联调验收记录

记录时间：2026-10-30（Asia/Shanghai）。

## 自动验证

- TypeScript 检查与构建通过。
- Node 测试 75/75：覆盖真实临时 Unix WebSocket 服务、JSONL 子进程、飞书 CLI 子进程、消息去重、会话绑定、审批归属、旧卡片隔离、发送重试、流式输出与崩溃锁恢复。
- Python supervisor 测试 2/2：重复启动排他、停止与进程恢复行为。
- GitHub Actions 已在 Node 22 / 24 上通过：[运行记录](https://github.com/Shadowyuan616/codex-feishu-bridge/actions/runs/40932948629)。

## dev-a：真实闭环通过

使用该机器原有 Codex daemon 0.165.0、飞书 CLI 1.0.97 和 Node 24.18.0。

| 检查 | 实测结果 |
| --- | --- |
| 连接现有共享 daemon | Unix WebSocket initialize 成功；未重启 daemon |
| 目录与会话数据 | thread/list、thread/read、最近两轮分页成功 |
| 文本接收 | im.message.receive_v1 返回 ready |
| 卡片回调 | 用户补齐订阅后，card.action.trigger 返回 ready |
| 卡片发送 | 消息 ID 回执成功；飞书读回 interactive 且 deleted=false |
| 真实用户选择 session | 用户点击菜单，绑定到独立的只读联调会话 |
| 真实用户提交指令 | 飞书消息进入该会话的一轮 userMessage |
| 模型回答 | completed，agentMessage 精确为 FEISHU_BRIDGE_OK |
| 回答送达 | 回答卡片从飞书读回，包含 FEISHU_BRIDGE_OK |
| worker 重启 | 新 PID、双 consumer ready、绑定恢复、模型轮次 ID 完全不变 |
| 待发送与不确定请求 | 验收时均为 0 |

桥接服务已设为系统服务，配置了独立的 daemon 幂等启动单元。网络访问需要开发机既有代理，已写入桥接专用环境配置。SQLite 保存在本地 XFS；代码和不含密钥的配置保存在集群持久目录。

本次没有通过重启开发机或销毁 Workspace 来测试开机恢复，避免影响其他任务。当前 Codex 会话目录本身也在 Workspace 本地盘；Workspace 销毁后的数据恢复不属于这次通过项。正在独立进程中持有写锁的会话，仍需先安全退出原进程再接入共享 daemon。

## dev-b：真实闭环通过

使用原有 Codex daemon 0.162.1、飞书 CLI 1.0.98 和 Node 24.21.0。该机器的飞书域名可直连，因此仅对桥接进程清除代理变量；原 Codex daemon 的模型代理未更改。

- 实际应用与 dev-a 不同；两路事件消费均 ready。
- 用户点击菜单选择独立只读联调会话，发送测试指令，模型轮次 completed 并精确返回 FEISHU_BRIDGE_OK。
- 回答卡片已从飞书读回：interactive、deleted=false、内容包含预期答案。
- 对新桥接 worker 正常发出 SIGTERM 后，监督进程自动启动新 worker；绑定恢复，模型轮次 ID 不变，原 daemon 仍在运行。
- 验收时 queued / uncertain / unsent 均为 0。

dev-b 没有 systemd，使用本项目 Python 标准库 supervisor 独立运行。SQLite 和锁保存在本地 overlay 文件系统，代码与不含密钥的配置保存在持久目录。**开发容器整体重建后仍需平台启动 hook 与本地状态恢复方案**；本次通过的是 worker 故障后的自动恢复，不将 nohup 描述为重建后自动启动。

## dev-c

已核对 Codex 与运行环境；当前可访问环境中未定位到可复用的飞书 CLI / 应用配置。用户已明确要求本轮跳过 t 集群，因此未部署或迁移凭据。

## 当前功能边界

已实现的私聊文字、卡片选择、进展、命令/文件审批、结构化问答、运行中补充与中断均有自动测试。只有上表明确标记的项目经过真实飞书闭环验证；审批拒绝、模型执行中 steer、中断、附件和所有 Codex 扩展交互尚未完成真实平台验收。详见 README 和 operations。
