// The self-introduction envelope that rides inside a sealed body — a browser
// copy of packBody/unpackBody from src/core-net.ts (which can't be bundled for
// the web: it imports node:fs/node:crypto at module top). Wire format is the
// contract; keep this byte-compatible with the CLI (envelope v1, see
// test/unit/envelope.test.ts).

export const ENVELOPE_V = 1;

export interface SenderIntro {
  boxPub: string;
  name?: string;
  handle?: string;
}

export function packBody(me: SenderIntro, text: string): string {
  const env: {
    v: number;
    text: string;
    name?: string;
    handle?: string;
    boxPub: string;
  } = { v: ENVELOPE_V, text, boxPub: me.boxPub };
  if (me.name) env.name = me.name;
  if (me.handle) env.handle = me.handle;
  return JSON.stringify(env);
}

export interface Unpacked {
  text: string;
  name?: string;
  handle?: string;
  boxPub?: string;
  answered_by?: "assistant";
}

export function unpackBody(plaintext: string): Unpacked {
  try {
    const o = JSON.parse(plaintext) as Record<string, unknown>;
    if (o && typeof o === "object" && o.v === ENVELOPE_V && typeof o.text === "string") {
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      return {
        text: o.text,
        name: str(o.name),
        handle: str(o.handle),
        boxPub: str(o.boxPub),
        answered_by: o.answered_by === "assistant" ? "assistant" : undefined,
      };
    }
  } catch {
    /* not our envelope — legacy plain body */
  }
  return { text: plaintext };
}
