// Kernel failures carry an HTTP-ish status so the service boundary can map
// them to HttpError without the kernel importing anything from the Worker.
export class KernelError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
