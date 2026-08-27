export interface RedactionOptions {
  extraSecrets?: string[];
}

const SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function redact(value: string, options: RedactionOptions = {}): string {
  let output = value.replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]').replace(SECRET_PATTERN, '[REDACTED_SECRET]');
  for (const secret of options.extraSecrets ?? []) {
    if (secret) output = output.split(secret).join('[REDACTED_SECRET]');
  }
  return output;
}