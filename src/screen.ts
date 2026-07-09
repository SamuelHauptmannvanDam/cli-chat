// Inbound-message screening (AUTO-CHAT.md code of conduct): a cheap, pure
// heuristic pass over every received body that flags PROMPT INJECTION and
// PRIVILEGE OVERREACH — a sender trying to steer the agent, or asking for
// information that isn't theirs (other people's conversations, the user's
// secrets, the contact list, settings changes).
//
// This is a TRIPWIRE, not a sandbox. It cannot catch every phrasing, and a flag
// is not proof of malice — it means "do not auto-answer; surface to the human
// with the flag". The behavioural rules (untrusted bodies, the disclosure
// ruleset, per-sender grounding) remain the actual defence; this makes the
// obvious cases mechanical so they never depend on model judgement alone.
//
// Flags (stable identifiers — the agent renders them, tests pin them):
//   override    — tries to countermand the agent's instructions/role
//   secrets     — asks for keys, credentials, tokens, passwords
//   contacts    — asks for the user's contact list / network
//   third-party — asks about the user's conversations with, or mail from, others
//   action      — asks the agent to run commands / change settings / send onward

export type ScreenFlag = "override" | "secrets" | "contacts" | "third-party" | "action";

const RULES: { flag: ScreenFlag; re: RegExp }[] = [
  // Instruction override / role hijack.
  { flag: "override", re: /\b(ignore|disregard|forget|override)\b[^.!?\n]{0,40}\b(instructions?|rules?|guidelines?|previous|above)\b/i },
  { flag: "override", re: /\bsystem prompt\b/i },
  { flag: "override", re: /\byou are (now|no longer)\b/i },
  { flag: "override", re: /\bas your (developer|creator|administrator|admin)\b/i },
  { flag: "override", re: /\bnew (instructions?|persona|role) *:/i },

  // Secrets / key material.
  { flag: "secrets", re: /\b(send|give|show|share|reveal|forward|paste)\b[^.!?\n]{0,60}\b(private key|secret key|signing key|seed phrase|passwords?|credentials?|api[ -]?keys?|access tokens?|session tokens?)\b/i },
  { flag: "secrets", re: /\bwhat('?s| is)\b[^.!?\n]{0,40}\b(your|the) (private|secret|signing) key\b/i },

  // The address book / network.
  { flag: "contacts", re: /\b(send|give|show|share|list|forward|export)\b[^.!?\n]{0,60}\b(your|the) contacts?( list| book)?\b/i },
  { flag: "contacts", re: /\bwho (else )?(do you|are you|does \w+) (know|talk|talking|message|messaging|write) (to|with)\b/i },

  // Other people's conversations / mail (per-sender grounding: not theirs to have).
  { flag: "third-party", re: /\b(your|his|her|their) (conversations?|threads?|chats?|messages?|history|mail) with\b/i },
  // Two-letter minimum with a lowercase second character so "what did I say"
  // (the sender about themselves — within privilege) doesn't trip it.
  { flag: "third-party", re: /\bwhat (did|has|does) [A-Z][a-z][\w-]* (say|said|write|written|wrote|send|sent|tell|told)\b/ },
  { flag: "third-party", re: /\b(show|forward|share|send) (me )?[^.!?\n]{0,40}\b(messages?|mail|threads?) (from|with|between)\b/i },

  // Making the agent act.
  { flag: "action", re: /\brun (this|the following|that) (command|script|code)\b/i },
  { flag: "action", re: /\b(change|update|disable|turn off|set)\b[^.!?\n]{0,40}\b(your|the) settings?\b/i },
  { flag: "action", re: /\b(rotate|kill|disable)\b[^.!?\n]{0,30}\bhandle\b/i },
  { flag: "action", re: /\b(add|remove|apply)\b[^.!?\n]{0,30}\btags? (to|from|on)\b/i },
  { flag: "action", re: /\b(message|write to|contact) (everyone|all your contacts)\b/i },
];

// Screen one inbound body. Returns the distinct flags it trips, in rule order;
// empty array = nothing suspicious (the common case — keep this cheap).
export function screenBody(body: string): ScreenFlag[] {
  const out: ScreenFlag[] = [];
  for (const { flag, re } of RULES) {
    if (out.includes(flag)) continue;
    if (re.test(body)) out.push(flag);
  }
  return out;
}
