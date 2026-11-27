/** Drop metadata-bearing JPEG and PNG chunks before making images portable. */
export function stripImageMetadata(
  bytes: Uint8Array,
  type: string,
): Uint8Array {
  const pieces: Uint8Array[] = [];
  if (type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    pieces.push(bytes.subarray(0, 2));
    let i = 2;
    while (i < bytes.length) {
      const start = i;
      if (bytes[i++] !== 0xff) throw new Error("Invalid JPEG image");
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xda) {
        if (i + 2 > bytes.length) throw new Error("Invalid JPEG image");
        const length = bytes[i] * 256 + bytes[i + 1];
        if (length < 2 || i + length > bytes.length)
          throw new Error("Invalid JPEG image");
        i += length;
        while (i < bytes.length) {
          if (bytes[i] !== 0xff) {
            i++;
            continue;
          }
          let next = i + 1;
          while (bytes[next] === 0xff) next++;
          const code = bytes[next];
          if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
            i = next + 1;
            continue;
          }
          break;
        }
        pieces.push(bytes.subarray(start, i));
        continue;
      }
      if (marker === 0xd9) {
        pieces.push(bytes.subarray(start, i));
        return join(pieces);
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pieces.push(bytes.subarray(start, i));
        continue;
      }
      if (i + 2 > bytes.length) throw new Error("Invalid JPEG image");
      const length = bytes[i] * 256 + bytes[i + 1];
      if (length < 2 || i + length > bytes.length)
        throw new Error("Invalid JPEG image");
      if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe))
        pieces.push(bytes.subarray(start, i + length));
      i += length;
    }
    throw new Error("Invalid JPEG image");
  }
  if (
    type === "image/png" &&
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  ) {
    pieces.push(bytes.subarray(0, 8));
    let i = 8;
    while (i + 12 <= bytes.length) {
      const length = new DataView(
          bytes.buffer,
          bytes.byteOffset + i,
          4,
        ).getUint32(0),
        end = i + 12 + length;
      if (end > bytes.length) throw new Error("Invalid PNG image");
      const name = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
      if ((bytes[i + 4] & 32) === 0 || name === "tRNS")
        pieces.push(bytes.subarray(i, end));
      i = end;
      if (name === "IEND") return join(pieces);
    }
    throw new Error("Invalid PNG image");
  }
  throw new Error("Recap image has an unsupported format");
}
function join(pieces: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of pieces) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
