// A count as every Headless client line prints it: `en-US` grouped
// (`48,213`), and with its noun, singular for exactly one. A noun of several
// words takes its plural on the last (`2 new models`).

export function count(n: number): string {
  return n.toLocaleString("en-US");
}

export function plural(n: number, noun: string): string {
  return `${count(n)} ${n === 1 ? noun : `${noun}s`}`;
}
