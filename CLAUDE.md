# CLAUDE.md — Orchestra Lens（编排透镜）

Luker 第三方扩展：给内置 `orchestrator`（多智能体编排）做的可视化工作台。姊妹项目 memory-lens（`../memory-lens`），设计语言、工具函数、约定都沿用它。当前版本 0.3.0。仓库 https://github.com/xzhouzhou758/orchestra-lens ，用户在 Luker「扩展 → 安装扩展」粘贴该地址安装；改 manifest.json 和 package.json 的 version 后 Luker 会提示更新。

## 用户的硬性要求（沿用 memory-lens）

1. 全中文界面（快捷键名除外）。内置 agent / 工具 / 阶段 id 在 `src/i18n.js` 里映射成中文；用户自定义的 id 原样显示（是他们自己起的名字）。
2. 简单友好，不暴露技术参数。
3. 风格：石墨灰、青绿强调 `#3fd0b4`、琥珀 = 正在工作、手写 SVG 图标、无毛玻璃渐变。不照搬任何第三方项目。
4. 回复用户用中文。

## 命令

```bash
npm test             # node:test，无依赖（37 个用例）
npm run preview      # http://127.0.0.1:4174/preview/index.html
# 预览参数：mode=spec|single|agenda|loop|director  run=live|done|partial|rerun|none  at=0.55（partial 停在哪）
#           view=flow|run|history|stats  theme=dark|light  select=<agentId>  seg=<n>  off=1  data=error  speed=1
#           ai=1（打开 AI 助手）  ai=diag（诊断当前运行）；preview/mock-ai.js 是脚本化的假模型和内存保存
# 运行面板预览：/preview/dock.html?stage=search|orch|done|live  mode=…  at=0.5  theme=…  expand=<n>
```

改完：`npm test` + `node --check`；界面用无头 Chrome 截 1440×900 和 390×844（注意 headless `--window-size` 的视口比截图宽，手机布局以浏览器面板 375 宽为准）。

## 架构

```
index.js              入口：魔法棒菜单「编排透镜」+「运行面板」；一加载就启动录制器 + 接管原生运行面板（关着透镜也记录）
src/app.js            外壳：状态、加载、实时刷新、布局、快捷键、手机底部抽屉
src/source-luker.js   读设置/角色卡方案、导入 run-state/store.js、开关/切模式、打开原生面板
src/model/profile.js  纯函数：五种模式的 profile → 统一的 flow { columns, agents, limits }
src/model/run.js      纯函数：录到的 run → 每位助手的时间段（lanes/segments）、并发峰值
src/model/describe.js 纯函数：工具调用 / 输出 → 一句中文描述（运行面板每位助手下面那几行）
src/dock/             运行面板：dock.js（UI）、dock-model.js（纯函数：按步骤/轮次分组）、takeover.js（找到所有 store、隐藏原生面板）
src/model/recorder.js 可同时订阅多个运行面板 store（attach(store, 'orchestrator'|'search')），给每个 section 打时间戳，结束后存 localStorage 'orchestraLens.history.v1'（最多 30 条，正文截断 24k）
src/views/            flow-view（卡片 + SVG 连线）、run-view（泳道时间线 + 详情）、history-view、sections（渲染思考/输出/工具/调度决定）
src/panels/           inspector、dialog
src/model/edit.js     纯函数：五种模式下每位助手可改的字段（system/task/description/api/preset）在 profile 里的位置、读写、diff、mergeChanges（保存时叠到最新存档上并找冲突）
src/model/drafts.js   未保存修改（按字段的改动列表，不是整份副本）；重新加载后自动丢掉已存的、保留别的
src/model/ai.js       纯函数：AI 工具（olens_read_agent / read_step / replace_text / set_field，在副本上执行）、提示词（助手 + 诊断）、对话循环 runTurn
src/model/stats.js    纯函数：按历史记录算每位助手的用时 / 出错率 / 占时
src/source-write.js   Luker 写回（edit.save / options）和 AI 调用（ai.request / sessions / replyFor）
src/panels/           ai-panel（AI 助手 + 诊断）、change-list（改动清单 + 原文对比）、field-editor（详情栏里的可编辑块）
preview/              mock-store.js（同名方法的假 store）、mock-data.js（五种模式的方案 + 按真实 id 规则写的回放脚本，雾港故事）
```

