# Crosshair（准星）设计说明

> 一句话：准星是一个通用的网页指令执行助手。模型只从页面元素清单里选编号，不猜像素坐标；插件按编号找到真实 DOM 元素、算准当前位置、发出真实鼠标点击，并在点击后校验页面是否变化。
>
> 第 1 节的根因证据来自一次对点击偏移问题的复盘（分析对象是另一个自动化工具的报告），只作为设计背景；准星不依赖、也不修改该工具。

本文件同时是给协作成员看的接口契约，实现必须遵守第 5 节的格式。

---

## 1. 设计动机（为什么不让模型给坐标）

浏览器自动化里最常见的一类失败是"点偏"：模型在截图上估算坐标，缩放、滚动或元素重排稍微差一点，点击就落到按钮旁边的空白处；页面没反应，模型下一轮又给同一个坐标，于是反复点错。

准星的思路是**不赌模型的坐标估计**：

1. 每步把当前视口截图 + 可见元素清单（编号、文字、位置、尺寸、颜色、状态）交给模型；
2. 模型只返回"点第几号元素"或"选哪一项"，不返回像素坐标；
3. 插件按编号重新查真实 DOM 元素，算它当前的矩形中心，再发真实鼠标事件；
4. 点击后比较 URL 和页面文本签名，确认页面真的变了；没变就把提示带回给模型，让它换策略。

这条链路对下拉、图表、拖拽等组件同样成立：**能用 DOM 语义定位的用元素编号，只能用坐标的场景（图表数据点）才用截图坐标，并且不吸附到别的元素**。

## 2. 目标与非目标

目标：

1. 以 Chrome 插件形式，用 DeepSeek 官方 API（`https://api.deepseek.com`，模型 `deepseek-flash`）执行用户用自然语言描述的网页操作（通用，不绑定具体业务）。
2. 点击必须落在元素上，而不是模型猜的像素点；点击后能发现"页面没变化"并换策略。
3. 支持循环任务：列表点复制 → 日历选红色日期 → 提交 → 确定 → 自动回列表 → 继续，直到没有可填红日期。
4. 交互参考 Midscene Playground：指令式输入（自然语言 + Run），并支持多轮对话——运行中可以继续发补充指令，上一轮的指令和结果会作为下一轮的上下文。
5. 全部动作有日志、可导出，可复盘。
6. 提供仿真页面与自动化测试，验证端到端流程（含多轮对话场景）。

非目标：

- 不修改任何第三方自动化工具的源码或配置：准星是独立实现。
- 不处理跨域 iframe、跨窗口多标签的复杂场景（标签页内跳转、新开标签会处理）。
- 不做验证码、登录等人工环节替代。

## 3. 架构

```
┌────────────────────────────── Chrome 扩展（MV3） ──────────────────────────────┐
│ sidepanel.html（对话面板 + 引擎都跑在这里，页面不卸载就不会被 Service Worker 回收）│
│   ├─ 对话区：用户指令气泡 / 助手结果气泡 / 运行中进度气泡；下方是执行日志与输入框 │
│   ├─ engine.js   循环：截图 → 收集元素 → 问模型 → 执行 → 校验 → 记录           │
│   ├─ planner.js  构造提示词 / 解析模型 JSON / 纠正非法输出                       │
│   ├─ deepseek.js 调 https://api.deepseek.com/chat/completions（JSON Output）    │
│   ├─ cdp.js      chrome.debugger：截图、真实鼠标点击、处理原生弹窗              │
│   ├─ inventory.js 注入页面：可见元素清单 + 颜色 + 位置 + 稳定编号               │
│   └─ logger.js   运行状态写 chrome.storage.local（runState），面板实时渲染       │
│ background.js   只负责点图标打开侧边栏                                          │
│ options.html    设置：API Key、模型、思考强度、步数上限、点击后等待等            │
└───────────────────────────────────────────────────────────────────────────────┘
```

循环每一步：

