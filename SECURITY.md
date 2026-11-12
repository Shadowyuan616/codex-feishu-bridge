# 隐私与安全维护

## 哪些数据不应进入仓库

- 飞书 App ID、App Secret、open_id、chat_id、消息回执及订阅授权链接。
- OpenAI/其他服务的 API Key、OAuth 令牌、私钥和登录文件。
- 真实机器账号、内部 IP/主机名、部署路径、session ID、完整会话和截图。
- `config.local.json`、`bot-menu*.local.json`、`bridge.env`、SQLite/WAL/SHM、日志、
  health 文件和备份。这些可能含用户输入、模型输出及审批数据。

使用 `npm run configure` 在仓库外创建私有配置。样例采用通用机器名和不可直接使用
的占位符；自动测试使用明显的合成身份。不要将真实部署记录替换进公开验收模板。
第三方版权声明及上游联系方式不因隐私检查而被删除。

本服务按用户的指令把所选 session 的内容发送到其飞书应用。操作者应了解该数据流，
只授权所需用户与项目。桥接不改变原会话的工具权限，也不会自动批准未知审批。

## 扫描

```sh
npm run privacy:check
npm run privacy:check -- --staged
npm run privacy:check -- --history
```

默认扫描 Git 跟踪文件及未忽略的新文件；`--staged` 扫描暂存区，能检测强行加入的
私有运行文件；`--history` 扫描所有可达提交的文件内容、提交说明和作者/提交者邮箱，
要求完整 Git 历史。输出只有文件位置和规则名，不打印匹配值。规则扫描不能发现
所有任意格式密钥，也不覆盖 GitHub 缓存、fork、Issue、PR 评论或别人的克隆。

发布前另外运行可信来源的 [Gitleaks](https://github.com/gitleaks/gitleaks)，始终开启脱敏：

```sh
gitleaks git --redact --log-opts=--all .
```

需要保存扫描报告时放到仓库外的私有目录。CI 会执行工作树隐私检查；维护者应在
对外分享或发布前额外检查历史、GitHub 元数据及构建产物。

提交邮箱建议使用 GitHub 设置中提供的 noreply 地址，仅对当前仓库设置：

```sh
git config --local user.email 'YOUR_GITHUB_NOREPLY_ADDRESS'
```

## 发现泄露后的处理

1. 若是真实密钥/令牌，先由拥有者撤销或轮换；删文件不等于撤销访问。
2. 清理当前文件，补扫描规则和忽略规则，并确认公开日志/产物没有副本。
3. 若已进入 Git 历史，在私有位置备份；在独立克隆中准备清理、核对差异和扫描。
   重写共享分支会改变提交 ID，影响其他克隆，应先协调再进行受保护的强制更新。
4. 历史更新后重新克隆并复核。旧克隆、fork、PR 内部引用和缓存不会因此自动消失；
   需要时按 [GitHub 官方清理指引](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
   联系相关拥有者或 GitHub Support。不要把旧分支重新合并回来。

报告问题时只提交去标识后的复现步骤和错误类别，不在公开 Issue 中粘贴凭据、
原始数据库或完整会话。涉及真实秘密的细节通过维护者认可的私密渠道沟通。
