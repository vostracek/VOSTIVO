import { UpdateCard } from "../ui/primitives";
import { COPY, type MissedWorkoutCard as MissedWorkoutCardModel } from "./missed-workout-flow";

/**
 * Missed Workout V1 Slice D — Today's compact, calm adaptation card (below
 * the Workout Hero; it never replaces the Hero's primary action). Visual:
 * the approved Today Final "Plan update" card (amber marker + eyebrow,
 * title, body, split "Review change ›" footer). Renders only
 * `missedWorkoutCard(state)`; no logic.
 */
export function MissedWorkoutCard(props: {
  readonly card: MissedWorkoutCardModel;
  readonly onReview: () => void;
  readonly onViewPlan: () => void;
  readonly onRetryTimeZone: () => void;
}): React.JSX.Element {
  const { card } = props;
  switch (card.kind) {
    case "RECOMMENDATION":
      return <UpdateCard tone="attention" eyebrow={COPY.eyebrow} title={card.title} body={card.body} actionLabel={COPY.reviewCta} onAction={props.onReview} />;
    case "REVIEW_REQUIRED":
      return (
        <UpdateCard
          tone="attention"
          eyebrow={COPY.eyebrow}
          title={COPY.reviewRequiredTitle}
          body={COPY.reviewRequiredBody}
          detail={card.reason}
          actionLabel={COPY.viewPlan}
          onAction={props.onViewPlan}
        />
      );
    case "TIMEZONE_REQUIRED":
      return (
        <UpdateCard
          tone="neutral"
          eyebrow={COPY.eyebrow}
          body={COPY.timeZoneRequired}
          actionLabel={card.retrying ? "Trying…" : COPY.tryAgain}
          onAction={props.onRetryTimeZone}
          actionLoading={card.retrying}
        />
      );
  }
}
