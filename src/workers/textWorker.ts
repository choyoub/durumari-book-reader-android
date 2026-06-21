import JSZip from "jszip";

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

self.onmessage = async ({ data }: MessageEvent<{ kind: "txt" | "zip"; bytes: Uint8Array }>) => {
  try {
    if (data.kind === "txt") {
      self.postMessage({ text: decode(data.bytes) });
      return;
    }
    const archive = await JSZip.loadAsync(data.bytes);
    const entries = Object.values(archive.files)
      .filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".txt"))
      .sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
    if (!entries.length) throw new Error("압축 파일 안에 TXT 문서가 없습니다.");
    const chapters: string[] = [];
    for (const entry of entries) {
      const bytes = await entry.async("uint8array");
      chapters.push(entries.length > 1 ? `\n\n${entry.name}\n\n${decode(bytes)}` : decode(bytes));
    }
    self.postMessage({ text: chapters.join("\n") });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
