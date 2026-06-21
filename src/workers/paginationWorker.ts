interface Request {
  text: string;
  width: number;
  height: number;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  bold: boolean;
}

function glyphWidth(code: number, fontSize: number, letterSpacing: number, bold: boolean) {
  let ratio = 1;
  if (code === 32 || code === 9) ratio = code === 9 ? 1.32 : .33;
  else if (code < 128) {
    if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) ratio = .6;
    else if (code >= 97 && code <= 122) ratio = .53;
    else ratio = .42;
  } else if (code >= 0x2000 && code <= 0x206f) ratio = .5;
  return fontSize * ratio * (bold ? 1.035 : 1) + letterSpacing;
}

self.onmessage = ({ data }: MessageEvent<Request>) => {
  const { text } = data;
  const lineLimit = Math.max(1, data.width);
  const maxLines = Math.max(1, Math.floor(data.height / Math.max(1, data.fontSize * data.lineHeight)));
  const starts: number[] = [0];
  let line = 0;
  let lineWidth = 0;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) continue;
    if (code === 10) {
      line++;
      lineWidth = 0;
      if (line >= maxLines && index + 1 < text.length) {
        starts.push(index + 1);
        line = 0;
      }
      continue;
    }
    const width = glyphWidth(code, data.fontSize, data.letterSpacing, data.bold);
    if (lineWidth > 0 && lineWidth + width > lineLimit) {
      line++;
      lineWidth = 0;
      if (line >= maxLines) {
        starts.push(index);
        line = 0;
      }
    }
    lineWidth += width;
  }
  if (starts[starts.length - 1] !== text.length) starts.push(text.length);
  const result = Int32Array.from(starts);
  self.postMessage(result, [result.buffer]);
};
