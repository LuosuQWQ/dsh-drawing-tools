# 模型用法指南 / Model usage guides

English index: [README.en.md](README.en.md)（英文目录；正文为中文，供 agent 读取）

`drawing_guide({ family })` 读取本目录下的某一族用法说明，返回给绘画 agent。
目的：选到某个模型族时，先按官方文档写的提示词格式、分辨率、参数和坑来出图，
不要凭记忆编造。

| family | 文件 | 何时读 |
| --- | --- | --- |
| `moss` | [`moss.md`](./moss.md) | 画面里要有准确的中英文文字、海报/白板/说明图、要控文字或物体位置 |
| `krea2` | [`krea2.md`](./krea2.md) | 写实/摄影/电影感、复杂场景、强风格化插画，愿意等 1–4 分钟 |
| `anima` | [`anima.md`](./anima.md) | 动漫/插画/角色，需要 Danbooru tag、画师风格、turbo 快速出图 |
| `classic` | [`classic.md`](./classic.md) | SD1.5 / SDXL / Pony 等 checkpoint，最快草图；或作为降级兜底 |
| `generic` | [`generic.md`](./generic.md) | 没有内置族的扩散模型：自己给 textEncoder + vae（.gguf 自动走 UnetLoaderGGUF） |

| — | [`prompt-patterns.md`](./prompt-patterns.md) | 想要现成模板时读：9 个本机实测过的提示词模板、负面词包、风格词速查、选族速查。用 `drawing_guide({ family: 'prompt-patterns' })` 取。 |

规则：`family` 不传时返回本索引。没有内置族的扩散模型用 `generic`（见 [generic.md](./generic.md)），必须自备 textEncoder + vae。指南只描述该族的写法和参数；真实可用的模型名、文件
路径、实际生效参数一律以 `drawing_models` / `drawing_status` / `drawing_generate` 的返回为准。

## 缺模型 / 缺 LoRA 时

不要因为目录里没有就跳过，也不要直接拒绝：

1. `drawing_models` 确认到底缺哪个文件、属于哪一族。
2. 用 `drawing_download({ action: 'search', query: '<文件名或模型名>', kind: 'lora' })` 搜候选
   （默认同时搜 Civitai 与 Hugging Face；`source` 可限定单一来源）：

   Civitai 返回名称、baseModel、versionId、文件名、大小与 sha256；
   Hugging Face 返回仓库 id 与热度，文件列表用 `action: 'files', repo: 'org/name'` 再看。

   结果里的「来源状态」会列出每个站点的成败与切换顺序；失败的站点会立刻跳过，不影响继续搜下一个。

   来源不止一个站：Civitai 主站 `civitai.com`、镜像 `civitai.red`；Hugging Face 主站 `huggingface.co`、镜像 `hf-mirror.com`。工具会自动切换，不用自己拼地址。

3. 装进 ComfyUI 的模型目录：

   ```
   drawing_download({ action: 'download', source: 'civitai', modelVersionId: <versionId>, kind: 'lora', sha256: '<候选里的 sha256>' })
   drawing_download({ action: 'download', source: 'huggingface', repo: '<org/name>', file: '<path/in/repo>', kind: 'lora' })
   ```

   安装是规范化的：按 `kind` 落到 `loras` / `checkpoints` / `diffusion_models` /
   `vae` / `text_encoders` / `controlnet` / `embeddings` / `upscale_models` /
   `clip_vision`；文件名会去路径、去控制字符、补扩展名，同名不覆盖而是加 `-2`；
   校验 SHA256；并在 models 根下 `.dsh-install/<目录>/<文件>.json` 写一条来源记录。
   目标目录来自 ComfyUI 自报或插件行 `config.modelsRoot`，不猜。

   泛网只用来找线索：`action: 'find'` 返回链接，确认可信后再把直链交给
   `downloadUrl` 安装。

   凭据由宿主处理：DSH 的凭据库（设置 → AI 绘画 里填一次）优先，其次环境变量
   `CIVITAI_TOKEN`。不要向用户要 token，也不要把 token 写进命令或回复。

4. 再用 `drawing_models` 复核文件确实出现，然后继续出图。文件已在目录里但列表没刷新时，
   重启 ComfyUI（`scripts/start-comfyui.ps1 -Stop` 再 `-Wait`）后重查。

5. 搜不到、下载失败或被拒：告诉用户缺哪个文件、应该放到哪个目录，**停下，不提交
   `drawing_generate`**。
6. 用户点名要 LoRA / 指定模型 / 参考工作流需要的文件也算「必需」：不要用「先不加也能出」
   当理由继续出图；只有用户明确说「没有也继续」才出。

## 多 LoRA 与在 ComfyUI 里复现

多个 LoRA 用数组传，按顺序叠加（每项一个 LoraLoader，MODEL 与 CLIP 都串起来）：

```
drawing_generate({ prompt: '...', lora: [{ name: 'style/a.safetensors', strength: 0.7 }, { name: 'char/b.safetensors', strength: 0.5 }] })
```

强度是叠加的：总强度建议不超过 1.5，角色 + 风格各 0.5–0.8 是常见组合。单个 LoRA 仍可写成 `"name:0.8"`。

