# Drawing guides — English index

The full guides under this directory are written in Chinese because they are prompt instructions for the agent, not human tutorials. This page gives an English index so an English reader can find the right file and know what it covers.

| Guide | File | What it covers |
| --- | --- | --- |
| classic | [classic.md](classic.md) | SD1.5 / SDXL checkpoints through `CheckpointLoaderSimple`: sizes, steps, CFG, negative prompts, when to use it as a fallback. |
| anima | [anima.md](anima.md) | Anima 2B: Danbooru-style tags, artist tags, recommended steps/CFG, CLIP type, common failures. |
| krea2 | [krea2.md](krea2.md) | Krea-2 Turbo 12B GGUF: long natural-language prompts, CFG=1, why negative prompts are ignored, sampling settings. |
| moss | [moss.md](moss.md) | MOSS-Image 5B: Chinese/English text rendering, layout rules, negative prefix the authors recommend. |
| generic | [generic.md](generic.md) | Any diffusion model without a built-in family: explicit `textEncoder` + `vae`, `.gguf` handling, when to use a saved workflow instead. |
| prompt-patterns | [prompt-patterns.md](prompt-patterns.md) | Tested prompt templates per family, negative-prompt packs, and a family cheat sheet. |
| index | [README.md](README.md) | The Chinese index the agent reads first. |

## How to use them

- As a human: read the English summary above, then use `drawing_guide({ family })` in DSH to get the full text (it is returned as-is, in Chinese).
- As an agent: always call `drawing_guide({ family })` before writing prompts for anima / krea2 / moss; the tool returns the Chinese guide and it is authoritative over memory.
