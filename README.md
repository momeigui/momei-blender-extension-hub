# Momei Blender 扩展更新通道

本仓库提供私有 R2 + Worker 的 Blender 更新通道。Noetix 的 GitHub 原更新通道保持不变；两边发布**同一个 ZIP**。用户只需在 Blender 中选择其中一条通道，不要同时安装两个来源的同一插件。以后新增插件时，只需把 ZIP 加入 Blender 生成的 `index.json`，Worker 会按索引放行，无需改文件名规则。

Worker 对 `index.json` 和安装 ZIP 都验证 Blender 发送的 Bearer 令牌；文件内容从私有 R2 流式传出。`/admin` 是独立的可视化管理页，可创建/撤销用户令牌、查看已发布文件；它不提供上传功能。管理员密钥只存为 Worker Secret，用户令牌只以 SHA-256 摘要存放在 R2。新令牌仅在创建时显示一次。

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

6. 下一次推送含有 R2 发布步骤的新 `v*` 版本标签时，插件源码仓库的构建流程先发布 GitHub 通道，再将同一 ZIP 上传 R2，最后上传由 Blender 生成的 `index.json`。旧标签的工作流不会自动带上这次改动。首次发布前，管理页会显示“尚未上传”。

## 备选：本机 Wrangler 部署

1. 在本机安装 [Node.js LTS](https://nodejs.org/en/download)（Windows 安装包应包含 npm），安装后**重新打开 PowerShell**，确认 `node --version` 与 `npm.cmd --version` 都可运行。Codex 内置的 Node 不一定出现在普通 PowerShell 中，也不一定包含 npm。
2. 在 Cloudflare 创建私有 R2 桶 `momei-blender-extension-files`，不要开启 `r2.dev` 公网访问或绑定公开自定义域名。若选用其他桶名，修改 [wrangler.jsonc](wrangler.jsonc) 的 `bucket_name`。
3. 在此目录执行 `npm.cmd install`、`npx.cmd wrangler login`、`npx.cmd wrangler deploy`。部署后通过 Cloudflare 控制台设置运行时 Secret `ADMIN_TOKEN`。Windows 上使用 `.cmd` 可避开 PowerShell 对 `npm.ps1` 的执行策略限制。

管理页只应通过 HTTPS 访问；建议给 `/admin*` 再配置 Cloudflare WAF 限速或 Access 保护。注意：Access 若拦截 Blender 下载入口会使更新失败，因此只保护 `/admin*`，不要保护 `index.json` 和 ZIP 路径。

## Blender 中添加更新源

在扩展仓库设置中填写 `https://你的-worker-域名/index.json`，勾选“需要访问令牌”，填入管理页创建的 `nx_...` 用户令牌，然后同步仓库。这个令牌不是管理员密钥，也不是 GitHub 令牌。

建议先用一个测试用户令牌验证：未带令牌访问索引应收到 `401`，带有效令牌应取得 `index.json`；再在 Blender 中执行同步和安装。撤销令牌后，同步与下载应立即被拒绝。不要把真实令牌放入命令行参数、仓库、截图或日志。

## 本地检查

在此目录运行 `npm test`。测试不需要 Cloudflare 账号，覆盖下载权限、文件白名单、令牌创建/撤销/到期和管理页的登录、来源与 CSRF 校验。它不能代替一次真实的 R2 上传及 Blender 安装验证。

## 文件和权限边界

- R2 根目录：`index.json` 与各插件的 `.zip` 包；只有被 `index.json` 的相对 `archive_url` 引用的 ZIP 才能下载。
- R2 私有前缀 `auth/tokens/`：用户令牌摘要与备注/有效期。Worker 不提供访问此路径的公开接口。
- Worker Secret `ADMIN_TOKEN`：管理员登录与会话签名，不进入 R2/GitHub Actions。
- GitHub Actions 的 R2 API 密钥：仅用于写入发布文件，不进入 Worker 或 Blender。

若要撤换管理员密钥，重新设置 `ADMIN_TOKEN` 并部署；现有管理员会话立即失效，用户下载令牌不受影响。若要撤销某位用户的下载权限，在 `/admin` 删除其令牌即可。

