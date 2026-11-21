# AGENTS.md — dsh-drawing-tools

English | [中文](#中文)

Machine-actionable notes for coding agents. Human documentation: [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md).

## What this package is

A DeepSeek Harness bundle (`dsh-drawing-tools`) that mounts twelve model-facing tools and one agent preset. It talks HTTP only to a local ComfyUI; it contains no models and no credentials.

## Install

```sh
git clone https://github.com/LuosuQWQ/dsh-drawing-tools.git
dsh plugin --profile <profile> add link:<absolute path>/dsh-drawing-tools
# restart DSH; the bundle patch inserts drawing-console + the 极简绘画 preset
```

Requirements: DSH 0.2.x, Node 20+, a running ComfyUI (default `http://127.0.0.1:8188`).

## Tools

`drawing_status`, `drawing_models`, `drawing_guide`, `drawing_generate`, `drawing_queue`, `drawing_history`, `drawing_workflow`, `drawing_pnginfo`, `drawing_paths`, `drawing_modeldoc`, `drawing_download`, `drawing_setup`.

Order of use: `drawing_status` → optional `drawing_setup`/`drawing_paths` → `drawing_guide` (family or model) → `drawing_generate` → embed the returned `markdown` field. Missing resources: `drawing_pnginfo` (audit) → `drawing_download` (search/install) → `drawing_models` (verify).

## Configuration and credentials

- Bundle-row config: `origin`, `comfyRoot`, `modelsRoot`, `apiWorkflowsDir`, `uiWorkflowsDir`, `outputDir`, `launch`, `timeoutSeconds`.
- Paths come from ComfyUI's runtime report (`/internal/folder_paths`); config and environment are fallbacks only. Never hardcode a machine path.
- Credentials live in DSH's credential store: `CIVITAI_TOKEN`, `HF_TOKEN`. There is no token parameter on any tool; never print a token.
- Generated files: `<outputDir>/<YYYY>/<MM>/<DD>/<time>_<family>_<model>_s<seed>_<n>.png` plus `.json` sidecars and `index.jsonl`.
- Canvas entry: Desktop opens it in the right sidebar; when DSH runs in a plain browser, the client opens the ComfyUI origin in a new tab instead of failing.

## Installation protocol (agents)

- Before changing anything, tell the owner what you are about to install and why.
- Install the bundle, restart DSH, then open a new session with the **极简绘画 / Minimal drawing** preset. The preset drives the ComfyUI install and launch configuration.
- Ask for full permissions for that session before writing outside the workspace or starting a server.
- Report each step: what was detected (GPU, ComfyUI presence), what was installed, where it lives, and how to open the canvas.

## Constraints for contributors

- Do not preset ComfyUI/model paths; discover them.
- Do not commit tokens, machine paths, or personal data; `npm test` includes static contract checks.
- Keep the persona gated: draw only on an explicit request.

## Verify

```sh
npm test                         # offline contract, guides, pnginfo, hardware, launch
COMFY_ORIGIN=http://127.0.0.1:8188 node test/check-connection.mjs
```

---

<a id="中文"></a>

# AGENTS.md — dsh-drawing-tools（中文）

给编码 agent 的机器可读说明。人类文档：[README.md](README.md) / [README.zh-CN.md](README.zh-CN.md)。

## 这个包是什么

一个 DeepSeek Harness bundle（`dsh-drawing-tools`），挂载 12 个面向模型的工具和一个 agent 预设。它只通过 HTTP 访问本机 ComfyUI，不含任何模型或凭据。

## 安装

```sh
git clone https://github.com/LuosuQWQ/dsh-drawing-tools.git
dsh plugin --profile <profile> add link:<本地绝对路径>/dsh-drawing-tools
# 重启 DSH；bundle patch 会插入 drawing-console 与「极简绘画」预设
```

要求：DSH 0.2.x、Node 20+、一个运行中的 ComfyUI（默认 `http://127.0.0.1:8188`）。

## 工具

`drawing_status`、`drawing_models`、`drawing_guide`、`drawing_generate`、`drawing_queue`、`drawing_history`、`drawing_workflow`、`drawing_pnginfo`、`drawing_paths`、`drawing_modeldoc`、`drawing_download`、`drawing_setup`。

使用顺序：`drawing_status` → 可选 `drawing_setup`/`drawing_paths` → `drawing_guide`（按族或按模型）→ `drawing_generate` → 把返回的 `markdown` 字段贴进回复。缺资源时：`drawing_pnginfo`（审计）→ `drawing_download`（搜索/安装）→ `drawing_models`（复核）。

## 配置与凭据

- 插件行配置：`origin`、`comfyRoot`、`modelsRoot`、`apiWorkflowsDir`、`uiWorkflowsDir`、`outputDir`、`launch`、`timeoutSeconds`。
- 路径以 ComfyUI 运行时自报（`/internal/folder_paths`）为准，配置与环境变量只作兜底；不要写死任何本机路径。
- 凭据存放在 DSH 凭据库：`CIVITAI_TOKEN`、`HF_TOKEN`。任何工具都没有 token 参数；不要打印 token。
- 生成文件：`<outputDir>/<年>/<月>/<日>/<时间>_<族>_<模型>_s<seed>_<序号>.png`，另有 `.json` 侧车文件与 `index.jsonl` 索引。
- 画布入口：桌面版开在右栏；DSH 在纯浏览器里运行时改为新开标签页，不会报错。

## 安装流程（给 agent）

- 动手前先告诉主人你要装什么、为什么。
- 装好 bundle、重启 DSH 后，新建会话并选 **极简绘画** 预设；由预设引导安装 ComfyUI 与启动配置。
- 需要写工作区之外或启动服务时，先请求该会话的完全权限。
- 逐步汇报：探测到什么（显卡、是否已装 ComfyUI）、装了什么、装在哪里、画布怎么打开。

## 贡献约束

- 不预设 ComfyUI / 模型路径，一律探测。
- 不提交 token、本机路径或个人信息；`npm test` 含静态契约检查。
- 人格保持门槛：只在用户明确要求时出图。

## 验收

```sh
npm test                         # 离线契约、指南、pnginfo、硬件、启动
COMFY_ORIGIN=http://127.0.0.1:8188 node test/check-connection.mjs
```
