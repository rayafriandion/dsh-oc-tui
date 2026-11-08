// The palette keys are shared by chrome, transcript, markdown, and diagrams.
export const DEFAULT_THEME = 'deepseek'

export const THEME_IDS = ['deepseek', 'github-dark', 'dracula', 'vscode-dark', 'nord']

const deepseek = {
  primary: '4d6bfe', secondary: '6c9cff', accent: '7c9cff',
  error: 'e06c75', warning: 'e8c468', success: '7fd88f', info: '56b6c2',
  text: 'f0f4ff', textMuted: 'a0aac0',
  background: '0a0e18', backgroundPanel: '111a2c', backgroundElement: '1b2740',
  border: '3d4d73', borderSubtle: '2b3a5c',
  markdownHeading: '7c9cff', markdownLinkText: '6c9cff', markdownCode: '7fd88f',
  markdownCodeBlock: 'f0f4ff', markdownBlockQuote: '9fb0d8',
  markdownListItem: '4d6bfe', markdownHorizontalRule: '46547a', codeBg: '111a2c',
  thinking: '9aa6c2', reminder: 'c5bdf7', imageChipBg: 'd97706', imageChipText: '1a0d00',
  compaction: '95d8c0', inbox: '9fd0e8', steering: '9fd0e8', systemPrompt: 'b9c4dd',
  contextSystem: '7fd88f', contextTools: 'e8c468', contextMessages: '56b6c2',
  selection: '3153b8',
  syntaxKeyword: 'c792ea', syntaxString: '9ece8f', syntaxNumber: 'e5b567',
  syntaxComment: '8994b0', syntaxFunction: '82aaff', syntaxType: 'e5c07b',
  tableBorder: '41528a', userPointer: '4d6bfe', assistantLabel: '9aa6c2',
}

