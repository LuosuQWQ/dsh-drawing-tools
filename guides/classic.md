# classic 用法指南（family `classic` / SD1.5）

适用：最快出草图、快速试构图、显存紧张或其它族模型缺失时的兜底。

## 本机加载方式

| 项 | 值 |
| --- | --- |
| checkpoint | `sd15-anylora-bakedvae-fp16.safetensors`（二次元）/ `sd15-dreamshaper-8.safetensors`（通用写实） |
| 文本编码器 / VAE | 检查点自带 |
| 默认参数 | 25 步 / CFG 7 / `euler` / `normal` / 768×768 |

- 用 `model` 覆盖具体 checkpoint；不传时用 AnyLoRA（二次元）。
- 显存紧或求快可 512×512 / 512×768；写实可 768×768。

## Pony / SDXL checkpoint（本机已装）

`sdxl-pony-v6-xl.safetensors`（6.46 GB）是 SDXL/Pony 底模，同样走
`family: "classic"` + `model` 指定——`classic` 只是「checkpoint 族」的入口，不代表只能用 SD1.5。

| 项 | 值 |
| --- | --- |
| 参数 | 25–30 步 / CFG 6–7 / `euler` + `normal` |
| 尺寸 | 1216×832 或 1344×768 |
| 正向前缀 | `score_9, score_8_up, score_7_up, source_anime, rating_safe` |
| 负面 | 默认即可；衣物被吞时加 `nude, topless` |

Pony LoRA 只能配 Pony/SDXL 底模，例如 `by_ontokuyou-pony-000018.safetensors`（触发词
`by otokuyou`）；SD1.5 或 anima 的 LoRA 不能混用。LoRA 缺文件时按上面的 civitai 流程补到
models root（`COMFY_MODELS_ROOT`）下的 `loras` 目录，再用 `drawing_models` 复核。

## Prompt 怎么写

SD1.5 习惯「逗号分隔的短语 + 质量词」，不适合 MOSS/Krea 那种长段落：

```text
masterpiece, best quality, 1girl, silver hair, blue eyes, school uniform, cherry blossoms,
outdoors, soft lighting, depth of field
```

- 正向质量前缀：`masterpiece, best quality, highly detailed`。
- 负面（工具默认已带）：`lowres, bad anatomy, worst quality, low quality, blurry, jpeg artifacts`。
- 权重语法 `(word:1.2)` 有效；不要堆太多互相冲突的风格词。

## 常见坑

- 需要 LoRA 而目录里没有：用 `drawing_download({ action: 'search', query: '<关键词>', type: 'LORA' })` 找，再 `drawing_download({ action: 'download', ... })` 装进模型目录
  搜索，下载到 models root（`COMFY_MODELS_ROOT`）下的 `loras` 目录，`drawing_models` 确认后再传；找不到就告诉用户，不要提交出图。
- 分辨率别超过 1024²，SD1.5 高了容易多头多手。
- 写实/文字排版需求分别换 krea2 / moss，不要硬调 classic。

## 来源

本机实测参数以 `drawing_models` 返回的族建议值为准；SD1.5 提示词为通用经验。
