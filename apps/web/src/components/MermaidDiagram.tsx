import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, Maximize2Icon, MinusIcon, PlusIcon } from "lucide-react";
import { mermaidImages, renderMermaid, type MermaidImage } from "../lib/mermaid";
import { serializeMarkdownCodeFence } from "../markdown-clipboard";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { composerFloatingLayerProps } from "./chat/composerEventScope";

function MermaidViewport({ image }: { image: MermaidImage }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const transformRef = useRef(transform);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const updateTransform = useCallback((next: typeof transform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scale = Math.min(
      1,
      Math.max(1, viewport.clientWidth - 32) / image.width,
      Math.max(1, viewport.clientHeight - 32) / image.height,
    );
    updateTransform({
      scale,
      x: (viewport.clientWidth - image.width * scale) / 2,
      y: (viewport.clientHeight - image.height * scale) / 2,
    });
  }, [image.width, image.height, updateTransform]);

  const zoom = useCallback(
    (factor: number, point?: { x: number; y: number }) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const current = transformRef.current;
      const bounds = viewport.getBoundingClientRect();
      const x = point ? point.x - bounds.left : viewport.clientWidth / 2;
      const y = point ? point.y - bounds.top : viewport.clientHeight / 2;
      const scale = Math.min(16, Math.max(0.001, current.scale * factor));
      updateTransform({
        scale,
        x: x - ((x - current.x) * scale) / current.scale,
        y: y - ((y - current.y) * scale) / current.scale,
      });
    },
    [updateTransform],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    fit();
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      zoom(Math.exp(-delta * 0.002), { x: event.clientX, y: event.clientY });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("wheel", wheel);
    };
  }, [fit, zoom]);

  return (
    <>
      <div className="flex items-center gap-2 px-4 pb-3" role="toolbar" aria-label="Diagram zoom">
        <Button variant="outline" size="sm" onClick={fit}>
          Fit
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Zoom out"
          onClick={() => zoom(1 / 1.5)}
        >
          <MinusIcon />
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Zoom in" onClick={() => zoom(1.5)}>
          <PlusIcon />
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {Math.round(transform.scale * 100)}%
        </span>
      </div>
      <div
        ref={viewportRef}
        role="region"
        aria-label="Diagram canvas"
        aria-description="Drag to pan. Scroll or pinch to zoom. Use plus and minus to zoom, arrow keys to pan, and 0 to fit."
        tabIndex={0}
        className="relative min-h-0 flex-1 touch-none overflow-hidden bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ cursor: "grab" }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          const current = transformRef.current;
          switch (event.key) {
            case "+":
            case "=":
              zoom(1.5);
              break;
            case "-":
              zoom(1 / 1.5);
              break;
            case "0":
            case "f":
              fit();
              break;
            case "ArrowLeft":
              updateTransform({ ...current, x: current.x + 40 });
              break;
            case "ArrowRight":
              updateTransform({ ...current, x: current.x - 40 });
              break;
            case "ArrowUp":
              updateTransform({ ...current, y: current.y + 40 });
              break;
            case "ArrowDown":
              updateTransform({ ...current, y: current.y - 40 });
              break;
            default:
              return;
          }
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          const next = { x: event.clientX, y: event.clientY };
          const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
          if (other) {
            const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
            const newDistance = Math.hypot(next.x - other.x, next.y - other.y);
            if (oldDistance > 0 && newDistance > 0) {
              zoom(newDistance / oldDistance, {
                x: (previous.x + other.x) / 2,
                y: (previous.y + other.y) / 2,
              });
            }
          }
          const current = transformRef.current;
          updateTransform({
            ...current,
            x: current.x + (next.x - previous.x) / (other ? 2 : 1),
            y: current.y + (next.y - previous.y) / (other ? 2 : 1),
          });
          pointers.current.set(event.pointerId, next);
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
        onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
      >
        <img
          src={image.src}
          alt={image.description}
          draggable={false}
          className="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left select-none"
          style={{
            width: image.width,
            height: image.height,
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        />
      </div>
    </>
  );
}

// The caller keys this component by source and theme so async results cannot be
// displayed for a different diagram after an edit or theme change.
export function MermaidDiagram({
  code,
  language,
  title,
  theme,
  source,
}: {
  code: string;
  language: string;
  title: string | null;
  theme: "light" | "dark";
  source: ReactNode;
}) {
  const [image, setImage] = useState(() => mermaidImages.get(`${theme}\n${code}`));
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: "400px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || showSource || image || error) return;
    let active = true;
    void renderMermaid(code, theme, () => active).then(
      (result) => {
        if (active && result) setImage(result);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not render diagram.");
      },
    );
    return () => {
      active = false;
    };
  }, [code, theme, visible, showSource, image, error]);

  return (
    <div
      ref={hostRef}
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-[var(--radius)] border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-wrap="true"
    >
      <div className="chat-markdown-codeblock-header flex flex-wrap items-center justify-between gap-2 p-2 pl-3 select-none">
        <span className="min-w-0 truncate font-mono text-xs">{title ?? "Mermaid"}</span>
        <div className="flex items-center gap-1" role="toolbar" aria-label="Diagram actions">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showSource}
            onClick={() => setShowSource(!showSource)}
          >
            {showSource ? "Preview" : "Source"}
          </Button>
          <Button
            ref={expandRef}
            variant="ghost"
            size="icon-sm"
            aria-label="Expand diagram"
            disabled={!image || Boolean(error)}
            onClick={() => setExpanded(true)}
          >
            <Maximize2Icon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? "Copied" : "Copy diagram source"}
            onClick={() => {
              if (!navigator.clipboard) {
                setCopyError(true);
                return;
              }
              void navigator.clipboard.writeText(code).then(
                () => {
                  setCopyError(false);
                  setCopied(true);
                  if (copyTimer.current !== null) clearTimeout(copyTimer.current);
                  copyTimer.current = setTimeout(() => setCopied(false), 1200);
                },
                () => setCopyError(true),
              );
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
      </div>
      {copyError && (
        <p role="alert" className="px-3 text-xs text-destructive">
          Could not copy. Select and copy the source instead.
        </p>
      )}
      {error && !showSource && (
        <div role="alert" className="px-3 py-2 text-xs text-muted-foreground">
          <p className="whitespace-pre-wrap">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              setImage(null);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {!showSource && !image && !error && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          Preparing diagram…
        </p>
      )}
      {showSource || !image || error ? (
        source
      ) : (
        <div
          className="flex max-h-[60vh] justify-center overflow-auto bg-background p-3"
          data-markdown-copy={serializeMarkdownCodeFence(code, language)}
        >
          <img
            src={image.src}
            alt={image.description}
            className="block h-auto max-w-full self-start"
            style={{ width: image.width }}
            onError={() => setError("Could not display diagram. The source is available below.")}
          />
        </div>
      )}
      {expanded && image && (
        <Dialog open onOpenChange={(open) => setExpanded(open)}>
          <DialogPopup
            {...composerFloatingLayerProps}
            bottomStickOnMobile={false}
            finalFocus={expandRef}
            className="flex h-[90dvh] w-[96vw] max-w-[96vw] flex-col overflow-hidden p-0 sm:w-[92vw]"
          >
            <DialogTitle className="px-4 pt-4 pr-12 pb-3 text-base">
              {title ?? "Mermaid diagram"}
            </DialogTitle>
            <MermaidViewport image={image} />
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}
