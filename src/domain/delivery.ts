export class DeliveryError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface DeliveryView {
  allowed: boolean;
  file: { id: string; name: string; size: number } | null;
  document: {
    id: string;
    status: "PENDING" | "READY" | "FAILED";
    name: string | null;
  } | null;
}
export interface FreeDownloadView {
  productId: string;
  title: string;
  authors: string[];
  revision: number;
  termsId: string;
  terms: string;
  accepted: boolean;
}
