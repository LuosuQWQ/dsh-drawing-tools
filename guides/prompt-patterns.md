# 提示词模板库（prompt patterns）

直接复制、按需替换主体。所有示例都是**整段 prompt**，`negative` 按族从文末「负面词包」取。

## 1. classic · 二次元角色（本机实测可用）

```
masterpiece, best quality, 1girl, solo, cel shading, flat color, hard edge shadow,
anime screencap, sharp outlines, high contrast, silver hair, short hair, blue eyes,
school uniform, cherry blossoms, spring, outdoors, vibrant colors
```

参数：`family: 'classic'`、`model: 'sd15-anylora-bakedvae-fp16.safetensors'`、768×768 或 512×768、25–30 步、CFG 7、`euler` / `normal`（768² 实测用 `euler_ancestral`）。

## 2. classic · 写实人像（DreamShaper）

```
masterpiece, best quality, portrait photo of a young man, short black hair, dark jacket,
city rooftop at dusk, soft window light, 50mm lens, shallow depth of field,
film grain, natural skin texture, photorealistic, cinematic
```

参数：`model: 'sd15-dreamshaper-8.safetensors'`、512×768、25 步、CFG 7、`euler` / `normal`。

## 3. anima · 动漫场景（本机实测可用）

```
masterpiece, best quality, 1girl, solo, cel shading, flat color, hard edge shadow,
anime screencap, silver hair, blue eyes, school uniform, cherry blossoms, outdoors,
vibrant colors
```

参数：`family: 'anima'`、1024×1024、30 步、CFG 4、`euler` / `simple`；负面用 anima 官方包。

## 4. anima · 角色立绘 / 场景叙事（自然语言）

```
a young swordswoman in a tattered white cloak stands alone on a cliff at dawn,
silver hair blowing in the wind, scar across her left cheek, distant mountain sea of clouds,
low angle wide shot, cold blue morning light with warm rim light, painterly anime illustration,
detailed background, dramatic atmosphere
```

想更“番剧截图”就加 `anime screencap, cel shading`；想更插画就加 `painterly, detailed illustration`。

## 5. krea2 · 电影感人像（本机实测可用）

```
a cinematic portrait of a young woman in a red qipao standing in a neon-lit rainy street,
cel shading, flat color, anime screencap, sharp outlines, high contrast
```

上面这条实测偏二次元；要写实就换成：

```
a cinematic portrait of a young woman in a red qipao standing in a neon-lit rainy street,
35mm lens, shallow depth of field, wet asphalt reflections, cool blue night with warm signage,
film grain, photorealistic, high detail
```

参数：`family: 'krea2'`、1024×1024、8 步、CFG 1、`euler` / `simple`，**不传 negative**。

## 6. krea2 · 场景 / 产品

```
a minimalist ceramic tea set on a rough wooden table, morning light through rice paper window,
soft shadows, muted earth tones, wabi-sabi still life, 85mm lens, high detail
```

```
a futuristic train station in the rain at night, brutalist concrete, glowing signage,
crowd with umbrellas, wide angle, cinematic lighting, volumetric fog, ultra detailed
```

## 7. moss · 中文海报（文字用引号 + `\n` 换行）

```
一张复古电影海报：夜晚的老街，一位穿白色羊毛大衣的模特走向镜头，
上方巨大的剧院招牌灯箱上写着 "MOSS"，湿润的柏油路反光，
暖黄灯光对比冷蓝夜色，35mm 胶片颗粒，低角度仰拍，电影感构图
```

两行文字示例：

```
一张极简咖啡店开业海报：米白色背景，中央一杯拿铁俯拍，文字按两行居中排列：
第一行 "山雾咖啡"，第二行 "10月1日 开业"
字体为细体无衬线，下方留白，整体干净克制
```

## 8. moss · 英文海报（官方风格，本机实测可用）

```
Cinematic night street photograph: a model in an exaggerated balloon-sleeve white wool coat
walking toward camera under a huge illuminated theatre marquee, the marquee bulbs spelling
"MOSS" in tall capital letters, wet asphalt with long reflections, warm tungsten glow
against cold blue night, 35mm film grain, low angle
```

参数：`family: 'moss'`、1024×1024、25 步、CFG 2.5、`er_sde` / `simple`；负面用 moss 官方包。

## 9. moss · 中英双语卡片

```
一张双语祝福卡片：奶油色纸纹背景，中间是手绘风格的桂花枝，
上方中文 "中秋快乐"，下方英文 "Happy Mid-Autumn Festival"，
金色细线边框，温柔暖光，简洁排版，留白充足
```

文字多的场景先减字：1–2 行、每行 2–10 字最稳。

## 负面词包

| 用途 | negative |
| --- | --- |
| classic 通用 | `low quality, worst quality, lowres, bad anatomy, bad hands, extra digits, watermark, signature, blurry, jpeg artifacts`（工具默认只带 `lowres, bad anatomy, worst quality, low quality, blurry, jpeg artifacts`） |
| anima 官方 | `worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia` |
| moss 官方 | `nsfw, worst quality, bad anatomy, watermark, jpeg artifact` |
| 写实人物加料 | `deformed face, asymmetric eyes, extra fingers, plastic skin, oversaturated` |
| krea2 | 不传 negative（CFG=1，工具内部固定 ConditioningZeroOut） |

不传 `negative` 时工具会自动使用该族默认负面词；显式传入则完全替换默认值。

## 风格词速查

- 二次元：`cel shading`、`flat color`、`hard edge shadow`、`anime screencap`、`sharp outlines`、`vibrant colors`、`painterly anime illustration`。
- 写实/摄影：`photorealistic`、`cinematic`、`35mm lens`、`shallow depth of field`、`film grain`、`natural skin texture`、`volumetric fog`。
- 光照：`soft rim light`、`golden hour`、`neon-lit`、`backlit`、`warm tungsten glow`、`cold blue night`。
- 构图/镜头：`close-up portrait`、`full body`、`low angle`、`wide shot`、`centered composition`、`negative space`。
- 排版类（moss）：`极简海报`、`复古电影海报`、`无衬线粗体`、`毛笔书法字`、`霓虹灯管字`、`留白充足`。

## 选族速查

| 需求 | 族 |
| --- | --- |
| 动漫 / 插画 / 角色 / 赛璐璐 | anima（质量）或 classic-AnyLoRA（速度） |
| 写实 / 摄影 / 电影感 / 复杂场景 | krea2 |
| 海报 / 卡片 / 招牌 / 中英文文字 | moss |
| 快速试构图 / 试 seed | classic |

## 长度参考

- classic：20–40 个 tag；超过 75 token 部分会被 CLIP 分块，越靠后越弱。
- anima / krea2：30–80 个英文词（krea2 偏长句：50–120 词）。
- moss：可长（约 4K token），但一个画面讲清即可；文字相关描述放在最后强调。
