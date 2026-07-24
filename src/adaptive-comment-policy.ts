export type AdaptiveSubmitEvidence = {
  requestSignalCount: number;
  responseSignalCount: number;
  composerCleared: boolean;
  composerTextReadable: boolean;
  composerTextMatched: boolean;
  buttonLoading: boolean;
  buttonDisabledTransition: boolean;
  newToastCount: number;
  exactMatchCount: number;
};

export type AdaptiveSubmitDecision =
  | "no_effect"
  | "possible_submit"
  | "uncertain";

export function classifyAdaptiveSubmitEvidence(
  evidence: AdaptiveSubmitEvidence,
): AdaptiveSubmitDecision {
  if (evidence.requestSignalCount > 0
    || evidence.responseSignalCount > 0
    || evidence.composerCleared
    || evidence.buttonLoading
    || evidence.buttonDisabledTransition
    || evidence.newToastCount > 0
    || evidence.exactMatchCount > 0) {
    return "possible_submit";
  }
  if (evidence.composerTextReadable && evidence.composerTextMatched) {
    return "no_effect";
  }
  return "uncertain";
}
