import { paginateStarts, type PaginationInput } from "../lib/pagination";

self.onmessage = ({ data }: MessageEvent<PaginationInput>) => {
  void paginateStarts(data, () => false, () => false).then((result) => {
    if (!result) return;
    self.postMessage(result, [result.buffer]);
  });
};
