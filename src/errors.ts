export class KpeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'KpeError';
    this.code = code;
  }
}

export function toKpeError(error: unknown, fallbackCode = 'INTERNAL'): KpeError {
  if (error instanceof KpeError) return error;
  return new KpeError(fallbackCode, '内部错误，未返回详情');
}
