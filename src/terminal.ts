/** Semantic accents use the terminal's own palette and preserve its background. */
export function createTheme(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.NO_COLOR !== undefined ? false
    : env.FORCE_COLOR !== undefined ? env.FORCE_COLOR !== '0'
    : Boolean(stream.isTTY) && env.TERM !== 'dumb';

  const paint = (code: string, text: string) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

  return {
    heading: (text: string) => paint('1;36', text),
    label: (text: string) => paint('1', text),
    next: (text: string) => paint('1;32', text),
    success: (text: string) => paint('32', text),
    warning: (text: string) => paint('33', text),
    idea: (text: string) => paint('35', text),
    error: (text: string) => paint('1;31', text),
  };
}

export type Theme = ReturnType<typeof createTheme>;
