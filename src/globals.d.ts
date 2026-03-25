declare global {
  interface Error {
    code?: string | number;
    stdout?: string;
    stderr?: string;
    payload?: any;
    raw?: string;
    statusCode?: number;
  }
}

export {};
