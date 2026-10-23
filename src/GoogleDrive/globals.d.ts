// The Paperback runtime (JavaScriptCore) provides a console with these methods.
declare const console: {
  log(...msg: unknown[]): void;
  warn(...msg: unknown[]): void;
  error(...msg: unknown[]): void;
};
