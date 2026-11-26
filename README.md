# nuist-sakt-auto · 南信大（NUIST）实验室安全准入平台自动学习脚本

> 南京信息工程大学（NUIST）「实验室安全准入与教育平台」（https://sakt.nuist.edu.cn）的 Tampermonkey 油猴脚本：
> 自动逐节播放「未学」课时，支持 AI 答题、防挂机续播、播完自动进入下一节。
> 视频真实播放，完成记录由平台自身接口写入；脚本不伪造进度。

![Tampermonkey](https://img.shields.io/badge/Tampermonkey-userscript-green)
![License](https://img.shields.io/badge/license-MIT-blue)
![NUIST](https://img.shields.io/badge/NUIST-%E5%8D%97%E4%BF%A1%E5%A4%A7-blue)

## 适用平台

| 项 | 信息 |
|---|---|
| 学校 | 南京信息工程大学（Nanjing University of Information Science & Technology，NUIST / 南信大） |
| 平台 | 实验室安全准入与教育平台 |
| 地址 | https://sakt.nuist.edu.cn |
| 技术支持 | 南京市杰畅教育科技有限公司 |
| 适用页面 | `/students/courseDetail?id=...` 课程学习页 |

该平台是南信大实验室与设备管理处使用的在线安全准入培训系统，学生需逐节看完视频并通过考试才能获得实验室准入资格。本脚本只解决「逐节连续播放」这件重复劳动。

## 功能

- **连续播放**：自动识别课程目录里所有「未学」课时，按顺序一节节播完
- **自动续播**：后台标签页 / 防挂机导致的暂停会自动恢复
- **AI 答题**：弹窗习题可调用 OpenAI 兼容接口作答，失败自动回退到默认选项
- **答题缓存**：同一道题只请求一次 AI，答案缓存在本地
- **自动切课**：本节 `ended` 后自动点击左侧目录进入下一节
- **分页面板**：右下角悬浮窗分「运行 / 设置 / AI」三页，深色高对比配色
- **断点续跑**：队列存在 `localStorage`，刷新页面或重开浏览器后自动从上次位置继续

## 原理

平台课程页是 Vue + 原生 `<video>` 播放器，进度逻辑在页面脚本里：

| 时机 | 平台行为 |
|---|---|
| 进入课时 | `POST /courseSource/updateVisits` |
| 每 10 秒 | `POST /courseSource/finishRate { watchDuration }` |
| 视频结束 | `POST /courseSource/finish` → 标记「学完」 |
| 弹题时刻 | 暂停视频、弹出习题，提交后继续播放 |

脚本只做三件事：**驱动播放器**（`play()` / `playbackRate` / 暂停恢复）、**点击目录树切换课时**、**点掉弹窗习题**。
不直接调用 `finish`，不修改请求内容，不伪造观看时长。

## 安装

1. Chrome / Edge 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开安装链接（Tampermonkey 会自动弹安装页）：

   ```
   https://raw.githubusercontent.com/buerka/nuist-sakt-auto/main/sakt-auto.user.js
   ```

   或在 Tampermonkey 面板「新建脚本」，粘贴 `sakt-auto.user.js` 全部内容保存。
3. 确认脚本已启用（图标上显示 1）

## 使用

1. 登录平台，进入「我的课程」→ 任意一门课程（`/students/courseDetail?id=...`）
2. 页面右下角出现面板，点 **「开始自动学习」**
3. 保持该标签页打开（可切到后台，脚本默认静音播放）
4. 想停时点面板 **暂停 / 停止**，或控制台执行 `window.__saktStop()`

停止后再次打开课程页，会显示「开始」按钮；上次的队列仍保留，点开始即从断点继续。

## 面板设置

右下角面板分三页，所有配置存在 `localStorage['sakt.config']`，保存后立即生效。

### 运行

显示剩余节数、当前课时、播放进度；提供暂停 / 停止按钮。右上角圆点绿色表示正在自动运行。

### 设置

| 项 | 默认 | 说明 |
|---|---|---|
| 播放倍速 | `1.5` | 建议 1~2；太快平台可能判异常 |
| 静音播放 | 开 | 后台标签页也能继续 |
| 自动答题 | 开 | 关闭后弹题会暂停，等你手动作答 |
| 自动切下一节 | 开 | 播完自动进入下一节 |
| 默认选项 | `A` | AI 未启用或失败时选第几个选项 |

### AI

| 项 | 说明 |
|---|---|
| 启用 AI 答题 | 打开后弹题优先请求 AI |
| 接口地址 | OpenAI 兼容的 base URL，脚本会拼 `/chat/completions` |
| API Key | Bearer Token，只存在本机 `localStorage` |
| 模型 | 例如 `deepseek-chat`、`qwen-plus`、`glm-4` |
| 超时(ms) | 单次请求超时，默认 20000 |

常见接口地址示例：

```
DeepSeek     https://api.deepseek.com/v1
阿里百炼     https://dashscope.aliyuncs.com/compatible-mode/v1
智谱 GLM     https://open.bigmodel.cn/api/paas/v4
Kimi         https://api.moonshot.cn/v1
本地 Ollama  http://127.0.0.1:11434/v1（模型填本地模型名）
```

点「测试连接」会发一条最小请求，返回 `1` 即配置正确。

> 油猴环境优先用 `GM_xmlhttpRequest` 发请求，可绕开浏览器的跨域限制；直接注入/控制台模式会退回 `fetch`，需要接口本身允许 CORS。

## 答题记录

自动作答的题目、选项、来源（AI / 默认）会记录在 `localStorage['sakt.quizlog']`，AI 答案缓存在 `sakt.aiCache`：

```js
JSON.parse(localStorage.getItem('sakt.quizlog')).slice(-10)
```

> 弹窗习题平台**不校验对错**，提交即放行；但选错会计入课程页左上角的「答错」计数。AI 也可能答错，介意的话把「自动答题」关掉，手动作答后脚本会自动续播。

## 常见问题

**Q：AI 会不会答错？**
会。题目多是安全常识，主流模型准确率不低，但不保证。脚本会在 AI 失败时回退到「默认选项」，并把失败原因写进 `quizlog.aiError`。

**Q：API Key 安全吗？**
Key 只保存在本机 `localStorage['sakt.config']`，不会发给学校平台；但同源页面脚本理论上可读，公用电脑上不建议保存。

**Q：会被判定作弊吗？**
不知道。视频是真实按倍速播放的，进度由平台自己的接口上报；但「自动点击、自动答题」本身属于自动化行为，是否合规取决于学校规定，**风险自负**。

**Q：为什么不用直接调接口秒刷？**
那样等于伪造学习记录。本脚本刻意不这么做——它只加速「人不用盯着」这件事，不跳过内容。

**Q：卡住不动 / 切不到下一节？**
刷新页面即可，队列会保留并自动续跑。若某节课目录结构特殊导致点不到，脚本会依次回退到 SPA 路由跳转、整页跳转。

**Q：支持其他学校/平台吗？**
目录、接口、DOM 都是该平台（杰畅教育系统）专有的，其他平台需要改 `@match`、接口路径和选择器。

## 免责声明

本项目仅供**本人已选课程、本人账号**的自动化辅助使用，目的是免去手动点「下一节」。
请勿用于代刷他人账号、售卖或任何牟利行为；使用前请确认符合所在学校/单位的规定。
因使用本脚本导致的账号异常、成绩问题或其他后果，作者不承担任何责任。

## License

[MIT](./LICENSE)