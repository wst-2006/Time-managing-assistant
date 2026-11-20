# 时间管理助手 · Time Managing Assistant

> 一个装上就能用的本地时间管理软件：排任务、专注计时、给完成情况打分，再加一份可选的每周健康参考。

不需要安装数据库，不需要任何 API 密钥，数据只存在你自己的电脑上。

## 四件事

### 1. 任务安排（今日 / 规划）

- 上午、下午、晚上三张时间页，当前时段始终在最前面；也可以切到全天视图。
- 在时间轴空白处拖动就能新建任务，半小时一格；拖动、拉伸即可改时间。
- 快速记录先放进“未排期”，之后拖到时间轴上。
- 时间冲突不会被悄悄覆盖，必须你明确保留。
- 规划页记录月度 / 季度 / 年度的长期目标和里程碑（只记录，不会自动生成任务）。

### 2. 专注计时（专注）

- 有确切时间的任务开始前一分钟进入准备，你确认“我会准时开始”后到点自动开始。
- 专注中不能暂停或提前结束；可以把整段时间拆成若干专注段和休息段。
- 独立的专注小窗可以置顶、锁定、收起。
- 五套计时主题：红色海报（默认）、素简翻页、辉光电子管、蒸汽波、赛博终端。

### 3. 完成情况打分（专注结束 / 复盘 / 成长）

- 每次专注结束弹出评价窗：客观结果（完成 / 部分完成 / 未完成）和主观感受（满意 / 一般 / 不满意）分开记录。
- 复盘页汇总这一天：计划了几项、完成了几项、有效专注多少分钟、每项任务的结果和感受。
- 成长页给今天做六维打分（五档刻度），并用竹子和年度趋势图展示长期变化。

### 4. 个人健康（可选）

软件不接入任何 AI。生成每周健康参考的方式是：

1. 在健康页填好自己的资料，点 **复制提问模板**；
2. 把模板发给任意网页版 AI（DeepSeek、Kimi、豆包、ChatGPT 都可以）；
3. 把 AI 的回答整段粘贴回来，点 **检查并生成候选**。

软件会用代码逐项检查回答格式。不符合的地方会用中文列出来，并给你一段“修正说明”可以直接发回给 AI。检查通过后先成为待确认候选，你确认后才替换本周参考。也可以完全手动编辑。

### 飞书提醒（可选）

如果你用飞书，可以让任务开始前在手机上收到卡片，直接点“开始”或“另有安排”。不用就不用配置，提醒会留在软件里。见 [docs/FEISHU_LOCAL_USAGE.md](docs/FEISHU_LOCAL_USAGE.md)。

## 安装

### Windows 安装包（推荐）

到 [Releases](https://github.com/wst-2006/Time-managing-assistant/releases) 下载 `Time Managing Assistant_x.y.z_x64-setup.exe`，双击安装即可。安装包自带运行环境和数据库，不需要额外装任何东西。

数据和设置保存在 `%APPDATA%\com.wst2006.timemanagingassistant\` 下（`data` 文件夹是数据库，`.env` 是可选设置）。

### 从源码运行

需要 Node.js 22+（自带 Corepack）。

```bash
corepack enable
corepack pnpm install
corepack pnpm dev:local      # 启动本地服务 (127.0.0.1:3000) 和界面 (http://localhost:5173)
```

数据默认存在 `~/.time-managing-assistant/data`。想换位置，复制 `.env.example` 为 `.env` 并设置 `TMA_DATA_DIR`。

### 自己打包安装程序

在 Windows 上安装 Rust 后运行 `corepack pnpm build:desktop`。也可以推送一个 `v*` 标签，让 GitHub Actions（`.github/workflows/release.yml`）自动打包并附到 Release。

## 数据与备份

- 顶栏的“备份所有数据”会下载一份完整的 JSON 备份，不包含任何密钥。
- 也可以退出软件后直接复制整个 `data` 文件夹。
- 回收站支持保留期限和一键清空。

## 开发

```bash
corepack pnpm check      # 类型检查
corepack pnpm test       # 单元与接口测试（内存数据库）
corepack pnpm test:e2e   # 浏览器测试（临时数据文件夹，不会碰到真实数据）
```

结构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，界面约定见 [docs/DESIGN.md](docs/DESIGN.md)。

## 许可

见 [LICENSE](LICENSE)。
