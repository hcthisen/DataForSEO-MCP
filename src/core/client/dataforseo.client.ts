import { defaultGlobalToolConfig } from '../config/global.tool.js';

export class DataForSEOClient {
  private config: DataForSEOConfig;
  private authHeader: string;

  constructor(config: DataForSEOConfig) {
    this.config = config;
    if(defaultGlobalToolConfig.debug) {
      console.error('DataForSEOClient initialized with config:', config);
    }
    const token = btoa(`${config.username}:${config.password}`);
    this.authHeader = `Basic ${token}`;
  }

  async makeRequest<T>(endpoint: string, method: string = 'POST', body?: any, forceFull: boolean = false): Promise<T> {
    let url = `${this.config.baseUrl || "https://api.dataforseo.com"}${endpoint}`;    
    if(!defaultGlobalToolConfig.fullResponse && !forceFull){
      url += '.ai';
    }
    // Import version dynamically to avoid circular dependencies
    const { version } = await import('../utils/version.js');
    
    const headers = {
      'Authorization': this.authHeader,
      'Content-Type': 'application/json',
      'User-Agent': `DataForSEO-MCP-TypeScript-SDK/${version}`
    };

    if (defaultGlobalToolConfig.debug) {
      console.error(`Making request to ${url} with method ${method} and body`, body);
    }
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        try {
          errorBody = await response.text();
        } catch {
          errorBody = undefined;
        }
      }

      if (response.status === 401) {
        const details = extractErrorDetails(errorBody);
        throw new Error(
          [
            "DataForSEO authentication failed (HTTP 401).",
            "Verify that DATAFORSEO_USERNAME and DATAFORSEO_PASSWORD match your DataForSEO account login credentials.",
            details ? `Response details: ${details}` : undefined,
          ]
            .filter(Boolean)
            .join(" ")
        );
      }

      const details = extractErrorDetails(errorBody) || response.statusText;
      throw new Error(`HTTP error! status: ${response.status}${details ? ` - ${details}` : ""}`);
    }

    return response.json();
  }
}

function extractErrorDetails(errorBody: unknown): string | undefined {
  if (!errorBody) {
    return undefined;
  }

  if (typeof errorBody === "string") {
    return errorBody;
  }

  if (typeof errorBody === "object") {
    const maybeMessage =
      // DataForSEO full responses
      (errorBody as { status_message?: string }).status_message ||
      // DataForSEO short responses / error payloads
      (errorBody as { message?: string }).message;

    if (maybeMessage) {
      return maybeMessage;
    }

    try {
      return JSON.stringify(errorBody);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export interface DataForSEOConfig {
  username: string;
  password: string;
  baseUrl?: string;
}