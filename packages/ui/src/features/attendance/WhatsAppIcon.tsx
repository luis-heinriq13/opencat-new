/**
 * The WhatsApp outline for the page rail. Lucide has no brand icons, so this is the one local icon
 * (the exception AGENTS asks to document). It has the grid, stroke and round caps of a Lucide icon and
 * takes its color from `currentColor`, so it is the same color and size as the other rail icons.
 * The geometry follows the Tabler "brand-whatsapp" outline (MIT).
 */
/** Decorative: the button around it carries the name. The `aria-hidden` prop only keeps the icon API of the rail. */
export function WhatsAppIcon(props: { class?: string | undefined; "aria-hidden"?: "true" | undefined }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      <path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21" />
      <path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1" />
    </svg>
  );
}
