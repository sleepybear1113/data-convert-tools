/** Values above this significant-digit count require an explicit precision policy. */
export const MAX_COMMONLY_SAFE_SIGNIFICANT_DIGITS = 15

export function significantDigits(decimalText: string): number {
  const normalized = decimalText.trim().replace(/^[+-]/, '').replace('.', '')
  return normalized.replace(/^0+(?=\d)/, '').length
}
