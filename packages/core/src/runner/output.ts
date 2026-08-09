const SECRET_REPLACEMENT = "[REDACTED]";
const PROMPT_REPLACEMENT = "[PROMPT OMITTED]";
const MODEL_QUEUE_EXHAUSTED_MESSAGE = "model queue recovery attempts exceeded";

function takeLast(value: Buffer, limit: number): Buffer {
  return value.length <= limit ? value : value.subarray(value.length - limit);
}

export class OutputCollector {
  private readonly captureLimitBytes: number;
  private readonly hardLimitBytes: number;
  private readonly headLimitBytes: number;
  private readonly tailLimitBytes: number;
  private full: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private head: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  totalBytes = 0;
  truncated = false;
  exceededHardLimit = false;

  constructor(captureLimitBytes: number, hardLimitBytes: number) {
    this.captureLimitBytes = captureLimitBytes;
    this.hardLimitBytes = hardLimitBytes;
    this.headLimitBytes = Math.floor(captureLimitBytes / 2);
    this.tailLimitBytes = captureLimitBytes - this.headLimitBytes;
  }

  push(chunk: Buffer | string): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.totalBytes += value.length;
    if (this.totalBytes > this.hardLimitBytes) this.exceededHardLimit = true;

    if (!this.truncated && this.full.length + value.length <= this.captureLimitBytes) {
      this.full = Buffer.concat([this.full, value]);
      return;
    }
    if (!this.truncated) {
      this.truncated = true;
      const remainingHead = Math.max(0, this.headLimitBytes - this.full.length);
      this.head = Buffer.concat([this.full, value.subarray(0, remainingHead)]).subarray(
        0,
        this.headLimitBytes,
      );
      const previousTail = this.full.subarray(Math.max(0, this.full.length - this.tailLimitBytes));
      this.tail =
        value.length >= this.tailLimitBytes
          ? takeLast(value, this.tailLimitBytes)
          : takeLast(Buffer.concat([previousTail, value]), this.tailLimitBytes);
      this.full = Buffer.alloc(0);
      return;
    }
    this.tail = takeLast(Buffer.concat([this.tail, value]), this.tailLimitBytes);
  }

  toString(): string {
    if (!this.truncated) return this.full.toString("utf8");
    const omittedBytes = Math.max(0, this.totalBytes - this.head.length - this.tail.length);
    const marker = `\n[output truncated; ${omittedBytes} bytes omitted]\n`;
    return Buffer.concat([this.head, Buffer.from(marker), this.tail]).toString("utf8");
  }
}

export function redactSecrets(text: string, prompt = ""): string {
  let redacted = prompt.length > 0 ? text.split(prompt).join(PROMPT_REPLACEMENT) : text;
  redacted = redacted
    .replace(/(\bAuthorization\s*:\s*Bearer\s+)[^\s"']+/gi, `$1${SECRET_REPLACEMENT}`)
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${SECRET_REPLACEMENT}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, SECRET_REPLACEMENT)
    .replace(/\bghp_[A-Za-z0-9]{8,}/g, SECRET_REPLACEMENT)
    .replace(/\bAKIA[0-9A-Z]{12,}/g, SECRET_REPLACEMENT)
    .replace(
      /(\b(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*)(["']?)[^\s,"']+\2/gi,
      `$1$2${SECRET_REPLACEMENT}$2`,
    );
  return redacted;
}

export function isModelQueueExhausted(stdout: string, stderr: string): boolean {
  return `${stdout}\n${stderr}`.toLowerCase().includes(MODEL_QUEUE_EXHAUSTED_MESSAGE);
}
