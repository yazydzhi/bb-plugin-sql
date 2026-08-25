/** BB shims `sonner` at runtime; types are not shipped with the plugin SDK. */
declare module "sonner" {
  export const toast: {
    success(message: string): void;
    error(message: string): void;
    info(message: string): void;
    warning(message: string): void;
  };
}
