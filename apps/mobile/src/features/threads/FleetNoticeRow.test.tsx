import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

// React Native ships Flow sources this runner cannot parse, so the native
// leaves stand in as host elements. The row's own rendering is plain React.
vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("./thread-work-log", () => ({ ThreadDisclosureChevron: "ThreadDisclosureChevron" }));

import { FleetNoticeRow } from "./FleetNoticeRow";

const PROMPT = "One condition is waiting on this home's trigger log.";

/** Calls function components and walks host elements, as a render would. */
function hostTree(node: ReactNode): ReactNode {
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  if (typeof element.type === "function") {
    return hostTree((element.type as (props: unknown) => ReactNode)(element.props));
  }
  return element;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ readonly children?: ReactNode }>).props.children);
}

function findPressable(node: ReactNode): { readonly onPress: () => void } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPressable(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ readonly children?: ReactNode; onPress?: () => void }>;
  if (element.type === "Pressable" && element.props.onPress) {
    return { onPress: element.props.onPress };
  }
  return findPressable(element.props.children);
}

describe("FleetNoticeRow", () => {
  it("shows one line and reveals the prompt when pressed", () => {
    // The feed owns `expanded`; this stands in for it.
    let expanded = false;
    const render = () =>
      hostTree(
        <FleetNoticeRow
          text={PROMPT}
          expanded={expanded}
          iconSubtleColor="#888888"
          onToggle={() => {
            expanded = !expanded;
          }}
        />,
      );

    const folded = render();
    expect(textOf(folded)).toContain("Fleet notice");
    expect(textOf(folded)).not.toContain(PROMPT);

    findPressable(folded)?.onPress();
    expect(textOf(render())).toContain(PROMPT);

    findPressable(render())?.onPress();
    expect(textOf(render())).not.toContain(PROMPT);
  });
});
