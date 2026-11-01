// OpenCat: which addresses the WhatsApp panel window may load, and which one closes it.
// Kept free of Electron so the rules are testable. The panel is a modal without a title bar, so it needs
// a close route of its own: a page cannot always call `window.close()` in an Electron window.

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** The panel's own address, on the same loopback origin and under the secret path. Nothing else loads. */
export function isPanelUrlAllowed(panelUrl: string, target: string): boolean {
  const panel = parse(panelUrl);
  const next = parse(target);
  return panel !== null && next !== null && next.origin === panel.origin && next.pathname.startsWith(panel.pathname);
}

/** `<panel>/fechar`: the page asks to close its window by going there; the main process intercepts it. */
export function isPanelCloseUrl(panelUrl: string, target: string): boolean {
  const panel = parse(panelUrl);
  const next = parse(target);
  return (
    panel !== null &&
    next !== null &&
    next.origin === panel.origin &&
    next.pathname === `${panel.pathname.replace(/\/$/, "")}/fechar`
  );
}
