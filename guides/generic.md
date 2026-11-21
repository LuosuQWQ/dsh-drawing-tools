# 通用扩散模型指南（family `generic`）

给**没有内置族**的扩散模型用：你自己装进来的 UNET / GGUF，配你自备的 text encoder 与 VAE。
四族（classic / anima / krea2 / moss）有写好的伴生文件和参数；generic 没有，**三样都得显式给**。

## 需要什么

| 参数 | 说明 |
| --- | --- |
| `model` | 扩散模型文件名，取 `drawing_models({ kind: 'diffusion_models' })` 的 `name`。`.gguf` 会自动走 `UnetLoaderGGUF`（需要 ComfyUI-GGUF 节点）。 |
| `textEncoder` | CLIP 文件名，取 `drawing_models({ kind: 'text_encoders' })`。 |
| `vae` | VAE 文件名，取 `drawing_models({ kind: 'vae' })`。 |
| `clipType` | `CLIPLoader` 的 type，默认 `stable_diffusion`。模型卡里写了别的类型（例如 `flux`、`sd3`）就照写。 |

三个都缺一不可：generic 没有默认值，缺了 `drawing_generate` 会直接报错，而不是去猜。

## 参数起点

- 1024×1024、20 步、CFG 3.5、`euler` + `simple`。蒸馏/加速模型通常更低（8 步、CFG 1）。
- 负面词：`low quality, worst quality, watermark`；CFG=1 时负面词不生效。
- 尺寸必须是 8 的倍数（工具会自动圆整）。

## 什么时候不要用 generic

- **有内置族的模型**（anima / krea2 / moss / SD1.5 或 SDXL checkpoint）：用对应族，参数和节点都已校准。
- **需要特殊节点的架构**：例如 Flux 的 `FluxGuidance`、SD3 的 latent 变体、各种双采样器流程。generic 构的是
  `UNETLoader / CLIPLoader / VAELoader / CLIPTextEncode / EmptyLatentImage / KSampler / VAEDecode` 这条最普通的链，
  这些模型可能出图质量不对甚至报错。这种情况用 `drawing_workflow` 跑一份 ComfyUI 导出的 API 工作流，
  或者在 ComfyUI 里改好再导出。

## 装完先核对

1. `drawing_models()` 看该文件是否存在，以及它给出的 `usage`。
2. 缺伴生文件时，`drawing_pnginfo` 读一张参考图就能列出它需要哪些；再 `drawing_download` 补。
3. 出图失败时先看 ComfyUI 的报错原文：最常见的是 `clipType` 不对、VAE 不匹配、或节点包没装。

## 来源

ComfyUI 的加载器节点语义与官方示例工作流（UNETLoader / CLIPLoader / VAELoader / KSampler）。
