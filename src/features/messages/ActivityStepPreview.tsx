import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import styles from "./ActivityStepPreview.module.css";

/** A stable live-work cue; current steps belong to the activity disclosure. */
export function ActivityStepPreview({
  state,
  remoteFallback,
}: {
  state: "waiting" | "working";
  remoteFallback?: string | undefined;
}) {
  return (
    <span className={styles.stepPreview}>
      <TypingDots size="message" state={state} />
      {remoteFallback && (
        <span className={styles.stepText}>
          <ShimmerText active={state === "working"}>
            {remoteFallback}
          </ShimmerText>
        </span>
      )}
    </span>
  );
}
