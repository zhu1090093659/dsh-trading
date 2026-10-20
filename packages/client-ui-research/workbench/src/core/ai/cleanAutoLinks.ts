interface LinkNode { type: string; url?: string; value?: string; children?: LinkNode[];
  position?: { start: { offset?: number }; end: { offset?: number } } }

/** Only repair bare autolinks; explicit Markdown destinations (including signed URLs) stay intact. */
export function cleanAutoLinks() {
  return (tree: LinkNode, file: { value?: unknown }): void => {
    const source = typeof file.value === "string" ? file.value : "";
    const walk = (node: LinkNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "link" && child.url && child.children?.length === 1) {
          const label = child.children[0];
          const text = label?.type === "text" ? label.value : undefined;
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const bare = start !== undefined && end !== undefined && source.slice(start, end) === text;
          if (bare && text && /^https?:\/\//.test(text) && child.url === text) {
            const suffix = text.match(/[），。；！？、】》]+$/)?.[0];
            if (suffix) return [
              { ...child, url: text.slice(0, -suffix.length), children: [{ type: "text", value: text.slice(0, -suffix.length) }] },
              { type: "text", value: suffix },
            ];
          }
        }
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}
