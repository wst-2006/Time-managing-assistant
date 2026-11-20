# 结构说明

```
apps/web       React + Vite 界面（海报风格）
apps/api       Fastify 本地服务：HTTP 接口 + 内嵌数据库 + 后台定时任务
apps/worker    提醒、专注计时、过期任务等后台任务（作为库被 API 调用）
apps/desktop   Tauri 2 Windows 外壳：启动随包附带的 Node 与 API，显示界面和专注小窗
packages/db    数据表定义（Drizzle）与迁移；数据库是 PGlite（运行在进程内的 PostgreSQL）
packages/domain 纯业务规则：任务、专注、复盘、健康模板解析等
```

## 为什么不需要安装数据库

数据存放在一个普通文件夹里（默认 `~/.time-managing-assistant/data`，Windows 安装版在应用数据目录的 `data` 子文件夹）。API 启动时用 PGlite 打开它并自动应用迁移。因为同一时间只能有一个进程打开这个文件夹，原来独立运行的 Worker 现在作为后台循环跑在 API 进程里（每秒检查一次）。

备份：顶栏的“备份所有数据”会下载一份 JSON 逻辑备份；也可以直接复制整个 `data` 文件夹（先退出软件）。

## 健康参考：没有 AI 接口

软件本身不调用任何 AI。健康页会生成一段带有你资料和固定回答格式的“提问模板”，你把它发给任意网页版 AI，再把回答粘贴回来。`packages/domain/src/health-template.ts` 负责：

- 从回答里找出 JSON（支持 ```json 代码块、中文引号、多余逗号）；
- 把常见的同义字段名改成标准字段；
- 用 zod 逐项校验，给出中文的错误说明和一段“修正说明”，可以再发回给 AI。

校验通过后先保存为“待确认候选”，用户确认后才替换本周参考。

## 测试

- `pnpm test`：单元与接口测试，使用内存数据库。
- `pnpm test:e2e`：Playwright 浏览器测试，使用一次性的临时数据文件夹，不会碰到你的真实数据。
