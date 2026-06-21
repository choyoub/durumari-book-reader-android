declare module "epubjs" {
  export interface Locations {
    length(): number;
    generate(chars?: number): Promise<string[]>;
    locationFromCfi(cfi: string): number;
    cfiFromPercentage(percentage: number): string;
  }
  export interface Book {
    ready: Promise<unknown>;
    locations: Locations;
    spine: { length: number };
    renderTo(element: HTMLElement, options?: Record<string, unknown>): Rendition;
    destroy(): void;
  }
  export interface Rendition {
    display(target?: string): Promise<unknown>;
    next(): Promise<unknown>;
    prev(): Promise<unknown>;
    destroy(): void;
    currentLocation(): unknown;
    on(event: string, callback: (...args: any[]) => void): void;
    themes: {
      default(rules: Record<string, Record<string, string>>): void;
      register(name: string, url: string): void;
      select(name: string): void;
    };
  }
  export default function ePub(input: ArrayBuffer | string): Book;
}