## 与 orchestrator 的对接（关键事实，改动前先看）

验证基于 Luker 2.8.0（commit 3936836），源码在 `public/scripts/extensions/orchestrator/`。

- 设置：`extensionSettings.orchestrator`，`executionMode` ∈ spec/single/agenda/loop/director，`presetLibraries[mode][id]` + `activePresetIds[mode]`。角色卡：`data.extensions.orchestrator.{presetLibraries, activePresetIds}` 优先。agenda 还可能有 `chatOverrides[chatKey].agenda.enabled`。single 模式没有方案库，用 `singleAgentSystemPrompt/UserPromptTemplate`。
- **不调用 `getEffectiveProfile`**（有迁移和默认种子的副作用）；自己按上面顺序解析，只用 `preset-library.js` 的 `getPreset` 做无副作用的规整。
- 开关 / 切模式：优先触发原生控件（`#luker_orch_enabled` input、`#luker_orch_execution_mode` change），这样原生面板同步刷新；没有原生面板时直接写设置 + `saveSettingsDebounced`。已在真实 Luker 里验证。
- 刷新：`SETTINGS_UPDATED`（每次 saveSettings 都发）、`CHAT_CHANGED`、角色事件、`luker.orchestrator.result`。
- 运行数据：`run-state/store.js` 默认导出（基于 `/scripts/run-panel/store.js`）。事件只带 id，数据要 `getCurrentRun()` 读。只有当前一次运行，所以历史靠我们自己存。round/section id 规则（`model/run.js` 顶部注释）：
  - spec：`stage-<阶段>[-replay-N]`，每个节点一个 section `node-<id>`（输出在节点结束时一次性写入，无流式）；single 走 spec，mode 字符串仍是 'spec'
  - agenda：`node-agenda_planner-<轮>`（section meta.output 是调度决定）、`node-<agent>-<todo>-<轮>`、`node-<final>-final`
  - loop：`agent-<轮>`；director：`main-<轮,0起>`、`sub-<agent>-<派遣号>`（并发）
- 用户停止：spec/agenda/loop 会以 `error` + "Orchestration aborted." 结束 → `displayStatus()` 显示为「已停止」。director 可能 `finishRun` 两次，录制器只认第一次。
- `quiet: true` 是工作台模拟运行，不进历史、不点亮流程图。
- director 不发 `luker.orchestrator.result`、不存楼层快照；其他模式的楼层快照（只有最终结果）通过 `snapshot-cache.js` `getLoadedAnchorMap` 读，显示在历史页「更早的结果」。

## 运行面板（接管原生面板）

- Luker 有两个原生运行面板：编排器（`#luker-orch-run-panel`）和联网搜索（`#luker-search-tools-run-panel`），都用 `/scripts/run-panel/` 的共用代码，运行开始时自动从右侧滑出。
- 搜索的 store 是私有的（`search-tools/main.js` 里的 `searchRunPanel`，没导出）。`takeover.js` 包了一层 `PanelRenderer.prototype.handle`：每个原生面板收到事件时会把 `this.store` 交给我们（`this.root.id` 区分来源）。**不改 Luker 代码**，原来的 handle 照常执行。
- 接管时给 `<html>` 加 `ol-takeover`，CSS 隐藏 `.luker-run-panel` 和它的胶囊。原生面板被 Luker 的「显示运行面板」按钮打开时，MutationObserver 看到 `data-state=open` → 打开我们的面板（运行开始 800ms 内的自动打开忽略）。
- 开关：localStorage `orchestraLens.takeover`（'off' = 用原生面板），面板底部「用原生面板」和透镜历史页都能改，刷新后生效。自动打开偏好在 `orchestraLens.dock.v1`。
- **定位的坑**：手机上 Luker 给 `<html>` 加了 transform 且高度为 0，`position:fixed; bottom:0` 会跑到屏幕顶上。面板、遮罩、胶囊都用 `viewport.js` 按 visualViewport 量出来写 px（`fitToViewport(root, { layout })`）。电脑上宽度 = 聊天栏右侧空白（`--sheldWidth`），夹在 320–420px。
- 搜索 round id 是 `round-<n>`，在 run.js 里映射成一位「搜索助手」（`search_agent`）。

