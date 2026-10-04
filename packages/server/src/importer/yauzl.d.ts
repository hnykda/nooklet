// The slice of yauzl 2.10 (MIT, https://github.com/thejoshwolfe/yauzl) that `./zip.ts` uses.
// Declared here rather than adding `@types/yauzl` for five members.
declare module "yauzl" {
  import type { EventEmitter } from "node:events";

  export interface Entry {
    /** A Buffer with `decodeStrings: false`, which `./zip.ts` uses. */
    fileName: string | Buffer;
    compressedSize: number;
    uncompressedSize: number;
    externalFileAttributes: number;
    generalPurposeBitFlag: number;
    compressionMethod: number;
    relativeOffsetOfLocalHeader: number;
    isEncrypted(): boolean;
  }

  export interface ZipFile extends EventEmitter {
    entryCount: number;
    readEntry(): void;
    close(): void;
  }

  export interface Options {
    lazyEntries?: boolean;
    autoClose?: boolean;
    decodeStrings?: boolean;
    validateEntrySizes?: boolean;
    strictFileNames?: boolean;
  }

  const yauzl: {
    open(
      path: string,
      options: Options,
      callback: (err: Error | null, zipfile?: ZipFile) => void,
    ): void;
  };
  export default yauzl;
}
