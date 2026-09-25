import { useAtomValue } from "@effect/atom-react";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { deriveProjectIdentity } from "../../projectIdentity";
import { projectFaviconUrlAtom } from "../../state/assets";
import type { ProjectFaviconProject } from "../ProjectFavicon";
import { FIRST_MATE_TONE_CLASS } from "./fleetSidebar.logic";
import {
  chooseFleetTone,
  fleetToneStyle,
  type FleetIconSource,
  type FleetToneChoice,
} from "./fleetTone.logic";

/** Whose colour a fleet row wears. */
export type FleetTheme =
  | { readonly kind: "first-mate" }
  | {
      readonly kind: "project";
      /** The second mate's project, whose icon gives the colour. */
      readonly project: ProjectFaviconProject | null;
      /** The repository, for the stable fallback when the icon has no colour. */
      readonly repo: string;
    };

export interface FleetToneProps {
  readonly className: string;
  readonly style?: CSSProperties | undefined;
  /** How the colour was found; "fallback" means the icon had no usable colour. */
  readonly source: FleetToneChoice["kind"] | "first-mate" | "pending";
}

const PENDING: FleetToneProps = { className: "text-muted-foreground", source: "pending" };

/** Hands its children the text colour for a fleet row. */
export function FleetTone(props: {
  readonly theme: FleetTheme;
  readonly children: (tone: FleetToneProps) => ReactNode;
}) {
  if (props.theme.kind === "first-mate") {
    return props.children({ className: FIRST_MATE_TONE_CLASS, source: "first-mate" });
  }
  if (props.theme.project === null) {
    return props.children(toneProps(chooseFleetTone({ kind: "none" }, props.theme.repo)));
  }
  return (
    <ProjectFleetTone project={props.theme.project} repo={props.theme.repo}>
      {props.children}
    </ProjectFleetTone>
  );
}

function toneProps(choice: FleetToneChoice): FleetToneProps {
  const { className, style } = fleetToneStyle(choice);
  return { className, style: style as CSSProperties | undefined, source: choice.kind };
}

function ProjectFleetTone(props: {
  readonly project: ProjectFaviconProject;
  readonly repo: string;
  readonly children: (tone: FleetToneProps) => ReactNode;
}) {
  const { project } = props;
  // The same URL the project icon shows, so both read the same image.
  const src = useAtomValue(
    projectFaviconUrlAtom({
      environmentId: project.environmentId,
      cwd: project.workspaceRoot,
      faviconPath: project.faviconPath,
    }),
  );
  const icon = project.projectIcon;
  // Decide which icon the sidebar shows, in the same order ProjectFavicon does.
  const imageSrc = icon == null && src && !isProjectFaviconFallbackUrl(src) ? src : null;
  const pixels = useImagePixels(imageSrc);
  let source: FleetIconSource;
  if (icon?.kind === "monogram" || icon?.kind === "lucide") {
    source = { kind: "badge", color: icon.color };
  } else if (icon?.kind === "emoji") {
    source = { kind: "none" };
  } else if (imageSrc === null || pixels === "failed") {
    // No image, or one that would not load: the sidebar shows the generated badge.
    source = { kind: "badge", color: deriveProjectIdentity(project.title).color };
  } else if (pixels === undefined) {
    return props.children(PENDING);
  } else {
    source = { kind: "image", pixels: pixels === "unreadable" ? null : pixels };
  }
  return props.children(toneProps(chooseFleetTone(source, props.repo)));
}

type ImagePixels = Uint8ClampedArray | "unreadable" | "failed";

// Each image is read once per page load; every row showing it shares the result.
const SAMPLE_SIZE = 32;
const pendingPixels = new Map<string, Promise<ImagePixels>>();
const settledPixels = new Map<string, ImagePixels>();

async function samplePixels(src: string): Promise<ImagePixels> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = src;
  try {
    // decode() holds the image until it settles; a bare load listener does not.
    await image.decode();
  } catch {
    return "failed";
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return "unreadable";
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    // A cross-origin image without CORS headers cannot be read back.
    return "unreadable";
  }
}

function readImagePixels(src: string): Promise<ImagePixels> {
  const pending =
    pendingPixels.get(src) ??
    samplePixels(src).then((pixels) => {
      settledPixels.set(src, pixels);
      return pixels;
    });
  pendingPixels.set(src, pending);
  return pending;
}

/** The image's pixels once read, or undefined while reading. */
function useImagePixels(src: string | null): ImagePixels | undefined {
  // The result lives in state, not only in the shared cache, so the row
  // re-renders with it: a read from a module-level map is not a dependency
  // React can see.
  const [read, setRead] = useState<{ readonly src: string; readonly pixels: ImagePixels } | null>(
    () => {
      // A row mounting after the image was read starts in its colour.
      const pixels = src === null ? undefined : settledPixels.get(src);
      return src !== null && pixels !== undefined ? { src, pixels } : null;
    },
  );
  useEffect(() => {
    if (src === null) return;
    let live = true;
    void readImagePixels(src).then((pixels) => {
      if (!live) return;
      setRead((current) =>
        current?.src === src && current.pixels === pixels ? current : { src, pixels },
      );
    });
    return () => {
      live = false;
    };
  }, [src]);
  return src !== null && read?.src === src ? read.pixels : undefined;
}
