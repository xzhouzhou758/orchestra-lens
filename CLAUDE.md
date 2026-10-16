# CLAUDE.md — Orchestra Lens（编排透镜）

Luker 第三方扩展：给内置 `orchestrator`（多智能体编排）做的可视化工作台。姊妹项目 memory-lens（`../memory-lens`），设计语言、工具函数、约定都沿用它。当前版本 0.1.0。仓库 https://github.com/xzhouzhou758/orchestra-lens ，用户在 Luker「扩展 → 安装扩展」粘贴该地址安装；改 manifest.json 和 package.json 的 version 后 Luker 会提示更新。

## 用户的硬性要求（沿用 memory-lens）

1. 全中文界面（快捷键名除外）。内置 agent / 工具 / 阶段 id 在 `src/i18n.js` 里映射成中文；用户自定义的 id 原样显示（是他们自己起的名字）。
2. 简单友好，不暴露技术参数。
3. 风格：石墨灰、青绿强调 `#3fd0b4`、琥珀 = 正在工作、手写 SVG 图标、无毛玻璃渐变。不照搬任何第三方项目。
4. 回复用户用中文。

## 命令

```bash
npm test             # node:test，无依赖（18 个用例）
npm run preview      # http://127.0.0.1:4174/preview/index.html
# 预览参数：mode=spec|single|agenda|loop|director  run=live|done|partial|rerun|none  at=0.55（partial 停在哪）
#           view=flow|run|history  theme=dark|light  select=<agentId>  seg=<n>  off=1  data=error  speed=1
```

改完：`npm test` + `node --check`；界面用无头 Chrome 截 1440×900 和 390×844（注意 headless `--window-size` 的视口比截图宽，手机布局以浏览器面板 375 宽为准）。

## 架构

```
index.js              入口：魔法棒菜单 #orchestra_lens_wand_item；启动后 1.5 秒就挂上录制器（关着界面也记录）
src/app.js            外壳：状态、加载、实时刷新、布局、快捷键、手机底部抽屉
src/source-luker.js   读设置/角色卡方案、导入 run-state/store.js、开关/切模式、打开原生面板
src/model/profile.js  纯函数：五种模式的 profile → 统一的 flow { columns, agents, limits }
src/model/run.js      纯函数：录到的 run → 每位助手的时间段（lanes/segments）、并发峰值
src/model/recorder.js 订阅运行面板 store，给每个 section 打时间戳，结束后存 localStorage 'orchestraLens.history.v1'（最多 30 条，正文截断 24k）
src/views/            flow-view（卡片 + SVG 连线）、run-view（泳道时间线 + 详情）、history-view、sections（渲染思考/输出/工具/调度决定）
src/panels/           inspector、dialog
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

## 已验证 / 未验证

- 已在真实 Luker 2.8.0（临时数据目录）中验证：菜单项、读默认 spec 方案、开关与切模式同步原生面板、用真实 store 驱动时实时显示与历史记录。
- 未验证：真实模型跑完整一轮、角色卡方案、agenda chatOverrides、Safari/iOS 真机。
