declare module "qrcode-terminal" {
  const qrcode: {
    generate(text: string, opts?: { small?: boolean }, cb?: (qr: string) => void): void;
    setErrorLevel(level: "L" | "M" | "Q" | "H"): void;
  };
  export default qrcode;
}
