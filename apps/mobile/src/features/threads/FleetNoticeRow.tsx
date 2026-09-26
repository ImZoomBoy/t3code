import * as Haptics from "expo-haptics";
import { Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ThreadDisclosureChevron } from "./thread-work-log";

/**
 * Stands in for a user message a fleet wake sent (`fleetWake` on the message):
 * one muted line that expands to the prompt, so a supervisor waking its agent
 * never reads as something the user typed. `expanded` lives on the feed so it
 * survives row recycling.
 */
export function FleetNoticeRow(props: {
  readonly text: string;
  readonly expanded: boolean;
  readonly iconSubtleColor: ColorValue;
  readonly onToggle: () => void;
}) {
  return (
    <View className="mb-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel="Fleet notice"
        accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} the prompt.`}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        className="min-h-8 flex-row items-center gap-1.5 self-start rounded-md px-0.5 active:bg-subtle"
      >
        <Text className="font-t3-medium text-xs text-foreground-muted">Fleet notice</Text>
        <ThreadDisclosureChevron
          expanded={props.expanded}
          collapsedDirection="right"
          size={10}
          tintColor={props.iconSubtleColor}
        />
      </Pressable>
      {props.expanded ? (
        <View className="ml-0.5 mt-1 border-l border-border pl-3">
          <Text selectable className="text-xs text-foreground-muted">
            {props.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
