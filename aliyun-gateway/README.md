# 阿里云 OSS 国内下载网关

这是函数计算 Web 函数的代码，不是 Cloudflare Worker。Blender 保持原仓库地址和原令牌：Worker 校验令牌后将请求重定向到本函数；本函数再次向 Worker 核验令牌，只读取北京私有 OSS 挂载目录中的 `index.json` 和索引列出的 ZIP，然后在国内流式返回。没有任何 OSS AccessKey 存在代码或 Worker 中。

## 部署到阿里云函数计算

1. 在函数计算选择**华北 2（北京）**，创建一个 Web 函数。代码上传方式可选“上传文件夹”，选择本 `aliyun-gateway` 目录；使用支持 Node.js 18+ 的运行环境。启动命令为 `node server.js`，监听端口为 `9000`，超时应覆盖正常安装包下载时间。代码没有第三方 npm 依赖。
2. 给函数绑定一个只读的 RAM 角色；其 OSS 策略仅允许此 Bucket 的 `oss:ListObjects` 和对象的 `oss:GetObject`。在函数配置的“OSS 挂载”中选择私有 Bucket `momei-blender-extension`，**只读**，挂载 Bucket 根目录到 `/mnt/oss`。函数与 Bucket 必须同为北京地域，使用同地域内网 Endpoint。不要使用已有的上传用 RAM AccessKey，也不要把 Bucket 改为公共读。
3. 配置 HTTP 触发器，允许匿名调用。匿名仅指阿里云平台不再做额外签名；本服务仍会验证每个文件请求的 Blender Bearer 令牌。保持 HTTPS。环境变量 `AUTH_CHECK_URL` 可留空，默认是 `https://blender.3ddd.site/auth/check`；`OSS_MOUNT_DIR` 默认是 `/mnt/oss`。
4. 先确保 Hub Worker 中含 `/auth/check` 的新版代码已部署；在阿里云函数页面复制 **HTTPS 根地址**。访问 `<根地址>/health` 应返回 `200`，未带令牌访问 `<根地址>/index.json` 应返回 `401`。用 Blender 中已有的测试令牌访问索引与 ZIP，应返回 `200`，ZIP 大小及 SHA-256 应与 `index.json` 一致。不要把令牌放在 URL、截图、日志或聊天里。
5. 前四步都成功后，在 Cloudflare Worker 的“设置 → Variables & Secrets”增加普通运行时变量 `ALIYUN_GATEWAY_BASE_URL`，值为该 HTTPS 根地址，不带 `/index.json`。这会保持 Blender 中的 `https://blender.3ddd.site/index.json` 不变。测试原地址有令牌时返回到国内网关的 `307` 跳转，并完成安装。

未设置 `ALIYUN_GATEWAY_BASE_URL` 时 Worker 仍从 R2 下载；网关的 `/health` 无法访问时 Worker 会回退 R2。网关健康但后续鉴权服务或 OSS 挂载异常时会返回错误，不会绕过令牌验证。关闭阿里云通道只需删除 Worker 的该变量，原 GitHub 与 R2 发布不受影响。

## 本地验证

在本目录运行 `npm test` 或 `node --test`。测试用临时文件模拟 OSS 挂载，并覆盖无令牌拒绝、有效令牌下载、索引白名单、HEAD、鉴权服务故障。真实上线仍需在函数计算环境测试 OSS 挂载与 Blender 安装。

阿里云文档：[创建 Web 函数](https://help.aliyun.com/zh/functioncompute/creating-a-web-function)、[OSS 只读挂载](https://help.aliyun.com/zh/functioncompute/configure-an-oss-file-system-1)、[Web 函数 HTTP 透传](https://help.aliyun.com/zh/functioncompute/web-functions)。