## 修改与 AI（0.3.0）

- 可改：每位助手的 角色设定 / 任务模板 / 说明（仅导演子助手）/ 连接配置 / 生成预设。增删助手、步骤、工具开关不做（用户说过要简单）。位置见 `edit.js` `locate()`：spec 写 `presets[preset]`（节点自带 userPromptTemplate 时写节点）；single 写 `singleAgentSystemPrompt/UserPromptTemplate`；agenda 写 `planner` / `agents[id]`；loop 写顶层 `system_prompt`；director 写 `mainAgent` / `subAgents[]`（子助手 systemPrompt 不能为空，否则 sanitize 会删掉它）。
- 保存目标 `snapshot.target = { mode, scope: global|character|chat|factory, presetId, avatar, chatKey }`。factory = 还没存过方案，不能改（提示先在原生面板保存一次）。保存：重读同一目标 → `mergeChanges` 只叠改过的字段 → 冲突（那个字段在别处也改了）弹窗确认 → 写回 → `editor-state.js initializeUiState(ctx)` + 触发 `#luker_orch_execution_mode` change，让原生编辑器丢掉旧草稿（不然它下次保存会把我们的改动盖回去，已在真实 Luker 验证）。撤销 = 用反向改动强制保存。
- 角色卡写回用 `getExtensionApi('orchestrator').persistOrchestratorCharacterExtension`；`writeExtensionField` 不发事件，所以别处改角色卡后透镜不会自动刷新（通常原生面板随后会 saveSettings 触发刷新）。
- AI：`requestToolCallsWithRetry(ctx, {toolCallRetryMax, rpmLimit}, {taskMessages, apiPresetName, llmPresetName, tools, includeAssistantText:true, allowNoToolCalls:true})`。模型默认 = 编排器 `requestApiPresetName/requestLlmPresetName`（迭代 AI），透镜自己的选择存 `extensionSettings.orchestra_lens.ai`。用户的生成预设（含破限）照常包在外面，不要动。对话存 localStorage `orchestraLens.ai.v1`，按 target 分组，每组最多 12 条。
- AI 在自己的副本上改；一轮结束 `diffProfiles(草稿, AI 副本)` 得到改动清单，勾选后进草稿；没勾的 / 撤销的会回写到 tool_result 让 AI 知道。
- 统计诊断（统计页「AI 诊断」/ 每行的靶心）：`statsEvidence(stats, views, {focus})` 挑出要看的助手（出错的优先，再按占时）各自的出错段、最慢段、最快段（对照），编号 E1…，和统计表一起用 `statsMessage` 发出；session.kind='stats'，统计和证据冻结在 `session.statsCtx`（存档时证据截到 8000 字），olens_read_step 读的是证据编号。提示词 `STATS`：先分清接口错误（429/超时/key/上下文超长 → 换连接，不改提示词）和提示词/模型问题；慢就对比快慢两次。
- 诊断：`runSteps(view)` 把运行编号成步骤（短摘要进首条消息，全文用 olens_read_step 取）；首条消息还带最终结果和主模型回复（`replyFor`：run.floor 之后第一条非用户消息）。入口：运行页「AI 诊断」、时间线段「诊断这一步」、详情栏「AI 诊断这一步」、运行面板底部。
- 已在真实 Luker 2.8.0 验证（临时数据目录 + 本地假 OpenAI 兼容接口）：通用方案保存 / 撤销 / 落盘、原生编辑器草稿同步、角色卡方案写入（png 里有）、冲突提示、AI 三轮工具调用、诊断入口。未用真实模型测过提示词效果。

## 已验证 / 未验证

- 已在真实 Luker 2.8.0（临时数据目录）中验证：菜单项、读默认 spec 方案、开关与切模式同步原生面板、用真实 store 驱动时实时显示与历史记录；运行面板接管（编排 store + 用 search-tools 自己的 createSearchRunPanel 建的面板）、原生面板隐藏、「显示运行面板」按钮跳到我们的面板、手机底部抽屉/胶囊定位、改回原生面板后完全恢复。
- 未验证：真实模型跑完整一轮、角色卡方案、agenda chatOverrides、Safari/iOS 真机。
