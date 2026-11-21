# Anima 用法指南（family `anima`）

适用：动漫 / 插画 / 角色 / 赛璐璐 / 二次元场景。2B 模型，快且稳，是动漫类默认首选。
写实照片不要用它（官方定位就是非写实）。

## 本机加载方式（照抄，不要改）

| 项 | 值 |
| --- | --- |
| 扩散模型 | `anima-aesthetic-v1.1.safetensors`（美学版，默认）/ `anima-turbo-v1.1.safetensors`（加速版） |
| 文本编码器 | `qwen3-0.6b-base.safetensors`（CLIPLoader，type=`stable_diffusion`） |
| VAE | `qwen-image-vae.safetensors` |
| 默认参数 | 30 步 / CFG 4 / `euler` / `simple` / 1024×1024 |
| turbo | 8 步 / CFG 1 |

- 官方推荐分辨率 512–1536；本机默认 1024²。
- 官方推荐 steps 30–50、CFG 4–5；采样器可试 `er_sde`（平涂锐线）、`euler_a`（柔细线/2.5D）、
  `dpmpp_2m_sde_gpu`（更多变化）。本机统一 `euler` + `simple` 最稳。
- Aesthetic 版不要再换回 Base 的参数；turbo 版必须 CFG 1 / 8 步左右。

## Prompt 怎么写（重点）

训练数据是 Danbooru tag、自然语言、以及两者混写，三种都能用。

### 格式规则

- tag 一律**小写**，用**空格**代替下划线；只有 `score_7` 这类 score 系列保留下划线。
- 画师 tag 必须加 `@` 前缀，例如 `@big chungus`；不加基本没效果。
- 权重可用，但要比 SDXL 给得更高，例如 `(chibi:2)`。
- Danbooru / Gelbooru 写法律不同时，优先 Gelbooru 版本。
- tag 顺序：质量/元信息/年份/安全 → `1girl`/`1boy`/`1other` → 角色 → 作品 → 画师 → 一般 tag；
  同一分区内部顺序随意。
- 模型训练时做了 tag dropout，不需要把所有相关 tag 都列上。

### 正向 / 负向模板

正向（二选一，或混用；Aesthetic 版**不要**两组 score_ 同时用，容易过冲成塑料感）：

```text
masterpiece, best quality, score_7, safe, 1girl, silver hair, blue eyes, school uniform,
sailor collar, blue skirt, cherry blossoms, outdoors, spring, looking at viewer, upper body,
soft lighting, anime illustration
```

负向（工具默认已带，够用）：

```text
worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts,
chromatic aberration
```

- 安全 tag：`safe` / `sensitive` / `nsfw` / `explicit`。
- 时间 tag：`year 2025`、`newest`、`recent`、`mid`、`early`、`old`。

### 自然语言混写

- 角色名/作品名用英文正常大小写。
- 纯自然语言至少写 2 句，太短容易出意外结果。
- tag 和自然语言可以任意混排。
- 多角色：先点名每个角色，再分别描述外貌，否则容易串味。

```text
masterpiece, best quality, @big chungus. An anime girl with medium-length blonde hair is
standing on a rooftop at sunset, wearing a black coat over a white dress, wind blowing
through her hair, cinematic lighting, detailed background.
```

## 常见坑

1. 用 tag 但写成大写或下划线（`Blue_Hair`）→ 识别差；改成 `blue hair`。
2. Aesthetic 版同时塞 `score_9` 和 `masterpiece` 两套 → 过曝、塑料感；选一套。
3. 纯 tag 太短 → 加两句自然语言描述。
4. 写实需求 → 换 krea2，不要硬调 anima。
5. 画师风格 → 必须 `@画师名`；写中文名无效。
6. turbo 版还用 30 步 / CFG 4 → 过冲；turbo 用 8 步 / CFG 1。

## 来源

官方模型卡 `circlestone-labs__Anima.README.md`（含完整 tag 规范与示例）、
`comfy-anima-tutorial.md`、官方提示词指南 §4。
