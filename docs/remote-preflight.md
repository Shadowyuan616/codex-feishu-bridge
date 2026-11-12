# 安装前检查

在**运行 Codex 的目标开发机**上，以拥有 Codex 会话与飞书 CLI 配置的同一用户执行。
一台机器的检查结果不能代替另一台机器的验收。检查结果中的账号、路径、应用 ID、
socket、session ID、进程号和日志都留在私有部署记录中，不提交到本仓库。

| 检查 | 指令 / 判断方法 |
| --- | --- |
| 当前用户与主目录 | `id -un`、`printf '%s\n' "$HOME"`；与已有 Codex 的运行身份一致 |
| Node 与 Python | `node --version`、`python3 --version`；Node 22.13+、Python 3.9+ |
| CLI 路径 | `command -v codex`、`command -v lark-cli`；服务中使用绝对路径 |
| Codex daemon | `codex app-server daemon version`；记录现有 daemon 的真实 control socket |
| 飞书事件能力 | `lark-cli event schema im.message.receive_v1`、`lark-cli event schema card.action.trigger`、`lark-cli event schema application.bot.menu_v6` |
| 存储 | Linux 上用 `findmnt -T /chosen/local/state/parent` 检查；SQLite 状态必须在可靠本地文件系统 |
| 监督方式 | `systemctl --user is-system-running`；不可用时使用项目 Python supervisor |
| 现有任务 | 确认其他会话、传输、训练及已有事件消费者；不停止这些进程来安装桥接 |

不要打印或上传完整环境、Codex 登录文件、飞书 CLI 配置、原始数据库或完整会话记录。
若使用 SSH，先检查已有 ProxyCommand 是否只负责连接；避免执行附带恢复或改配置的
脚本。不要为了安装本项目覆盖全局 Node、shell 配置、代理或现有服务。

## 连接约束

- 使用真实存在的共享 daemon socket；桥接通过 Unix WebSocket 连接。
- `app-server proxy` 是原始字节隧道，不能当作 JSONL 服务。
- 已由独立进程持有写锁的会话不能被强行接管。让用户在适当时机安全退出后，通过
  同一 daemon 恢复；不要停止或迁移正在运行的任务。
- `--check-config` 不验证连接；`--doctor` 只读检查 Codex 和 CLI 版本，不证明飞书
  授权或消息投递已经成功。

安装步骤见 [README](../README.md)，持久运行见 [部署说明](../deploy/README.md)，
验收模板见 [acceptance.md](acceptance.md)。
