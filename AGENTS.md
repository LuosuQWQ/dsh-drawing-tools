# AGENTS.md — dsh-drawing-tools

Machine-actionable notes for coding agents. Human documentation: [README.md](README.md) / [README.zh-CN.md](README.zh-CN.md).

## What this package is

A DeepSeek Harness bundle (`dsh-drawing-tools`) that mounts eleven model-facing tools and one agent preset. It talks HTTP only to a local ComfyUI; it contains no models and no credentials.

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

## Constraints for contributors

- Do not preset ComfyUI/model paths; discover them.
- Do not commit tokens, machine paths, or personal data; `npm test` includes static contract checks.
- Keep the persona gated: draw only on an explicit request.

## Verify

```sh
npm test                         # offline contract, guides, pnginfo, hardware, launch
COMFY_ORIGIN=http://127.0.0.1:8188 node test/check-connection.mjs
```
