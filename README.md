# Momei Blender 扩展更新通道

本仓库提供私有 R2 + Worker 的 Blender 更新通道。Noetix 的 GitHub 原更新通道保持不变；两边发布**同一个 ZIP**。用户只需在 Blender 中选择其中一条通道，不要同时安装两个来源的同一插件。以后新增插件时，只需把 ZIP 加入 Blender 生成的 `index.json`，Worker 会按索引放行，无需改文件名规则。

公开首页 `/` 介绍 Noetix Motion Editor、安装方法和最新更新；它从私有 R2 的 `latest.json` 读取发布说明，不展示令牌或私有文件。Worker 对 `index.json` 和安装 ZIP 都验证 Blender 发送的 Bearer 令牌；文件内容从私有 R2 流式传出。`/admin` 是可视化管理页，可创建/撤销用户令牌、查看已发布文件；它不提供上传功能。管理员密钥只存为 Worker Secret，用户令牌只以 SHA-256 摘要存放在 R2。新令牌仅在创建时显示一次。

## 飞书企业自建应用：员工自助领令牌

Worker 提供独立的 `POST /feishu/events` 回调入口。首次地址验证可接收飞书不带签名头的明文或加密 `challenge`，但必须核对 Verification Token；如果带了签名头也会校验。后续普通事件仍要求加密、有效签名和时间戳。主页 `/` **不是**回调地址。

推荐使用机器人单聊菜单「申请令牌」：点击后 Worker 从菜单事件取得点击者的飞书 `open_id`，再通过企业通讯录读取该账号的姓名，无须员工自行输入。只有成功读到姓名才创建令牌，并仅私聊发送给点击者本人。原有文字命令 `领取令牌 张三` 暂作兼容，但同样以飞书通讯录的真实姓名和账号 ID 为准。令牌默认 90 天；私有 R2 只保存令牌摘要、申请姓名、飞书 `open_id`、租户标识、事件 ID、申请时间及到期时间，后台 `/admin` 可以查看并撤销。原文只在飞书私信中出现一次，不可从后台找回。同一飞书账号只能持有一枚有效的新申请令牌，菜单和文字命令共用限额；重复申请会收到提示，事件重试复用原令牌。撤销或到期后，只要该账号没有其他有效令牌即可立即重新申请，不设时间冷却。上线前已经发出的令牌不会自动撤销，但会计入申请限制；历史重复令牌可由管理员逐个撤销。此阶段尚未实现 AI 问答。

Worker 每分钟检查私有 R2 的 `releases/` 版本通知记录；插件发布流程在上传 `latest.json` 后会为每个正式版本写入一份记录，因此短时间连续发布也会逐个处理。若尚无此类记录，首次启用时会从当前 `latest.json` 发送一次版本说明。新版本发布后，只私聊仍持有有效令牌、令牌记录含飞书账号 ID、且未取消订阅的人员。历史持有人默认已订阅；在机器人单聊点击「取消更新提醒」后停止，点击「订阅更新提醒」后恢复。后台 `/admin` 的令牌表会显示每人的订阅状态；后台手动创建且没有飞书账号 ID 的令牌无法确定私聊对象，不在通知范围内。同一版本同一账号只通知一次，历史重复令牌不会重复提醒。一次最多处理 6 条令牌记录，人员较多时会分批完成。此机制以 R2 正式发布成功为准，不会对普通源码提交发通知。

配置顺序：

