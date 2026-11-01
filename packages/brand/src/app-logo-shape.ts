// The OpenBot mark as plain data, so that a canvas can draw the same mark that
// `AppLogo` draws as SVG: the social cards in apps/auth-api do.

/** The mark is a square of this side, in its own units. */
export const APP_LOGO_SIZE = 240;
/** The corner radius of the square, in the same units. */
export const APP_LOGO_CORNER = 50;

/** The cat head of the OpenCat mark, from the mascot path, in the same units as the square. */
export const APP_LOGO_CAT_PATH =
  "M73.2 85.4L73.2 51.7Q73.2 44.2 80.7 49.8L105 72.3Q120 66.6 135 72.3L159.3 49.8Q166.8 44.2 166.8 51.7L166.8 85.4Q185.5 104.1 183.6 139.7Q183.6 192.1 120 195.8Q56.4 192.1 56.4 139.7Q54.5 104.1 73.2 85.4Z";

/** Each eye is one short vertical stroke with round caps, as SVG `points`: a pill. */
export const APP_LOGO_EYE_POINTS = {
  left: "93.8 128.2 93.8 139.8",
  right: "146.2 128.2 146.2 139.8",
} as const;

/** The stroke width of an eye, in the same units. */
export const APP_LOGO_EYE_STROKE = 23.6;
