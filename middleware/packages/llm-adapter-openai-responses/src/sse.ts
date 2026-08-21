/**
 * Minimal incremental Server-Sent-Events parser.
 *
 * Feed raw text chunks (arbitrary split points — a frame may arrive across
 * chunks); complete events come out. Only the `event:` and `data:` fields are
 * needed for the Responses stream; comments and other fields are ignored.
 * Multi-line `data:` values are joined with `\n` per the SSE spec.
 */

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

export class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];

  /** Parse a chunk; returns every event completed by it. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        // Blank line = dispatch.
        if (this.dataLines.length > 0 || this.eventName !== '') {
          events.push({
            event: this.eventName || 'message',
            data: this.dataLines.join('\n'),
          });
        }
        this.eventName = '';
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(':')) continue; // comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.eventName = value;
      else if (field === 'data') this.dataLines.push(value);
      // id / retry / unknown fields: ignored.
    }
    return events;
  }
}
