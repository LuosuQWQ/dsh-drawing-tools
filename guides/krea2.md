# Krea 2 用法指南（family `krea2`）

适用：照片级写实、电影感、强美学/编辑插画、复杂场景与材质。本机是 **Krea 2 Turbo
12B GGUF（Q4）**，质量高但慢，单张 1–4 分钟，必须串行。普通动漫/快速草图不要用它。

## 本机加载方式（照抄，不要改）

| 项 | 值 |
| --- | --- |
| 扩散模型 | `krea2_turbo-Q4_K_M.gguf`（`diffusion_models`，`UnetLoaderGGUF`，需 ComfyUI-GGUF 节点） |
| 文本编码器 | `qwen3vl-4b-fp8-scaled.safetensors`（CLIPLoader，type=`krea2`） |
| VAE | `qwen-image-vae.safetensors` |
| 条件 | CFG=1 时用 `ConditioningZeroOut`（负面词不生效） |
| 默认参数 | 8 步 / CFG 1 / `euler` / `simple` / 1024×1024 |

- 本机实测另一条可用参数：10 步 / CFG 1 / `er_sde` / `simple`（`drawing\workflows\krea2-t2img-api.json`）。
- 官方 Turbo 参考值：8 steps / CFG 0 / mu 1.15；ComfyUI 模板按采样器实现差异用 8 / CFG 1 / `euler`。
- 官方 RAW 参考值：52 steps / CFG 3.5。本机没有 RAW，不要传 RAW 名字。

## 尺寸 / 比例

- 默认 1024×1024。Turbo 可到约 2K，但 16GB 显存建议 ≤ 1024²，再大容易 OOM / 极慢。
- 官方支持的比例（照这个选，别随便传奇怪尺寸）：
  1:1 1024×1024 · 4:3 1184×896 · 3:2 1248×832 · 16:9 1376×768 · 2.35:1 1568×672 ·
  4:5 928×1152 · 2:3 832×1248 · 9:16 768×1376。
- 工具会把宽高按 8 取整；显存紧时先降到 1024² 或 896×1152。

## Prompt 怎么写

**核心：自然语言，长而具体，不要堆 tag。** 官方明确说长描述效果最好，且模型对
prompt 工程门槛不高——写清楚「是什么、什么风格、什么光、什么材质、什么镜头」即可。

推荐顺序：主体与动作 → 环境/背景 → 构图与镜头 → 光线 → 材质/质感 → 风格/媒介 →
色调。风格词尽量放前面（官方提示："add style language early"）。

```text
high-fashion editorial portrait of a young East Asian woman, short choppy platinum
blonde bob with heavy bangs, looking over her bare shoulder to the right, structured
black top with architectural bust detail, delicate gold hoop earrings, solid crimson red
background, soft directional studio lighting, cinematic color palette, medium close-up
```

```text
A tiny, russet-brown harvest mouse clings to a slender diagonal branch amid vibrant green
lobed leaves. Macro photograph, extremely shallow depth of field, glossy black eyes, fine
whiskers, deep green background dissolving into creamy bokeh, soft diffused natural light.
```

- 要渲染文字：把文字用**引号**包起来（例如 `a poster with the title "EXPLORE"`），并说明位置/字体感觉。
- 负面词：CFG=1 时**不生效**，不要浪费字段。要排除的东西改写成正向描述
  （不要 "no blur"，写 "sharp focus, crisp details"）。
- 官方/托管版的 `creativity`（raw / low / medium / high）与 Generative Sliders
  （Intensity、Complexity、Movement，−100…100）在本机没有对应开关；用 prompt 表达：
  - 想更风格化 → 明确写 "intensely stylized, bold color grading"；
  - 想更干净 → "minimal composition, clean background, lots of negative space"；
  - 想更动感 → "dynamic pose, motion blur, low-angle action shot"。

## 风格 LoRA

官方风格 LoRA 与触发词：

| LoRA | 触发词 |
| --- | --- |
| krea2_darkbrush | monochrome ink wash style |
| krea2_dotmatrix | monochrome stippling style |
| krea2_kidsdrawing | naive expressive sketch style |
| krea2_neondrip | textured abstract style |
| krea2_rainywindow | rainy window style |
| krea2_retroanime | purple retro anime style |
| krea2_softwatercolor | art deco watercolor style |
| krea2_sunsetblur | ethereal motion blur style |
| krea2_vintagetarot | vintage tarot style |

风格参考 LoRA `krea2_style_reference` 对应官方的图生风格参考。

用之前先 `drawing_models({ kind: "loras" })` 确认文件在不在。**缺文件就用 `drawing_download` 搜同名或同风格的 LoRA**：

```
drawing_download({ action: 'search', query: 'krea2 style', kind: 'lora' })
drawing_download({ action: 'download', source: 'civitai', modelVersionId: <选中的 versionId>, kind: 'lora', sha256: '<候选里的>' })
```

搜索默认同时查 Civitai 与 Hugging Face；官方站连不上会自动退到镜像（Civitai → civitai.red，HF → hf-mirror.com），
不用自己拼 shell 命令。下载会校验 SHA256 并落到 `loras`，再用 `drawing_models` 复核，把文件名传给 `lora`（可带 `:强度`）。
搜不到或下载不了，就告诉用户缺哪个、该放到哪里，然后停下，不要提交出图任务。

## 常见坑

1. **慢**：单张 1–4 分钟，超时默认 600 秒够用；不要同时提交第二张，不要开 batch > 1。
2. CFG 不要乱调：Turbo 就要 1（或官方 0）；调高会过曝/脏。
3. 负面词写了也白写（CFG=1）；改成正向描述。
4. 显存 16GB：krea2 最吃显存；出图前可 `drawing_status` 看 `vramFreeGB`，不够先别跑。
5. 改图：`drawing_generate` 传 `initImage` 本地绝对路径；denoise 0.3–0.4 微调、0.6 改风格、0.7+ 大改。
6. 不要把它当动漫模型：二次元/赛璐璐用 anima，文字排版用 moss。

## 来源

`krea2-userguide.md`、`krea2-turbo-userguide.md`、
`krea-ai__krea-2__main__docs__prompting.md`（官方 prompt 指南与示例）、
`krea2-api-overview.md`、官方提示词指南 §3。
