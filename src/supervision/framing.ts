// Bounded protocol framing: oversized native messages fail the transport rather than parsing a truncated message.
export class BoundedLines {
  buffer = Buffer.alloc(0);
  discarded = false;
  max: number;
  onLine: (line: string) => void;
  onOverflow: (bytes: number) => void;
  constructor(
    max: number,
    onLine: (line: string) => void,
    onOverflow: (bytes: number) => void,
  ) {
    this.max = max;
    this.onLine = onLine;
    this.onOverflow = onOverflow;
  }
  push(chunk: Buffer) {
    if (this.discarded) return;
    let begin = 0;
    for (
      let end = chunk.indexOf(10);
      end >= 0;
      end = chunk.indexOf(10, begin)
    ) {
      const piece = chunk.subarray(begin, end);
      if (this.buffer.length + piece.length > this.max) {
        this.overflow(this.buffer.length + piece.length);
        return;
      }
      const line = Buffer.concat([this.buffer, piece]).toString("utf8");
      this.buffer = Buffer.alloc(0);
      this.onLine(line);
      if (this.discarded) return;
      begin = end + 1;
    }
    const tail = chunk.subarray(begin);
    if (this.buffer.length + tail.length > this.max) {
      this.overflow(this.buffer.length + tail.length);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, tail]);
  }
  overflow(bytes: number) {
    this.discarded = true;
    this.buffer = Buffer.alloc(0);
    this.onOverflow(bytes);
  }
}

import { Transform, type TransformCallback } from "node:stream";
// Transparent bytes up to a per-line bound. This sits BEFORE SDK JSON decoding.
export class BoundedNativeStream extends Transform {
  lineBytes = 0;
  max: number;
  onOverflow: (bytes: number) => void;
  constructor(max: number, onOverflow: (bytes: number) => void) {
    super({ highWaterMark: 65536 });
    this.max = max;
    this.onOverflow = onOverflow;
  }
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    let begin = 0;
    for (
      let end = chunk.indexOf(10);
      end >= 0;
      end = chunk.indexOf(10, begin)
    ) {
      this.lineBytes += end - begin;
      if (this.lineBytes > this.max) {
        this.onOverflow(this.lineBytes);
        callback(new Error("Native frame exceeds configured bound"));
        return;
      }
      this.lineBytes = 0;
      begin = end + 1;
    }
    this.lineBytes += chunk.length - begin;
    if (this.lineBytes > this.max) {
      this.onOverflow(this.lineBytes);
      callback(new Error("Native frame exceeds configured bound"));
      return;
    }
    callback(null, chunk);
  }
}
