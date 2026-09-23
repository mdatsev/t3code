import { LRUCache } from "./lruCache";

export interface MermaidImage {
  src: string;
  width: number;
  height: number;
  description: string;
}

// Virtualized chat rows remount as they scroll. Bound both retained SVG bytes and entries.
export const mermaidImages = new LRUCache<MermaidImage>(32, 8 * 1024 * 1024);
let renderQueue = Promise.resolve();
let nextDiagramId = 0;

export function renderMermaid(code: string, theme: "light" | "dark", isActive: () => boolean) {
  // Mermaid's configuration and temporary DOM are global; keep initialization and
  // rendering in the same queue, including renders from different Markdown surfaces.
  const result = renderQueue.then(async () => {
    if (!isActive()) return null;
    if (code.length > 50_000) throw new Error("Diagram exceeds the 50,000 character limit.");
    const cacheKey = `${theme}\n${code}`;
    const cached = mermaidImages.get(cacheKey);
    if (cached) return cached;
    const { default: mermaid } = await import("mermaid");
    if (!isActive()) return null;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 500,
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // Diagram-authored directives/frontmatter cannot override the host's configuration.
      secure: Object.keys(mermaid.mermaidAPI.defaultConfig),
    });
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
    document.body.append(host);
    try {
      const { svg } = await mermaid.render(`t3-mermaid-${++nextDiagramId}`, code, host);
      const documentSvg = new DOMParser().parseFromString(svg, "image/svg+xml");
      const root = documentSvg.documentElement;
      const dimensions = root
        .getAttribute("viewBox")
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
      const width = dimensions?.[2];
      const height = dimensions?.[3];
      if (
        root.localName !== "svg" ||
        width === undefined ||
        height === undefined ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
      )
        throw new Error("Diagram has no usable dimensions.");
      // Explicit dimensions keep SVG images sharp and correctly sized outside the DOM.
      root.setAttribute("width", String(width));
      root.setAttribute("height", String(height));
      root.removeAttribute("style");
      const image = {
        src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`,
        width,
        height,
        description:
          [root.querySelector("title")?.textContent, root.querySelector("desc")?.textContent]
            .filter(Boolean)
            .join(". ") || "Mermaid diagram. Use Source to read the diagram text.",
      };
      mermaidImages.set(cacheKey, image, (cacheKey.length + image.src.length) * 2);
      return image;
    } finally {
      host.remove();
    }
  });
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
