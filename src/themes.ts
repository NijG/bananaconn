// Terminal color themes (xterm.js ITheme).

import type { ITheme } from "@xterm/xterm";

export interface TermTheme {
  label: string;
  theme: ITheme;
}

export const TERM_THEMES: Record<string, TermTheme> = {
  banana: {
    label: "Banana Dark (기본)",
    theme: {
      background: "#0d1017", foreground: "#d8dee9", cursor: "#f5c518", cursorAccent: "#0d1017", selectionBackground: "#f5c51840",
      black: "#1c2130", red: "#f87171", green: "#4ade80", yellow: "#facc15", blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#d8dee9",
      brightBlack: "#5b6478", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde68a", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#ffffff",
    },
  },
  dracula: {
    label: "Dracula",
    theme: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", cursorAccent: "#282a36", selectionBackground: "#44475a",
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  },
  onedark: {
    label: "One Dark",
    theme: {
      background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", cursorAccent: "#282c34", selectionBackground: "#3e4451",
      black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  solarized: {
    label: "Solarized Dark",
    theme: {
      background: "#002b36", foreground: "#93a1a1", cursor: "#93a1a1", cursorAccent: "#002b36", selectionBackground: "#073642",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
  monokai: {
    label: "Monokai",
    theme: {
      background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0", cursorAccent: "#272822", selectionBackground: "#49483e",
      black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#f4bf75", blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
      brightBlack: "#75715e", brightRed: "#f92672", brightGreen: "#a6e22e", brightYellow: "#f4bf75", brightBlue: "#66d9ef", brightMagenta: "#ae81ff", brightCyan: "#a1efe4", brightWhite: "#f9f8f5",
    },
  },
  nord: {
    label: "Nord",
    theme: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", cursorAccent: "#2e3440", selectionBackground: "#434c5e",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
  gruvbox: {
    label: "Gruvbox Dark",
    theme: {
      background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2", cursorAccent: "#282828", selectionBackground: "#504945",
      black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921", blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
      brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26", brightYellow: "#fabd2f", brightBlue: "#83a598", brightMagenta: "#d3869b", brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
    },
  },
  tokyonight: {
    label: "Tokyo Night",
    theme: {
      background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", cursorAccent: "#1a1b26", selectionBackground: "#33467c",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a", brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7", brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
  },
  catppuccin: {
    label: "Catppuccin Mocha",
    theme: {
      background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", cursorAccent: "#1e1e2e", selectionBackground: "#45475a",
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
  },
  githubdark: {
    label: "GitHub Dark",
    theme: {
      background: "#0d1117", foreground: "#c9d1d9", cursor: "#58a6ff", cursorAccent: "#0d1117", selectionBackground: "#264f78",
      black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922", blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
    },
  },
  matrix: {
    label: "Matrix (녹색)",
    theme: {
      background: "#020a03", foreground: "#3cff6e", cursor: "#3cff6e", cursorAccent: "#020a03", selectionBackground: "#0f4d1d",
      black: "#020a03", red: "#33cc66", green: "#3cff6e", yellow: "#9dff5c", blue: "#2bd47a", magenta: "#5cff9e", cyan: "#4dffb8", white: "#b9ffcb",
      brightBlack: "#1f6b33", brightRed: "#5cff8a", brightGreen: "#7dff9b", brightYellow: "#c4ff8a", brightBlue: "#5cf0a0", brightMagenta: "#8affbf", brightCyan: "#8affd8", brightWhite: "#e6ffec",
    },
  },
  amber: {
    label: "Amber (호박색 단색)",
    theme: {
      background: "#140c00", foreground: "#ffb000", cursor: "#ffb000", cursorAccent: "#140c00", selectionBackground: "#5a3d00",
      black: "#140c00", red: "#ff8c00", green: "#ffb000", yellow: "#ffcc4d", blue: "#e69500", magenta: "#ffa64d", cyan: "#ffc266", white: "#ffd98a",
      brightBlack: "#7a5200", brightRed: "#ffa833", brightGreen: "#ffc233", brightYellow: "#ffdb80", brightBlue: "#ffb84d", brightMagenta: "#ffbf80", brightCyan: "#ffd699", brightWhite: "#fff0cc",
    },
  },
  solarizedlight: {
    label: "Solarized Light",
    theme: {
      background: "#fdf6e3", foreground: "#586e75", cursor: "#586e75", cursorAccent: "#fdf6e3", selectionBackground: "#eee8d5",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
  gruvboxlight: {
    label: "Gruvbox Light",
    theme: {
      background: "#fbf1c7", foreground: "#3c3836", cursor: "#3c3836", cursorAccent: "#fbf1c7", selectionBackground: "#d5c4a1",
      black: "#fbf1c7", red: "#cc241d", green: "#98971a", yellow: "#d79921", blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#7c6f64",
      brightBlack: "#928374", brightRed: "#9d0006", brightGreen: "#79740e", brightYellow: "#b57614", brightBlue: "#076678", brightMagenta: "#8f3f71", brightCyan: "#427b58", brightWhite: "#3c3836",
    },
  },
  catppuccinlatte: {
    label: "Catppuccin Latte",
    theme: {
      background: "#eff1f5", foreground: "#4c4f69", cursor: "#dc8a78", cursorAccent: "#eff1f5", selectionBackground: "#ccd0da",
      black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d", blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
      brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b", brightYellow: "#df8e1d", brightBlue: "#1e66f5", brightMagenta: "#ea76cb", brightCyan: "#179299", brightWhite: "#bcc0cc",
    },
  },
  light: {
    label: "Light (밝은 배경)",
    theme: {
      background: "#fbfbfa", foreground: "#24292f", cursor: "#24292f", cursorAccent: "#fbfbfa", selectionBackground: "#b6d3ff",
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
    },
  },
};

/** Themes with a light background, listed separately in the picker. */
export const LIGHT_THEMES = new Set(["light", "solarizedlight", "gruvboxlight", "catppuccinlatte"]);

export function termTheme(key: string): ITheme {
  return (TERM_THEMES[key] ?? TERM_THEMES.banana).theme;
}
