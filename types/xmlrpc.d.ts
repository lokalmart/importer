declare module 'xmlrpc' {
  export function createClient(options: { url: string; cookies?: boolean; headers?: Record<string, string> }): {
    methodCall(method: string, params: unknown[], callback: (error: Error | null, value: unknown) => void): void;
  };
  export function createSecureClient(options: { url: string; cookies?: boolean; headers?: Record<string, string> }): {
    methodCall(method: string, params: unknown[], callback: (error: Error | null, value: unknown) => void): void;
  };
}
