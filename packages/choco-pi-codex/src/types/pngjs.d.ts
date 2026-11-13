declare module "pngjs" {
  export class PNG {
    static sync: {
      read(data: Buffer): {
        width: number;
        height: number;
        data: Buffer;
      };
    };
  }
}
