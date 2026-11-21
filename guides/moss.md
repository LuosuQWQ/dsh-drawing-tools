# MOSS-Image 用法指南（family `moss`）

适用：画面里必须有**准确的中英文文字**、海报 / 卡片 / 白板 / 说明书 / 招牌 /
封面标题，或者要精确指定文字与物体的位置。普通写实、普通插画不要用它（慢，且提示词
写法不同）。

## 本机加载方式（照抄，不要改）

| 项 | 值 |
| --- | --- |
| 扩散模型 | `moss-image-sft-int8-convrot.safetensors`（`diffusion_models`，UNETLoader） |
| 文本编码器 | `qwen3.5-9b-w4a8-gptq.safetensors`（CLIPLoader，type=`moss_image`） |
| VAE | `flux2-vae-small.safetensors` |
| 空 latent | `EmptyFlux2LatentImage` |
| 默认参数 | 25 步 / CFG 2.5 / `er_sde` / `simple` / 1024×1024 |

以上由 `drawing_generate({ family: "moss" })` 自动处理；只有模型文件缺失时才需要动手：
先 `drawing_models` 确认缺哪个，再用 `drawing_download` 搜索并下载到
models root（`COMFY_MODELS_ROOT`）下的对应目录（见 `guides/README.md` 的「缺模型 / 缺 LoRA 时」）；找不到或
下载不了就告诉用户，不要提交出图任务。

## 尺寸规则（会被工具硬性校验）

- 宽、高**都必须是 16 的正整数倍**（1024、1152、1280 可以；1000、1023 不行）。
- 总像素建议 **1M / 1.5M / 2M**，最稳是 1024×1024 ≈ 1M；想更清晰用 1280×1152 ≈ 1.5M。
- 可外推范围 0.25M（512×512）到 4M（约 2K），但越大越慢、越容易崩。
- 支持的宽高比不限，但构图极端（比如 2.35:1）时文字容易挤，海报优先 4:5 / 3:4 / 1:1。

## 参数

| 参数 | 本机默认（快） | 官方推荐（质量） |
| --- | --- | --- |
| steps | 25 | ≥ 50 |
| cfg | 2.5 | 3.0（范围 3.0–6.0；长 prompt 用 3.0，短 prompt 可调高） |
| sampler / scheduler | `er_sde` / `simple` | `euler` / flow-matching（Shift 5.0） |
| negative | `nsfw, worst quality, bad anatomy, watermark, jpeg artifact` | 同左 |

- 出图文字糊、字缺笔画：先把 steps 提到 40–50、CFG 提到 3.0–3.5。
- SLG（Skip Layer Guidance）本机工具未启用；不要为了「更真实」去改它。

## Prompt 怎么写

**语言**：优先**英文**（训练量最大），中文也支持。中英混排的海报两种都行，但同一段
描述不要一半英文一半中文地混着写；要渲染的文字原样保留。

**格式 1：自然语言长句（首选）**
按「主体 → 动作/姿态 → 服装/材质 → 环境 → 构图 → 光线 → 风格 → 画面内文字」写一段
完整说明，可以写很长（约 4K token 以内）。要出现的文字用引号括起来：

```text
A wide view of a refrigerator beside a kitchen counter with a fruit bowl. A small
sticky note on the refrigerator door is handwritten in Chinese: "记得买牛奶和鸡蛋！
牛奶两盒，鸡蛋一打。顺便带一袋面包。" Soft daylight, clean minimal kitchen, photorealistic.
```

**格式 2：Tag 串（模型也支持）**
顺序固定为 Quality → Score → Meta → Year → Character → Series → Artist → General：

```text
best quality, highres, 1girl, blue hair, school uniform, cherry blossoms, outdoors, soft lighting
```

**格式 3：JSON Layout（MOSS 的杀手锏，实验性）**
需要精确控文字/物体位置时才用。字段：

```json
{
  "summary": { "meta": ["poster"], "canvas": "single",
    "caption": "整体场景、风格、色调" },
  "items": [
    { "label": "text", "caption": "顶部居中的大号深蓝标题", "text": "EXPLORE",
      "bbox": [-416, -384, -288, 384] },
    { "label": "object", "caption": "下方居中的扁平蓝色山脉插画",
      "bbox": [-192, -288, 384, 288] }
  ],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

- `label` 取 `object` / `character` / `text`；文字项**必须**给 `text`。
- `bbox_format: "yxyx"` → `[y_min, x_min, y_max, x_max]`。
- `bbox_coord_space: "abs_centralized"` → 以画布中心为原点，x 向右、y 向下；
  1024×1024 时每轴范围 −512…+512。
- 生成尺寸必须和 layout 的画布一致，且仍是 16 的倍数。
- 用 Layout 时不要再让模型「自由排版」：summary.caption 只写场景/风格，位置交给 items。

## 文字渲染技巧

- 要精确换行：在 prompt 里写 `\n` 或真实换行；模型会按你给的换行排。
- 文字用引号包住，标点、大小写、数字原样写；不要写「标题大概意思是……」这种转述。
- 字多时给字号层级：标题 / 副标题 / 正文分别描述位置与大小。
- 海报、白板、说明书、菜单、招牌、漫画对话框是它的强项；纯写实人像别用它和 krea2 比。

## 常见坑

1. 宽高不是 16 的倍数 → 任务直接失败；工具会自动按 16 取整，但自己传值时注意。
2. CFG 低于 2 或 steps 太低 → 文字糊、缺字；这不是提示词问题。
3. 中文文字乱码/错字 → 减少单张图的文字量，把长段落拆成多行或分张出。
4. 把 Layout JSON 当成普通 prompt 传 → 必须整段 JSON 字符串，且 `enable_prompt_enhancer`
   类改写不要叠加（本机工具不启用扩写，直接进模型）。
5. 想让 MOSS 抄参考图 → 它没有图像输入；需要参考请用 krea2 的 img2img / drawing_generate 的 `initImage`。

## 来源

`moss-userguide-zh.md`（官方中文指南：参数、三种 prompt、Layout、
prompt enhancer）、`moss-comfyui-readme.md`、`moss-prompt-enhancer-SKILL.md`、
官方提示词指南 §2。
