/** Sample rate the recognizer and voice detector expect. */
export const SAMPLE_RATE = 16_000

/**
 * Samples per frame sent from the capture worklet to the speech worker:
 * 96 ms, which is 12 render quanta and exactly 3 voice-detector windows of 512.
 */
export const FRAME_SAMPLES = 1_536

export const PCM_PROCESSOR_NAME = 'pcm-processor'