每次生成都会：提交到 ComfyUI 队列（`client_id=dsh-drawing-tools`）；把 UI 版工作流写进 ComfyUI 的 Workflows 列表（`dsh-drawing-<时间>.json`）；把同一份工作流嵌进 PNG。所以可以在 ComfyUI 的 Queue 面板看到它、在 Workflows 列表打开它，或把 PNG 拖回画布复现。

## 触发词与模型元数据

触发词有三种形态，工具分开保存、分开显示，用法也不同：

| 形态 | 例子 | 怎么用 |
| --- | --- | --- |
| 一组词 `trainedWords` | `lineart`, `monochrome` | **一起**写进 prompt；少一个可能不生效 |
| 备选 `triggerAlternatives` | `lineart \| line art`、`a or b` | **只选一组**，按画面挑最贴的 |
| 描述提示 `triggerHints` | 作者在 model card 里写 "Trigger words: …" | 按作者的用法与权重写法来 |

- 从 Civitai 安装会保存 `trainedWords` / `triggerAlternatives` / `triggerHints` / `baseModel` / 标签 / 页面链接；
  Hugging Face 保存 tags / pipeline，卡片里有 `instance_prompt` 或 `trigger_word` 时作为触发词。
- 元数据写在 `<models>/.dsh-install/<目录>/<文件>.json`，**离线**可读，来源失效后也在。
- `drawing_models` 每个文件带 `triggerWords` / `triggerAlternatives` / `triggerHints` / `baseModel` / `source`；
  `drawing_pnginfo` 审计依赖时把已安装文件的触发词附上，方便照着原图复刻；`drawing_download` 装完直接打印。
- 同一模型有多种写法、用户又没指定时：优先用**复刻原图里出现过**的那个（`drawing_pnginfo` 会标「原图用了」）；仍不确定就用 `drawing_guide({ family })` 的规则，别自己发明。

## 野生 LoRA（没有来源、也没出过图）

来源记录和原图都没有时，模型文件自己也带信息：`.safetensors` 头里的 kohya / ModelSpec 元数据。
`drawing_models` 会在没有安装记录时自动读头（只读前几 KB，不加载权重），给出：

| 头字段 | 得到什么 |
| --- | --- |
| `ss_base_model_version` / `modelspec.architecture` | 基模（决定用哪个族、怎么提示） |
| `modelspec.trigger_phrase` | 作者写的触发短语 |
| `ss_tag_frequency` | 训练标签 → 过滤通用标签（1girl、solo、long hair…）后的**候选触发词** |
| `ss_network_alpha` / `ss_network_dim` | alpha/dim 比例，帮助判断强度 |
| `ss_resolution` / `ss_clip_skip` | 训练分辨率与 clip skip |

用法建议：
1. 先按候选触发词 + 建议强度 **0.8** 出一张；角色 LoRA 通常第一个候选就是角色标签。
2. 没效果就只留最贴画面的一个候选，或降低到 0.6–0.7 再试。
3. 头也没有（导出时被剥掉）：按画面写提示词，强度从 0.7 起，靠出图效果判断。
4. 一次只改一个变量（触发词 / 强度）。

## 模型官方文档（比族指南更具体）

每个模型可能自带说明（模型卡、生成指南、触发词、推荐参数），它们比族指南更准。规范流程：

1. **获取**：安装时自动抓（Hugging Face 会抓 README 与仓库内说明文件，Civitai 会抓模型/版本描述）；也可手动：
   ```
   drawing_modeldoc({ action: 'fetch', repo: 'org/name', kind: 'lora', model: '<模型文件名>' })
   drawing_modeldoc({ action: 'fetch', versionId: <Civitai versionId>, kind: 'lora', model: '<模型文件名>' })
   drawing_modeldoc({ action: 'import', path: '<本地 md>', kind: 'lora', model: '<模型文件名>' })
   ```
2. **存储**：统一放在 `<models>/.dsh-docs/<类别>/<slug>/`（README.md + index.json，记录来源 URL / 抓取时间 / sha256），跟着模型走、离线可读。
3. **使用**：写提示词前调 `drawing_guide({ model: '<模型文件名>' })` —— 有官方文档就返回它，没有就回退到族指南；`drawing_modeldoc({ action: 'list' })` 可看都存了哪些。

注意：同目录的通用 README.md 只有在提到该模型名时才会被当成它的文档（避免把整个目录的说明误认成单个模型的）。

## 来源

本目录内容整理自各模型官方文档与发布页（用户指南、ComfyUI 说明、官方示例工作流），并按本机实测校准：

- MOSS：`moss-userguide-zh.md`、`moss-userguide-en.md`、`moss-comfyui-readme.md`、
  `moss-prompt-enhancer-SKILL.md`、`README-官方资料与提示词指南.md`
- Krea 2：`krea2-userguide.md`、`krea2-turbo-userguide.md`、`krea-ai__krea-2__main__docs__prompting.md`、
  `krea2-api-overview.md`、`comfy-krea2-tutorial.md`
- Anima：`circlestone-labs__Anima.README.md`、`comfy-anima-tutorial.md`
- 本机实测：`drawing_workflow` 跑的 krea2 t2img API 工作流，
  ComfyUI 0.44.0 / RX 9070 XT 16GB。

官方文档的步数/CFG 会随版本与模板变化；与工具默认值冲突时，以 `drawing_models` 的
`推荐` 行为准，指南只解释「为什么」和「怎么写 prompt」。
