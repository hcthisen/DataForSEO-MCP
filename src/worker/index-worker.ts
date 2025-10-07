import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { DataForSEOClient, DataForSEOConfig } from '../core/client/dataforseo.client.js';
import { EnabledModulesSchema } from '../core/config/modules.config.js';
import { BaseModule, ToolDefinition } from '../core/modules/base.module.js';
import { ModuleLoaderService } from '../core/utils/module-loader.js';
import { version, name } from './version.worker.js';

/**
 * DataForSEO MCP Server for Cloudflare Workers
 * 
 * This server provides MCP (Model Context Protocol) access to DataForSEO APIs
 * through a Cloudflare Worker runtime using the agents/mcp pattern.
 */

// Server metadata
const SERVER_NAME = `${name} (Worker)`;
const SERVER_VERSION = version;
globalThis.__PACKAGE_VERSION__ = version;
globalThis.__PACKAGE_NAME__ = name;

const PROTECTED_PATHS = new Set(["/mcp", "/http", "/sse", "/messages", "/sse/message"]);
/**
 * DataForSEO MCP Agent for Cloudflare Workers
 */
export class DataForSEOMcpAgent extends McpAgent {
  server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  constructor(ctx: DurableObjectState, protected env: Env){
    super(ctx, env);
  }

  async init() {
    const workerEnv = this.env || (globalThis as any).workerEnv;
    if (!workerEnv) {
      throw new Error(`Worker environment not available`);
    }

    // Initialize DataForSEO client
    const username = workerEnv.DATAFORSEO_USERNAME?.trim();
    const password = workerEnv.DATAFORSEO_PASSWORD?.trim();

    if (!username || !password) {
      throw new Error('Missing DataForSEO credentials in worker environment. Set DATAFORSEO_USERNAME and DATAFORSEO_PASSWORD.');
    }

    const dataForSEOConfig: DataForSEOConfig = {
      username,
      password,
    };
    
    const dataForSEOClient = new DataForSEOClient(dataForSEOConfig);
    
    // Parse enabled modules from environment
    const enabledModules = EnabledModulesSchema.parse(workerEnv.ENABLED_MODULES);
    
    // Initialize and load modules
    const modules: BaseModule[] = ModuleLoaderService.loadModules(dataForSEOClient, enabledModules);
    
    // Register tools from all modules
    modules.forEach(module => {
      const tools = module.getTools();
      Object.entries(tools).forEach(([name, tool]) => {
        const typedTool = tool as ToolDefinition;
        const schema = z.object(typedTool.params);
        this.server.tool(
          name,
          schema.shape,
          typedTool.handler
        );
      });
    });
  }
}

/**
 * Creates a JSON-RPC error response
 */
function createErrorResponse(code: number, message: string): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null
  }), {
    status: code === -32001 ? 401 : 400,
    headers: { 'Content-Type': 'application/json' }
  });
}

function loadAllowedApiKeys(env: Env, envVar = "MCP_API_KEYS"): Set<string> | null {
  const rawKeys = (env as Record<string, string | undefined>)[envVar];

  if (!rawKeys || typeof rawKeys !== "string") {
    return null;
  }

  const keys = rawKeys
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  if (keys.length === 0) {
    return null;
  }

  return new Set(keys);
}

function extractClientToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring("Bearer ".length).trim();
    if (token) {
      return token;
    }
  }

  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader?.trim()) {
    return apiKeyHeader.trim();
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Store environment in global context for McpAgent access
    (globalThis as any).workerEnv = env;

    // Health check endpoint
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'healthy',
        server: SERVER_NAME,
        version: SERVER_VERSION,
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // Check if credentials are configured
    if (!env.DATAFORSEO_USERNAME?.trim() || !env.DATAFORSEO_PASSWORD?.trim()) {
      if (PROTECTED_PATHS.has(url.pathname)) {
        return createErrorResponse(-32001, "DataForSEO credentials not configured in worker environment variables");
      }
    }

    if (PROTECTED_PATHS.has(url.pathname)) {
      const allowedApiKeys = loadAllowedApiKeys(env);

      if (!allowedApiKeys) {
        return createErrorResponse(-32001, "MCP API keys not configured in worker environment variables");
      }

      const token = extractClientToken(request);

      if (!token || !allowedApiKeys.has(token)) {
        return createErrorResponse(-32001, "Unauthorized");
      }
    }
    // MCP endpoints using McpAgent pattern
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return DataForSEOMcpAgent.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp" || url.pathname == '/http') {
      return DataForSEOMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};