const palettes = {
  deepseek,
  'github-dark': {
    ...deepseek,
    primary: '58a6ff', secondary: '79c0ff', accent: '79c0ff',
    error: 'ff7b72', warning: 'e3b341', success: '3fb950', info: '58a6ff',
    text: 'e6edf3', textMuted: 'a0aab5', background: '0d1117',
    backgroundPanel: '161b22', backgroundElement: '21262d', border: '484f58', borderSubtle: '30363d',
    markdownHeading: '79c0ff', markdownLinkText: '58a6ff', markdownCode: 'a5d6ff',
    markdownCodeBlock: 'e6edf3', markdownBlockQuote: 'a0aab5', markdownListItem: '58a6ff',
    markdownHorizontalRule: '484f58', codeBg: '161b22',
    thinking: 'a0aab5', reminder: 'd2a8ff', compaction: '7ee787',
    inbox: '79c0ff', steering: '79c0ff', systemPrompt: 'b1bac4',
    contextSystem: '3fb950', contextTools: 'e3b341', contextMessages: '58a6ff',
    selection: '264f78', syntaxKeyword: 'ff7b72', syntaxString: 'a5d6ff',
    syntaxNumber: '79c0ff', syntaxComment: '8b949e', syntaxFunction: 'd2a8ff',
    syntaxType: 'ffa657', tableBorder: '484f58', userPointer: '58a6ff', assistantLabel: 'a0aab5',
  },
  dracula: {
    ...deepseek,
    primary: 'bd93f9', secondary: '8be9fd', accent: 'bd93f9',
    error: 'ff5555', warning: 'f1fa8c', success: '50fa7b', info: '8be9fd',
    text: 'f8f8f2', textMuted: 'b0b4ca', background: '191a24',
    backgroundPanel: '222430', backgroundElement: '2c2f3e', border: '6272a4', borderSubtle: '50566f',
    markdownHeading: 'bd93f9', markdownLinkText: '8be9fd', markdownCode: '50fa7b',
    markdownCodeBlock: 'f8f8f2', markdownBlockQuote: 'b0b4ca', markdownListItem: 'bd93f9',
    markdownHorizontalRule: '6272a4', codeBg: '222430',
    thinking: 'b0b4ca', reminder: 'ff79c6', compaction: '50fa7b',
    inbox: '8be9fd', steering: '8be9fd', systemPrompt: 'c2c7df',
    contextSystem: '50fa7b', contextTools: 'f1fa8c', contextMessages: '8be9fd',
    selection: '333a50', syntaxKeyword: 'ff79c6', syntaxString: 'f1fa8c',
    syntaxNumber: 'bd93f9', syntaxComment: '9ba7d0', syntaxFunction: '50fa7b',
    syntaxType: '8be9fd', tableBorder: '6272a4', userPointer: 'bd93f9', assistantLabel: 'b0b4ca',
  },
  'vscode-dark': {
    ...deepseek,
    primary: '3794ff', secondary: '9cdcfe', accent: '4fc1ff',
    error: 'f48771', warning: 'cca700', success: '89d185', info: '75beff',
    text: 'd4d4d4', textMuted: 'a8a8a8', background: '1e1e1e',
    backgroundPanel: '252526', backgroundElement: '333333', border: '555555', borderSubtle: '3c3c3c',
    markdownHeading: '569cd6', markdownLinkText: '4fc1ff', markdownCode: 'ce9178',
    markdownCodeBlock: 'd4d4d4', markdownBlockQuote: 'a8a8a8', markdownListItem: '3794ff',
    markdownHorizontalRule: '555555', codeBg: '252526',
    thinking: 'a8a8a8', reminder: 'c586c0', compaction: '89d185',
    inbox: '9cdcfe', steering: '9cdcfe', systemPrompt: 'bcbcbc',
    contextSystem: '89d185', contextTools: 'cca700', contextMessages: '75beff',
    selection: '264f78', syntaxKeyword: 'c586c0', syntaxString: 'ce9178',
    syntaxNumber: 'b5cea8', syntaxComment: '8aaa80', syntaxFunction: 'dcdcaa',
    syntaxType: '4ec9b0', tableBorder: '555555', userPointer: '3794ff', assistantLabel: 'a8a8a8',
  },
  nord: {
    ...deepseek,
    primary: '88c0d0', secondary: '81a1c1', accent: '8fbcbb',
    error: 'bf616a', warning: 'ebcb8b', success: 'a3be8c', info: '88c0d0',
    text: 'eceff4', textMuted: 'b0bccd', background: '191f29',
    backgroundPanel: '252c39', backgroundElement: '2b3443', border: '677994', borderSubtle: '4c566a',
    markdownHeading: '88c0d0', markdownLinkText: '8fbcbb', markdownCode: 'a3be8c',
    markdownCodeBlock: 'eceff4', markdownBlockQuote: 'b0bccd', markdownListItem: '88c0d0',
    markdownHorizontalRule: '677994', codeBg: '252c39',
    thinking: 'b0bccd', reminder: 'b48ead', compaction: 'a3be8c',
    inbox: '88c0d0', steering: '88c0d0', systemPrompt: 'd8dee9',
    contextSystem: 'a3be8c', contextTools: 'ebcb8b', contextMessages: '88c0d0',
    selection: '344253', syntaxKeyword: '81a1c1', syntaxString: 'a3be8c',
    syntaxNumber: 'b48ead', syntaxComment: 'a0afc3', syntaxFunction: '88c0d0',
    syntaxType: '8fbcbb', tableBorder: '677994', userPointer: '88c0d0', assistantLabel: 'b0bccd',
  },
}

for (const palette of Object.values(palettes)) Object.freeze(palette)
export const THEME = palettes[DEFAULT_THEME]

export function themeId(value) {
  return typeof value === 'string' && Object.hasOwn(palettes, value) ? value : DEFAULT_THEME
}

export function getTheme(value) {
  return palettes[themeId(value)]
}
