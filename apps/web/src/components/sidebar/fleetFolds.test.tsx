import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useFleetFolds } from "./fleetFolds";

// Stands in for the sidebar: it shows two second mates' folds and toggles one.
// The project colour prop changes when the user edits the project's icon.
function SecondMateFolds(props: { readonly repos: readonly string[]; readonly color: string }) {
  const { folded, toggle } = useFleetFolds();
  return (
    <>
      {props.repos.map((repo) => (
        <button key={repo} type="button" data-color={props.color} onClick={() => toggle(repo)}>
          {folded.has(repo) ? "folded" : "open"}
        </button>
      ))}
    </>
  );
}

let renderer: ReactTestRenderer | undefined;

function mount(repos: readonly string[], color: string) {
  act(() => {
    renderer = create(<SecondMateFolds repos={repos} color={color} />);
  });
}

const labels = () => renderer!.root.findAllByType("button").map((button) => button.children[0]);
const toggle = (index: number) =>
  act(() => renderer!.root.findAllByType("button")[index]!.props.onClick());

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

// Each test uses its own repository names: the folds live for the app session.
describe("fleet folds", () => {
  it("keep a second mate folded through Settings and a project icon change", () => {
    mount(["firstmate", "sheppi"], "green");
    expect(labels()).toEqual(["open", "open"]);
    toggle(0);
    expect(labels()).toEqual(["folded", "open"]);

    // Opening Settings unmounts the sidebar; Back mounts a new one.
    act(() => renderer!.unmount());
    mount(["firstmate", "sheppi"], "green");
    expect(labels()).toEqual(["folded", "open"]);

    // The user changed a project's icon colour while in Settings.
    act(() => renderer!.update(<SecondMateFolds repos={["firstmate", "sheppi"]} color="blue" />));
    expect(labels()).toEqual(["folded", "open"]);
  });

  it("unfold a second mate on a second toggle", () => {
    mount(["agos"], "green");
    toggle(0);
    toggle(0);
    expect(labels()).toEqual(["open"]);
  });
});
