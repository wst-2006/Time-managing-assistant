# 外部服务配置

Personal AI Assistant 的外部服务全部通过本地 API/Worker 调用。密钥不会交给浏览器前端，也不能提交到 GitHub。

## 配置文件位置

桌面安装版：

```text
%APPDATA%\com.personalai.assistant\.env
```

源码开发版：仓库根目录下的 `.env`。

配置后需要完全退出桌面应用并重新启动，使本地 API 和 Worker 读取新值。

## DeepSeek

用途：自然语言任务候选、复盘回应、简报整理、长期计划任务树和健康参考候选。

在 DeepSeek 官方平台创建自己的 API Key，并根据官方文档确认当前可用模型：

- 平台：`https://platform.deepseek.com/`
- API 文档：`https://api-docs.deepseek.com/`

配置项：

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=请填写你的账号当前可用模型
```

模型名称和可用额度可能变化，以 DeepSeek 官方控制台和文档为准。不要把真实 Key 粘贴到 GitHub Issue、截图、浏览器控制台或公开聊天中。

## 飞书

用途：任务提醒、开始/另有安排/取消卡片，以及通过机器人发送文本来创建待确认的任务、想法或问题候选。

入口：

- 飞书开放平台：`https://open.feishu.cn/`
- 服务端文档：`https://open.feishu.cn/document/server-docs/getting-started/getting-started`

本地优先模式使用飞书官方长连接，不需要公网服务器或内网穿透。配置：

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_TARGET_OPEN_ID=
FEISHU_CALLBACK_TRANSPORT=websocket
```

在飞书开放平台中需要：

1. 创建企业自建应用并启用机器人能力。
2. 从“凭证与基础信息”复制 App ID 和 App Secret。
3. 为机器人配置所需的消息与卡片权限。
4. 在事件订阅中使用长连接，并添加 `im.message.receive_v1`。
5. 发布应用版本，并确保目标用户能够使用该机器人。
6. 将允许操作卡片的用户 Open ID 写入 `FEISHU_TARGET_OPEN_ID`。

只有配置的目标用户可以通过飞书卡片或文本入口创建候选。飞书文本不会直接写入任务；仍需在候选卡片中确认。

如果要让卡片点击通过飞书回调响应体在 3 秒内直接替换原卡片，需要改用 HTTP 回调。当前长连接 SDK 的卡片事件监听器没有返回卡片响应体的接口，只能在收到点击后调用更新消息卡片接口。

HTTP 回调还需要：

```dotenv
FEISHU_CALLBACK_TRANSPORT=http
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
```

并在飞书后台将回调请求地址设置为：

```text
https://你的公网域名/api/v1/integrations/feishu/events
```

该地址必须能从公网访问并使用 HTTPS。桌面应用默认监听本机 API，不能直接作为公网回调地址；没有公网 HTTPS 地址时继续使用 `websocket`。

## 每日简报

每日简报暂不使用外部新闻、RSS/Atom 订阅、联网搜索或 Work Buddy
导入。复盘页保留本地简报数据链路，仅根据用户自己的复盘、任务和可选天气
材料生成，避免额外的搜索凭据、网络依赖和来源维护成本。

## 视觉模型

用途：使用 DeepSeek 视觉模型分析用户主动上传的睡眠截图。文本和视觉请求共用同一个服务端 DeepSeek API Key，原图不会保存。

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_VISION_MODEL=deepseek-v4-flash-vision-exp
```

视觉请求使用 OpenAI 兼容的 Chat Completions 接口，并以原图细节模式发送 PNG、JPEG 或 WebP 截图。没有配置 DeepSeek Key 时，API 不会启动；模型调用失败不会保存原图或伪造分析结果。

## 配置安全检查

- `.env` 只能保存在本机用户目录或源码根目录，不要改成 `.env.example`。
- 不要把真实密钥写入 `apps/web`、公开静态文件或前端构建变量。
- 不要提交数据库 URL、飞书事件样例、日志、备份或包含个人任务的截图。
- 一旦密钥进入 Git 历史，应立即在服务商控制台撤销或轮换；只删除最新文件是不够的。
- 发布前运行 `corepack pnpm release:audit`。
