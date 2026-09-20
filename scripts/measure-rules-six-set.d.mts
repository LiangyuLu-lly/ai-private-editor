export class GoldSpanDeletionError extends Error {
  readonly deleted: number;
}

export function countDeletedGoldSpans(
  goldRows: readonly { readonly entities?: readonly { readonly start: number; readonly end: number }[] }[],
  predictionRows: readonly { readonly entities?: readonly { readonly start: number; readonly end: number }[] }[],
): number;

export function assertZeroGoldSpanDeletions(
  goldRows: readonly { readonly entities?: readonly { readonly start: number; readonly end: number }[] }[],
  predictionRows: readonly { readonly entities?: readonly { readonly start: number; readonly end: number }[] }[],
): void;
