declare module "node-hid" {
  export interface Device {
    path?: string;
    vendorId: number;
    productId: number;
    usagePage?: number;
    usage?: number;
  }

  export class HID {
    constructor(path: string);
    static devices(): Device[];
    sendFeatureReport(data: number[]): number;
    close(): void;
  }
}
