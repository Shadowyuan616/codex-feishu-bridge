# 开源方案选型与卡片复用

核验日期：**2026-10-30（Asia/Shanghai）**。下表 star 与推送时间来自 GitHub
REST API 的即时读取；star 会继续变化，不将全类别热门项目等同于当前需求的最佳实现。

| 项目 | GitHub star | 最近推送（UTC） | 许可证证据 | 与需求的关系 |
| --- | ---: | --- | --- | --- |
| [OpenClaw](https://github.com/openclaw/openclaw) | 393,360 | 2026-10-29 18:13:53 | MIT | 对比候选中主项目热度最高，是完整通用 agent 平台；本项目无需引入整个运行时。 |
| [cc-connect](https://github.com/chenhg5/cc-connect) | 16,161 | 2026-10-29 06:45:12 | README 标为 MIT，但 API `license: null`，默认分支 `LICENSE` 返回 404 | 对比候选中直接连接编码 CLI 与 IM 的桥接项目热度最高，功能最贴近：Codex app-server、目录与会话切换、飞书长连接、交互和进展卡片、服务管理。 |
| [Claude-to-IM-skill](https://github.com/op7418/Claude-to-IM-skill) | 2,897 | 2026-03-23 17:03:44 | MIT | 支持 Codex 与会话持久化；已读 README 将流式预览列为 Telegram/Discord，飞书审批通过文本命令，卡片目标匹配度较低。 |
| [飞书官方 OpenClaw 插件](https://github.com/larksuite/openclaw-lark) | 2,381 | 2026-07-22 06:51:01 | 仓库 LICENSE 与源文件 SPDX 均为 MIT | 官方维护，提供飞书卡片状态、流式更新、操作确认，适合复用卡片代码。 |
| [agents-to-im](https://github.com/francize/agents-to-im) | 118 | 2026-05-13 08:12:57 | MIT | 按 session 建飞书群的方案，可参考交互设计。 |

元数据来源：[cc-connect API](https://api.github.com/repos/chenhg5/cc-connect)、
[OpenClaw API](https://api.github.com/repos/openclaw/openclaw)、
[官方飞书插件 API](https://api.github.com/repos/larksuite/openclaw-lark)、
[Claude-to-IM API](https://api.github.com/repos/op7418/Claude-to-IM-skill)、
[agents-to-im API](https://api.github.com/repos/francize/agents-to-im)。

## 决策

**交互功能以 cc-connect 为主要对照，实际卡片代码复用飞书官方 OpenClaw 插件中
明确为 MIT 的纯函数子集。** 这是兼顾热度、功能和可维护性的选择；没有宣称官方
插件自己的 2,381 star 等于 OpenClaw 主仓的 393,360 star，也没有宣称已经做过
所有候选的生产稳定性对比。

没有直接复制 cc-connect 源码：README 的 MIT 声明与缺失的 LICENSE 文件不一致，
先保留这一事实，避免给新仓库附上未经确认的许可文本。它已有的长连接、目录和
会话交互值得参考；许可证不一致并不代表功能不可用。

官方插件的完整 `StreamingCardController` 依赖 `openclaw/plugin-sdk`、账户、消息
发送、日志、关闭钩子和图片解析等多个模块，直接导入会把本项目变成 OpenClaw
运行时的一部分。这里只固定复用
[`builder.ts@dde0be3`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/card/builder.ts)
中的文本卡片和 JSON 2.0 转换，保留原版权、MIT 许可和改编说明。后续卡片能力可
沿相同边界扩展；当前没有借用其流式控制器，也不宣称已有逐字流式更新。

## 当前模块接口与约束

- `card(title, markdown, actions)` 返回飞书 `schema: "2.0"` 卡片，正文在
  `body.elements`，每行至多三个按钮，回调值是 `{ command }`。
  按钮使用 `behaviors: [{ type: "callback", value: { command } }]`，同时保留
  历史 `value` 属性兼容旧客户端；不使用 JSON 2.0 已移除的 `tag: "action"` 容器。
  结构依据[飞书按钮官方文档](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button)。
- `splitMarkdown(text, maxBytes = 12000)` 按 UTF-8 字节分片，优先保留整行，超长
  行按 Unicode 码点切开；跨卡片代码块自动补齐关闭和重新打开的围栏。分片上限
  包含补齐的围栏；不完整的末尾代码块会闭合以便显示。
- `maxBytes` 是 Markdown 正文字节预算，不是整个 JSON 请求上限。发送方仍须为
  JSON 转义、标题、按钮和其他元素保留空间；默认 12,000 字节是保守的正文预算，
  并不是飞书最大值的声明。极端长围栏无法在预算内安全展示时会明确抛错。
- 正文不会经额外模型改写，不添加未在 Codex 可见事件中出现的思考过程。标题及
  正文不当作命令；只有显式按钮回调值进入路由，接收端仍须验证发送者、绑定的
  会话和当前操作状态。

## 双向交互与可靠性边界

[cc-connect 飞书文档](https://github.com/chenhg5/cc-connect/blob/main/docs/feishu.md)
验证飞书 WebSocket 长连接可不依赖公网入站地址；接收消息需要
`im.message.receive_v1`，按钮交互需要 `card.action.trigger`。能发消息不证明这两个
接收事件已经在用户现有应用中订阅。卡片的结构测试也不等同于真实飞书端已验收。

[cc-connect 使用文档](https://github.com/chenhg5/cc-connect/blob/main/docs/usage.md)
包含 `/list`、`/switch`、`/dir`、daemon 管理及 REST/WebSocket bridge。它证明这些
需求已有实用先例，但对本项目部署可靠性的结论仍需开发机上的实际验证。

另外，[上游 issue #1909](https://github.com/chenhg5/cc-connect/issues/1909) 报告
Codex Desktop app-server 即使空闲也可能持有会话写锁，导致另一进程
`exec resume` 报错。这是一个有具体复现的上游报告，不代表所有版本均相同。
桥接应识别写锁冲突并说明原因；不应通过终止现有进程或迁移到空的 CODEX_HOME
来伪装“载入同一个已有 session”。本项目后续必须分别验证恢复空闲会话与接管
已被其他客户端持有的会话，不能将两者合并成一次成功声明。
