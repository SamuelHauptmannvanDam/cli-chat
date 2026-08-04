// The encrypted blob as it travels to / rests in the hosted mailbox.
export interface WireMessage {
  id: string;
  recipient: string; // recipient signPub (mailbox key)
  sender: string; // sender signPub
  body: string; // base64 sealed-box ciphertext
  tags: string | null; // reserved for Phase 2 (encrypted meta tags)
  created_at: number;
  in_reply_to: string | null;
}
