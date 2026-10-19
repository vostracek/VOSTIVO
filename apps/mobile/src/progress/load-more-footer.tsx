import { Text, View } from "react-native";
import { SecondaryButton, progressStyles as styles } from "./progress-ui";

/** "Load more" for a keyset list: disabled while a page loads; a failed page keeps the rows and offers Retry; a clear end state. */
export function LoadMoreFooter({ state, onLoadMore, endLabel }: { state: { readonly nextCursor: string | null; readonly more: "IDLE" | "LOADING" | "ERROR" }; onLoadMore: () => void; endLabel: string }): React.JSX.Element | null {
  if (state.nextCursor === null) return <Text style={styles.tertiaryText}>{endLabel}</Text>;
  if (state.more === "ERROR") {
    return (
      <View style={styles.section}>
        <Text style={styles.captionText}>{"Couldn't load more."}</Text>
        <SecondaryButton label="Retry" accessibilityLabel="Retry loading more" onPress={onLoadMore} />
      </View>
    );
  }
  return <SecondaryButton label={state.more === "LOADING" ? "Loading…" : "Load more"} disabled={state.more === "LOADING"} onPress={onLoadMore} />;
}
