/**
 * Repairs formatting artifacts of the recognizer's number writing. It does not change
 * any word: it only restores a space the recognizer leaves out, as in "is$4,350".
 */
export function fixRecognizerArtifacts(text: string): string {
  return text.replace(/(\p{L})([$€£¥₹])(?=\d)/gu, '$1 $2')
}
