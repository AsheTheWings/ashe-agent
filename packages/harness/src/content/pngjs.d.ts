declare module "pngjs" {
  export const PNG: {
    readonly sync: {
      readonly write: (image: { readonly width: number; readonly height: number; readonly data: Uint8Array }) => Buffer
    }
  }
}
