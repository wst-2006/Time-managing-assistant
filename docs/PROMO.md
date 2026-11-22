# 录宣传视频

`corepack pnpm promo` 会用一份临时演示数据（不会碰你的真实数据）启动软件界面，全屏打开 Edge，然后自动操作：

1. 开场字幕「把一天排清楚」
2. 今日页：切到全天时间轴，在空白处拖出「高等代数」并保存，左侧状态条一眼可见
3. 专注页：选中任务，鼠标在计时数字上上下推动，两侧线条像旋钮一样滚动
4. 点 GO → LET'S BEGIN → 正式计时
5. 右下角滑出桌面专注小窗（黑底红字）
6. 成长页：柱状图、完成圆点、感受
7. 结尾字幕

全程约 45 秒。画面上的黑色圆圈就是演示用的鼠标。

## 第一次准备（只做一次）

1. 安装 [Node.js](https://nodejs.org/) 22 或更新版本（选 LTS），安装 [Git](https://git-scm.com/)
2. 打开 PowerShell：

   ```powershell
   git clone https://github.com/wst-2006/Time-managing-assistant.git
   cd Time-managing-assistant
   corepack enable
   corepack pnpm install
   ```

3. 录屏工具二选一：
   - **OBS**（推荐）：新建场景 → 来源加「显示器采集」→ 设置里 视频 1920×1080、60 FPS；输出 选「高质量，中等文件大小」。在显示器采集的属性里**取消勾选「捕获鼠标指针」**（画面里已有演示鼠标）。
   - **Xbox Game Bar**：Windows 自带，`Win + Alt + R` 开始/停止录制当前窗口。它会录到系统鼠标，录之前把鼠标移到屏幕角落。

## 每次录制

1. 在 08:00–20:30 之间运行（演示会围绕当前时间排任务）
2. 在项目文件夹里：

   ```powershell
   corepack pnpm promo
   ```

3. 等 Edge 全屏打开、出现开场字幕
4. 开始录屏
5. 在浏览器里按**空格键**，演示开始；结束时终端会提示「演示结束」
6. 停止录屏。浏览器会自动关闭，临时数据会自动删掉

想用 Chrome：`$env:PROMO_BROWSER="chrome"; corepack pnpm promo`

## 后期

剪映导入录屏，加音乐即可。字幕已经在画面里了；想改字幕文字，告诉 Claude 或者改 `scripts/promo/record-promo.mjs` 里 `card("…", "…")` 的内容。
