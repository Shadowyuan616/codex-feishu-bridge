# 远端持久运行

以下是两种可选启动方式。仓库不会自动安装服务、启动 daemon 或修改开发机。每台机器的 worker 使用自己的飞书应用和配置，并连接该机器已有 Codex daemon；Mac 不参与持续运行。

先在开发机安装 Node.js 22.13+、Python 3.9+，构建本项目并完成 `config.local.json`。代码和配置可以放在集群的持久卷；**SQLite WAL 的 `stateDir` 必须放在开发机本地 XFS/ext4 等可靠本地文件系统上，不放在 GPFS/NFS 共享盘**。dev-a 可使用 `/root/.local/state/codex-feishu-bridge`。supervisor 锁和日志也优先使用该本地目录。配置文件权限应为 `600`，目录仅该用户可访问。`lark.binary`、Node 和 Python 建议用绝对路径，避免非交互 shell 的 PATH 差异。

共享 daemon 的设置见 [Codex 协议说明](../docs/codex-protocol.md)。配置 `codex.socketPath` 为现有 control socket 的绝对路径，worker 用 Unix WebSocket 连接。`app-server proxy` 是原始 WebSocket 字节隧道，不能作为逐行 JSON 子进程使用；只有显式独立 stdio 模式才使用 `codex.binary`/`codex.args`。worker 重启不会执行 daemon start/stop/restart，也不会终止已有模型任务。

## 方式一：有可用用户 systemd

将 `bridge.env.example` 复制为 `~/.config/codex-feishu-bridge/bridge.env`，填写实际绝对路径；将本目录的 `.service` 复制到 `~/.config/systemd/user/`。两个目录若不存在可由本人创建。随后执行：

```sh
systemctl --user daemon-reload
systemctl --user enable --now codex-feishu-bridge.service
systemctl --user status codex-feishu-bridge.service
```

这是安装示例，当前开发任务不会执行这些命令。用户 systemd 是否在登出后继续运行取决于该环境的 user manager/linger 配置。需要 linger 时先确认集群允许该配置；不需要 root 的前提是用户服务管理本身已可用。dev-a 当前检查为 `Linger=no`，应使用独立 system service 模板 `codex-feishu-bridge-system.service`，由有权限的操作者填写实际用户与 env 路径后安装；不修改现有 Codex daemon unit。很多开发容器没有 systemd，此时选方式二。

unit 也调用本项目 supervisor，从而与方式二共用同一个 `supervisor.lock`，避免两种启动器同时运行。不要给同一配置使用两个不同的 supervisor state 目录。

## 方式二：无 systemd 的开发容器

使用 Python 标准库 supervisor，无额外 Python 依赖：

```sh
python3 /absolute/repo/deploy/supervise.py \
  --state-dir /absolute/local/bridge-state/supervisor \
  --log-dir /absolute/local/bridge-state/logs \
  -- /absolute/node /absolute/repo/dist/src/main.js \
  --config /absolute/repo/config.local.json
```

可由集群提供的启动 hook、已有进程管理器或显式 `nohup` 启动该命令。前台运行便于首次排错；`nohup` 只能防 SSH 断连，不能在容器被重建后自行重新启动。**容器重建恢复需要平台持久启动 hook**，并确保代码/配置卷已挂载、本地状态目录已恢复、现有 Codex daemon 已可连接。代码在持久卷不代表服务会自动运行；本地 SQLite 数据在容器被销毁时也可能丢失，备份/恢复须独立设计，不能直接移动 WAL 数据库到 GPFS 解决。没有配置并验证这些步骤前，不声称“重建后自动恢复”。

supervisor 持有 `flock` 独占锁；重复启动退出码为 75。异常退出采用 1–60 秒指数退避，稳定运行两分钟后重置退避。日志默认每份 5 MiB，保留三份轮转备份；日志仅应接收 bridge 的脱敏输出，不开启原始飞书或 Codex 调试数据输出。SIGTERM/SIGINT 只停止自己启动的 worker 进程组及其子进程，15 秒后才强制结束；已独立运行的共享 Codex daemon 不在该进程组内。

`supervisor.pid` 与 `worker.pid` 在退出时清理；`supervisor.lock` 文件会保留，其存在本身不表示服务仍在运行。判断运行状态需检查锁持有者/进程及飞书 `/health`，不要看到旧 PID 文件就盲目向进程发信号。状态目录放在可靠本地文件系统上；不要依赖跨机器的共享盘锁协调两个 worker。

## 验收要求

启动后分别验证：飞书消息进入 inbox、目录/会话菜单、只读历史、用户指定测试 session 的单轮输入和最终卡片、审批/拒绝、worker 重启后的绑定恢复、断线期间重复消息去重。最后在关闭 Mac 与 SSH 连接后检查 worker 仍在响应。容器重建测试必须安排在没有关键任务运行的窗口，不能为验收中断其他会话或传输。

服务自动恢复不保证外部操作恰好执行一次。提交中断的请求会标记结果待核对，恢复时先读历史，不自动重发模型指令。