1. 等页面稳定（URL/文本签名连续 400ms 不变）。
2. `Page.captureScreenshot` 截当前视口（大图等比缩到宽 ≤1200）。
3. 注入脚本收集"可见且可能被点"的元素：编号、标签、文字、视口坐标、背景色/文字色、是否禁用、所在表格行文字；同时算页面签名。
4. 把「任务 + 当前页面信息 + 最近 10 步历史 + 元素清单 + 截图」发给 DeepSeek，要求只返回 JSON 动作。
5. 动作是 `click` 时：按编号在页面里重新查到元素（防止元素被重建）→ 滚动到视口中央 → 取最新矩形中心 → `Input.dispatchMouseEvent` 发真实鼠标按下/抬起（CDP，事件 `isTrusted=true`）。
6. 等待并校验：URL 或页面文本签名变化才算"页面有变化"；连续多次无变化时把提示写回给模型，避免在同一个错位置反复点。
7. 记录日志，进入下一步；模型返回 `done` / `fail`、步数到上限、用户点停止时结束。

## 4. 目录结构

```
crosshair/
├── DESIGN.md / README.md
├── extension/            # 插件本体（可直接"加载已解压的扩展程序"）
│   ├── manifest.json
│   ├── background.js
│   ├── sidepanel.html / sidepanel.css / sidepanel.js
│   ├── options.html / options.js
│   ├── lib/*.js
│   └── icons/
├── mock/                 # 仿真工时系统（列表页 + 日历页 + 提交弹窗）
├── tests/                # 自动化测试：假模型服务、CDP 驱动、真实模型端到端
└── scripts/              # 打包/辅助脚本
```

## 5. 契约

### 5.1 chrome.storage.local

`settings`（options 页写入，默认值如下）：

```json
{
  "apiBase": "https://api.deepseek.com",
  "apiKey": "",
  "model": "deepseek-flash",
  "thinking": "enabled",
  "reasoningEffort": "low",
  "maxSteps": 120,
  "clickDelayMs": 700,
  "screenshotQuality": 72,
  "maxImageWidth": 1200,
  "dryRun": false,
  "taskPrompt": "",  // 常用指令模板，用户可在设置页保存自己常用的一段指令；为空时侧边栏用内置示例
}
```

`conversation`（多轮对话记录，跨运行保留，最多 40 条）：

```json
[
  { "role": "user", "kind": "instruction", "text": "点击页面右上角的「新建」按钮，填写标题并保存…", "at": 1792737041581 },
  { "role": "user", "kind": "injection",   "text": "补充：下一步继续，但不要点灰色日期", "at": 1792737045581 },
  { "role": "assistant", "kind": "result", "status": "done", "text": "全部日期已填报", "at": 1792737051581 }
]
```

`runState`（引擎每步写入，面板/测试只读）：

```json
{
  "id": "uuid",
  "status": "idle|running|done|failed|stopped",
  "task": "…",
  "step": 3,
  "startedAt": 1792737041581,
  "endedAt": null,
  "tabId": 123,
  "stats": { "apiCalls": 3, "promptTokens": 0, "completionTokens": 0, "clicks": 2, "noChangeStreak": 0 },
  "logs": [
    { "step": 1, "at": 1792737041581, "action": "click", "element": 12,
      "elementText": "复制", "reason": "…", "result": "ok|stale|error",
      "pageChanged": true, "url": "…", "apiMs": 1820, "tokens": 4100 }
  ]
}
```

### 5.2 模型动作 JSON（引擎只接受这一种结构）

```json
{"action":"click","element":12,"reason":"点击第一行复制按钮","memo":"选定第1周"}
{"action":"clickPoint","point":[884,700],"reason":"目标不在清单里"}
{"action":"scroll","direction":"down","amount":600,"reason":"…"}
{"action":"wait","ms":1200,"reason":"等页面加载"}
{"action":"back","reason":"该周没有红色日期，返回列表"}
{"action":"done","summary":"所有未填写日期已填报"}
{"action":"fail","reason":"…"}
```

