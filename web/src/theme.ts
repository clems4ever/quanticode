import { createTheme, rem, type MantineColorsTuple } from "@mantine/core";

/**
 * The UI chrome is deliberately achromatic.
 *
 * Every warm hue on screen belongs to the heat scale; if buttons and links were
 * also warm, chrome would read as data. Graphite carries the interface, the
 * ember ramp carries the meaning.
 */
const graphite: MantineColorsTuple = [
  "#f6f7f9", "#eceef1", "#d9dce2", "#c4c9d2", "#b0b6c2",
  "#9aa1b0", "#7f8798", "#646b7b", "#4a505e", "#2f3440",
];

export const theme = createTheme({
  primaryColor: "graphite",
  primaryShade: { light: 8, dark: 4 },
  colors: { graphite },
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  defaultRadius: "md",
  radius: { md: rem(10), lg: rem(14) },
  headings: {
    fontWeight: "650",
    sizes: {
      h1: { fontSize: rem(30), lineHeight: "1.2" },
      h2: { fontSize: rem(21), lineHeight: "1.25" },
      h3: { fontSize: rem(16), lineHeight: "1.3" },
    },
  },
  components: {
    Paper: { defaultProps: { withBorder: true, radius: "lg" } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 250, radius: "md" } },
  },
});
