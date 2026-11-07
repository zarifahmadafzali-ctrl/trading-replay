declare module "hyparquet" {
  export type AsyncBuffer = {
    byteLength: number;
    slice: (start: number, end?: number) => ArrayBuffer | Promise<ArrayBuffer>;
  };

  export function parquetReadObjects(options: {
    file: AsyncBuffer;
    columns?: string[];
    rowStart?: number;
    rowEnd?: number;
  }): Promise<Record<string, unknown>[]>;

  export function parquetMetadataAsync(file: AsyncBuffer): Promise<unknown>;
}