- `element` 是元素清单里的编号（整数）。
- `point` 只作为兜底：截图像素坐标，引擎会换算成视口 CSS 坐标，并尝试吸附到附近元素再点击。
- 解析容错：去掉 \`\`\`json 围栏，取第一个 `{` 到最后一个 `}`；非法时把错误原因追加给模型重试一次。

### 5.3 元素清单文本格式（模型输入 / 假模型服务按此解析）

```
页面: http://127.0.0.1:8081/list.html
标题: 订单列表 - 示例后台
视口: 1280x800 像素, 页面缩放比 1, 滚动位置 y=0
弹窗: 无
页面签名: a1b2c3d4
可用元素（格式：[编号] 标签|角色|文字|x,y|尺寸w,h|底色|字色|表格行|状态）：
[0] div|button|"+ 新建"|1000,116|120,32|#2f6bff|#ffffff|-|-
[1] button|button|"复制"|884,171|48,24|#ffffff|#2f6bff|2026-10-08·8h·演示用户·审核中|-
[2] div|gridcell|"14"|632,420|36,36|#ffffff|#e60000|2026-10-05~2026-10-11|-
[3] div|gridcell|"15"|676,420|36,36|#eeeeee|#e60000|2026-10-05~2026-10-11|disabled
```

规则：

- 每行可点击元素一行，编号从 0 开始；`-` 表示空字段。
- 颜色统一转成 `#rrggbb`，透明底色写 `-`。
- 清单最多 300 个元素，只含当前视口内可见元素。
- 日期格要在 `表格行` 字段带所在周范围，方便模型判断"今天及以前”。
- 日期格的状态用颜色区分：红=白底红字（`#ffffff`/`#e60000`），绿=绿字（`#17803d`），灰底红=`#eeeeee`/`#e60000`，未来日期=灰字（`#b0b4bd`）。清单里不额外给 class 字段，假模型服务按颜色判断日期状态。

### 5.4 sidepanel 测试钩子（本地开发用；URL 带 `?autostart=1` 时挂到 window 上）

```js
window.__testMode === true
window.startRunForTest({ task, tabId, settings }) -> Promise<runState>   // settings 可覆盖 storage 里的配置
window.stopRunForTest() -> void
window.injectMessageForTest(text) -> { ok, queued }     // 运行中追加补充指令
window.getConversationForTest() -> string               // conversation 的 JSON 字符串
window.__runFinished: boolean
window.__runResult: runState | null
```

### 5.4.1 多轮对话与补充指令

- 面板是对话式界面（参考 Midscene Playground）：上方对话区，中间可展开执行日志，下方指令输入框 + 执行/停止按钮。
- 空闲时发送一段文字 = 开始一轮新任务，该文字以 `kind:'instruction'` 写入 conversation。
- 运行中发送文字 = 补充指令：
  - 以 `kind:'injection'` 写入 conversation，立刻在日志里记一条 `action:'notice'`、reason 含「收到补充指令」。
  - 下一步模型请求的 user 文本里出现「用户在本轮运行中补充的指令（优先级最高）」小节；再下一步日志出现 reason 含「把用户补充指令交给模型」。
  - 当前这一步不会被中断，注入内容在下一步生效。
- 每轮结束（done/failed/stopped）向 conversation 追加一条 `role:'assistant', kind:'result', status` 消息，内容是 summary 或错误原因。
- 新一轮任务的模型请求里会带「多轮对话上下文（本次任务之前的对话）」小节（最近 12 条），因此可以发「继续」「再检查一遍」这类追问。
- 插件不把上一轮的完整截图/元素清单塞回上下文，只回放文字对话与每轮结果，控制 token 消耗。

## 6. 安全

- API Key 只存 `chrome.storage.local`；仓库与测试脚本中不得出现任何 key。
- 运行日志不打印 Authorization 头与 key。
- 插件不做页面数据外传，只把截图和元素清单发给用户配置的 API 地址。