1. 确认飞书应用是企业自建应用，已启用机器人能力。群自定义机器人 Webhook 无法用于此功能。
2. 在飞书应用「事件与回调 → 加密策略」设置 Encrypt Key，查看 Verification Token；应用「凭证与基础信息」可查看 App ID。**不要把这些值发到聊天、提交到仓库或写进网页。**
3. 在 Cloudflare Worker「设置 → Variables & Secrets」添加四个**运行时 Secret**：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_VERIFY_TOKEN`、`FEISHU_ENCRYPT_KEY`。`FEISHU_APP_SECRET` 从飞书应用「凭证与基础信息」取得。不要把任何密钥发到聊天、写进源码或截屏分享。还需保留现有 `ADMIN_TOKEN` 和私有 R2 `EXTENSIONS` 绑定；缺项时令牌事件返回 503。
4. 在飞书「事件与回调 → 事件配置」选择「将事件发送至开发者服务器」，请求地址填写已经验证可达的 `https://blender.3ddd.site/feishu/events`。订阅 `application.bot.menu_v6`（申请令牌菜单事件）和 `im.message.receive_v1`（订阅菜单发送的文字消息及兼容的文字领令牌命令）。应用须开通以机器人身份发送消息，以及通讯录的「获取用户基本信息」权限，并让应用的通讯录可用范围涵盖申请人员。缺少姓名权限时领令牌菜单流程会私聊提示错误，不发令牌。
5. 在飞书应用「机器人 → 自定义菜单」新增菜单：名称填「申请令牌」，响应动作选「推送事件」，自定义事件 ID **准确填写 `request_update_token`**。再添加「订阅更新提醒」和「取消更新提醒」两个菜单，响应动作选「发送文字消息」，发送文字必须与菜单名完全一致。也可改用「推送事件」，事件 ID 分别为 `subscribe_updates` 和 `unsubscribe_updates`。保存菜单配置，发布应用新版本使菜单、事件订阅和权限生效。
6. 用一位员工的飞书账号在与机器人的单聊中点击菜单；确认仅该账号收到令牌、`/admin` 显示通讯录姓名和申请时间，随后在 Blender 用令牌同步并测试后台撤销。**应用可见范围必须限制为公司人员**；本功能以飞书已验证的账号及应用可见范围为准，不靠自报姓名判断员工身份。

事件接收只支持飞书加密事件，拒绝未加密、错误签名、超过五分钟的请求。单聊中的其它文字、图片等内容会静默忽略，不再自动回复领令牌提示；不认识的事件类型或菜单事件仍返回 503，不会假装处理成功。如果该飞书应用原先还有其它机器人业务，请先协调事件回调的接管方式，不要直接切换到本 Worker。

## 推荐：独立 GitHub 仓库部署（本机不需要 npm）

1. 在 Cloudflare 创建私有 R2 桶 `momei-blender-extension-files`，不要开启 `r2.dev` 公网访问。若使用其他桶名，先修改 `wrangler.jsonc` 的 `bucket_name`。
2. 新建一个专门存放 Worker 代码的 GitHub 仓库，将**本目录内容放在仓库根目录**：`src/index.js`、`wrangler.jsonc`、`package.json`、`.gitignore`、`README.md` 和 `test/`。不要上传管理员密钥、用户令牌或 R2 API 密钥。插件源码仓库仍负责构建 ZIP 和推送 R2；这个新仓库只负责部署 Worker。
3. Cloudflare「Workers & Pages → 创建项目 → Continue with GitHub」，选择新仓库。Worker 名称使用 `momei-blender-extension-hub`（与 `wrangler.jsonc` 的 `name` 一致），项目根目录为 `/`，构建命令留空，部署命令为 `npx wrangler deploy`。Cloudflare 会在云端安装依赖并部署，不使用本机 npm。
4. 首次部署后，进入该 Worker 的「设置 → Variables & Secrets」，新增**运行时 Secret** `ADMIN_TOKEN`，值为独立生成的长随机密钥。未配置时管理页会返回 503；源码与仓库中绝不保存密钥。再打开 `https://你的-worker-域名/admin` 登录并创建用户下载令牌。
5. 在**插件源码仓库**的 GitHub Actions Secrets 中设置下表四项。R2 API 令牌仅授予这个桶的 Object Read & Write 权限。四项全空时跳过 R2 发布；只配置一部分时构建会失败并提示缺项。

   | Secret | 内容 |
   | --- | --- |
   | `CF_R2_ACCOUNT_ID` | Cloudflare Account ID |
   | `CF_R2_BUCKET` | 私有 R2 桶名 |
   | `CF_R2_ACCESS_KEY_ID` | R2 API 访问密钥 ID |
   | `CF_R2_SECRET_ACCESS_KEY` | R2 API 私密访问密钥 |

