// Declaration file for Deno runtime APIs
// Harmless deploy-scope touch: workerDependencyMatchers redeploys api, files, plugin, and translation workers on release.
// This is a simplified version, add more types as needed

declare namespace Deno {
  export interface ReadFileOptions {
    encoding?: string;
  }

  export interface WriteFileOptions {
    append?: boolean;
    create?: boolean;
    mode?: number;
  }

  export function readTextFile(path: string | URL, options?: ReadFileOptions): Promise<string>;
  export function writeTextFile(path: string | URL, data: string, options?: WriteFileOptions): Promise<void>;
  export function readFile(path: string | URL): Promise<Uint8Array>;
  export function writeFile(path: string | URL, data: Uint8Array): Promise<void>;
  
  export interface Env {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    toObject(): Record<string, string>;
  }
  
  export const env: Env;

  export interface ConnInfo {
    readonly localAddr: Deno.Addr;
    readonly remoteAddr: Deno.Addr;
  }

  export interface Addr {
    readonly hostname: string;
    readonly port: number;
    readonly transport: "tcp" | "udp";
  }

  // Server types
  export type ServeHandler = (request: Request, connInfo: ConnInfo) => Response | Promise<Response>;
  
  export interface ServeOptions {
    port?: number;
    hostname?: string;
    handler?: ServeHandler;
    signal?: AbortSignal;
    onListen?: (params: { hostname: string; port: number }) => void;
    onError?: (error: unknown) => Response | Promise<Response>;
    cert?: string;
    key?: string;
  }
  
  export interface ServeInit extends ServeOptions {
    handler: ServeHandler;
  }
  
  export interface Server {
    closed: Promise<void>;
    shutdown(): Promise<void>;
  }
  
  export function serve(handler: ServeHandler, options?: ServeOptions): Server;
  export function serve(options: ServeInit): Server;

  // Add more Deno APIs as needed
}

// Make Deno available as a global
declare const Deno: typeof Deno;
