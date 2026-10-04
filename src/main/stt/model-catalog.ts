/**
 * The speech models the app knows how to download. Every file is pinned to an exact
 * revision, size and SHA-256, so a download is either byte-for-byte what was tested
 * or it is rejected.
 */

export interface ModelFile {
  name: string
  url: string
  bytes: number
  sha256: string
}

export interface ModelSpec {
  /** Also the directory name the files are stored under. */
  id: string
  label: string
  /** Shown to the user and listed in the app's attributions. */
  licence: string
  /** Languages the model recognises, as ISO 639-1 codes. */
  languages: readonly string[]
  files: ModelFile[]
}

const PARAKEET_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78'

/**
 * NVIDIA Parakeet TDT 0.6b v3, 8-bit, in sherpa-onnx format, plus the Silero
 * voice-activity model the worker uses to find speech. About 671 MB in total.
 */
export const PARAKEET_V3: ModelSpec = {
  id: 'parakeet-tdt-0.6b-v3-int8',
  label: 'Parakeet v3',
  licence: 'Parakeet: CC-BY-4.0 (NVIDIA). Silero VAD: MIT.',
  languages: [
    'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it',
    'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk',
  ], // prettier-ignore
  files: [
    {
      name: 'encoder.int8.onnx',
      url: `${PARAKEET_BASE}/encoder.int8.onnx`,
      bytes: 652_184_281,
      sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247',
    },
    {
      name: 'decoder.int8.onnx',
      url: `${PARAKEET_BASE}/decoder.int8.onnx`,
      bytes: 11_845_275,
      sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e',
    },
    {
      name: 'joiner.int8.onnx',
      url: `${PARAKEET_BASE}/joiner.int8.onnx`,
      bytes: 6_355_277,
      sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3',
    },
    {
      name: 'tokens.txt',
      url: `${PARAKEET_BASE}/tokens.txt`,
      bytes: 93_939,
      sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d',
    },
    {
      name: 'silero_vad.onnx',
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
      bytes: 643_854,
      sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    },
  ],
}

export const DEFAULT_MODEL = PARAKEET_V3