6. 下一次推送含有 R2 发布步骤的新 `v*` 版本标签时，插件源码仓库的构建流程先发布 GitHub 通道，再将同一 ZIP 上传 R2、上传由 Blender 生成的 `index.json`，并根据 `CHANGELOG.md` 最新版本条目生成 `latest.json` 和 `releases/` 通知记录。已有版本可手动运行源码仓库的 `Sync existing Extension release to R2` 工作流，不必重新编译；同版本重复同步不会重复私聊。主页自动读取最新版本说明，无需修改 Worker 代码。

## 备选：本机 Wrangler 部署

1. 在本机安装 [Node.js LTS](https://nodejs.org/en/download)（Windows 安装包应包含 npm），安装后**重新打开 PowerShell**，确认 `node --version` 与 `npm.cmd --version` 都可运行。Codex 内置的 Node 不一定出现在普通 PowerShell 中，也不一定包含 npm。
2. 在 Cloudflare 创建私有 R2 桶 `momei-blender-extension-files`，不要开启 `r2.dev` 公网访问或绑定公开自定义域名。若选用其他桶名，修改 [wrangler.jsonc](wrangler.jsonc) 的 `bucket_name`。
3. 在此目录执行 `npm.cmd install`、`npx.cmd wrangler login`、`npx.cmd wrangler deploy`。部署后通过 Cloudflare 控制台设置运行时 Secret `ADMIN_TOKEN`。Windows 上使用 `.cmd` 可避开 PowerShell 对 `npm.ps1` 的执行策略限制。

管理页只应通过 HTTPS 访问；建议给 `/admin*` 再配置 Cloudflare WAF 限速或 Access 保护。注意：Access 若拦截 Blender 下载入口会使更新失败，因此只保护 `/admin*`，不要保护 `index.json` 和 ZIP 路径。

## Blender 中添加更新源

在扩展仓库设置中填写 `https://你的-worker-域名/index.json`，勾选“需要访问令牌”，填入管理页创建的 `nx_...` 用户令牌，然后同步仓库。这个令牌不是管理员密钥，也不是 GitHub 令牌。

建议先用一个测试用户令牌验证：未带令牌访问索引应收到 `401`，带有效令牌应取得 `index.json`；再在 Blender 中执行同步和安装。撤销令牌后，同步与下载应立即被拒绝。不要把真实令牌放入命令行参数、仓库、截图或日志。

## 本地检查

在此目录运行 `npm test`。测试不需要 Cloudflare 账号，覆盖下载权限、文件白名单、令牌创建/撤销/到期、飞书签名、菜单点击、通讯录查询失败、私聊发放、重复事件、同一账号并发申请、旧令牌识别、撤销后立即申请、版本更新私聊通知以及管理页的登录、来源与 CSRF 校验。它不能代替一次真实的飞书私聊、R2 上传及 Blender 安装验证。

## 文件和权限边界

- R2 根目录：`index.json`、`latest.json`、`releases/` 版本通知记录与各插件的 `.zip` 包。`latest.json` 由 Worker 读取并渲染到公开首页；`releases/` 只供内部通知，不是公开下载端点；只有被 `index.json` 的相对 `archive_url` 引用的 ZIP 才能下载。
- R2 私有前缀 `auth/tokens/`：用户令牌摘要与备注/有效期。Worker 不提供访问此路径的公开接口。
- R2 私有前缀 `auth/feishu-users/`：按飞书账号摘要保存领用状态，用条件写入避免并发重复发放；不保存令牌原文。
- R2 私有前缀 `auth/subscriptions/`：按飞书账号摘要保存员工对更新提醒的选择；没有记录表示默认订阅。
- R2 私有前缀 `auth/notifications/`：保存新版本通知进度和按版本/账号去重的发送标记；不会公开下载。
- Worker Secret `ADMIN_TOKEN`：管理员登录与会话签名，不进入 R2/GitHub Actions。
- GitHub Actions 的 R2 API 密钥：仅用于写入发布文件，不进入 Worker 或 Blender。

若要撤换管理员密钥，重新设置 `ADMIN_TOKEN` 并部署；现有管理员会话立即失效，用户下载令牌不受影响。若要撤销某位用户的下载权限，在 `/admin` 删除其令牌即可。

