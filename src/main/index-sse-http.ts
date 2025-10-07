import express, { Request, Response } from 'express';
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from 'zod';
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { DataForSEOClient, DataForSEOConfig } from '../core/client/dataforseo.client.js';
import { EnabledModulesSchema, isModuleEnabled } from '../core/config/modules.config.js';
import { BaseModule, ToolDefinition } from '../core/modules/base.module.js';
import { name, version } from '../core/utils/version.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { ModuleLoaderService } from '../core/utils/module-loader.js';
import { initializeFieldConfiguration } from '../core/config/field-configuration.js';
import { initMcpServer } from './init-mcp-server.js';
import { createApiKeyAuthMiddleware, loadAllowedApiKeys } from './auth.js';

// Initialize field configuration if provided
initializeFieldConfiguration();
console.error('Starting DataForSEO MCP Server...');
console.error(`Server name: ${name}, version: ${version}`);

/**
 * This example server demonstrates backwards compatibility with both:
 * 1. The deprecated HTTP+SSE transport (protocol version 2024-11-05)
 * 2. The Streamable HTTP transport (protocol version 2025-03-26)
 * 
 * It maintains a single MCP server instance but exposes two transport options:
 * - /mcp: The new Streamable HTTP endpoint (supports GET/POST/DELETE)
 * - /sse: The deprecated SSE endpoint for older clients (GET to establish stream)
 * - /messages: The deprecated POST endpoint for older clients (POST to send messages)
 */

// Configuration constants
const CONNECTION_TIMEOUT = 30000; // 30 seconds
const CLEANUP_INTERVAL = 60000; // 1 minute

// Transport interface with timestamp
interface TransportWithTimestamp {
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  lastActivity: number;
}

// Store transports by session ID
const transports: Record<string, TransportWithTimestamp> = {};

// Cleanup function for stale connections
function cleanupStaleConnections() {
  const now = Date.now();
  Object.entries(transports).forEach(([sessionId, { transport, lastActivity }]) => {
    if (now - lastActivity > CONNECTION_TIMEOUT) {
      console.log(`Cleaning up stale connection for session ${sessionId}`);
      try {
        transport.close();
      } catch (error) {
        console.error(`Error closing transport for session ${sessionId}:`, error);
      }
      delete transports[sessionId];
    }
  });
}

// Start periodic cleanup
const cleanupInterval = setInterval(cleanupStaleConnections, CLEANUP_INTERVAL);



// Create Express application
const app = express();
app.use(express.json());

const allowedApiKeys = loadAllowedApiKeys();
const authenticate = createApiKeyAuthMiddleware(allowedApiKeys);

//=============================================================================
// STREAMABLE HTTP TRANSPORT (PROTOCOL VERSION 2025-03-26)
//=============================================================================

const handleMcpRequest = async (req: Request, res: Response) => {
    // In stateless mode, create a new instance of transport and server for each request
    // to ensure complete isolation. A single instance would cause request ID collisions
    // when multiple clients connect concurrently.
    
    try {
      console.error(Date.now().toLocaleString())
      
      const server = initMcpServer();
      console.error(Date.now().toLocaleString())

      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });

      await server.connect(transport);
      console.error('handle request');
      await transport.handleRequest(req , res, req.body);
      console.error('end handle request');
      req.on('close', () => {
        console.error('Request closed');
        transport.close();
        server.close();
      });

    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  };

const handleNotAllowed = (method: string) => async (req: Request, res: Response) => {
    console.error(`Received ${method} request`);
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    });
  };

// Apply API key auth and shared handler to both endpoints
app.post('/http', authenticate, handleMcpRequest);
app.post('/mcp', authenticate, handleMcpRequest);

app.get('/http', handleNotAllowed('GET HTTP'));
app.get('/mcp', handleNotAllowed('GET MCP'));

app.delete('/http', handleNotAllowed('DELETE HTTP'));
app.delete('/mcp', handleNotAllowed('DELETE MCP'));

//=============================================================================
// DEPRECATED HTTP+SSE TRANSPORT (PROTOCOL VERSION 2024-11-05)
//=============================================================================

app.get('/sse', authenticate, async (req: Request, res: Response) => {
  console.log('Received GET request to /sse (deprecated SSE transport)');

  const transport = new SSEServerTransport('/messages', res);
  
  // Store transport with timestamp
  transports[transport.sessionId] = {
    transport,
    lastActivity: Date.now()
  };

  // Handle connection cleanup
  const cleanup = () => {
    try {
      transport.close();
    } catch (error) {
      console.error(`Error closing transport for session ${transport.sessionId}:`, error);
    }
    delete transports[transport.sessionId];
  };

  res.on("error", cleanup);
  req.on("error", cleanup);
  req.socket.on("error", cleanup);
  req.socket.on("timeout", cleanup);

  // Set socket timeout
  req.socket.setTimeout(CONNECTION_TIMEOUT);

  const server = initMcpServer();
  await server.connect(transport);
});

app.post("/messages", authenticate, async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;

  const transportData = transports[sessionId];
  if (!transportData) {
    res.status(400).send('No transport found for sessionId');
    return;
  }

  if (!(transportData.transport instanceof SSEServerTransport)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: Session exists but uses a different transport protocol',
      },
      id: null,
    });
    return;
  }

  // Update last activity timestamp
  transportData.lastActivity = Date.now();
  
  await transportData.transport.handlePostMessage(req, res, req.body);
});

// Start the server
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const server = app.listen(PORT, () => {
  console.log(`DataForSEO MCP Server with SSE compatibility listening on port ${PORT}`);
  console.log(`
==============================================
SUPPORTED TRANSPORT OPTIONS:

1. Streamable Http (Protocol version: 2025-03-26)
   Endpoint: /http (POST)
   Endpoint: /mcp (POST)


2. Http + SSE (Protocol version: 2024-11-05)
   Endpoints: /sse (GET) and /messages (POST)
   Usage:
     - Establish SSE stream with GET to /sse
     - Send requests with POST to /messages?sessionId=<id>
==============================================
`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  
  // Clear cleanup interval
  clearInterval(cleanupInterval);

  // Close HTTP server
  server.close();

  // Close all active transports
  for (const sessionId in transports) {
    try {
      console.log(`Closing transport for session ${sessionId}`);
      await transports[sessionId].transport.close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }
  console.log('Server shutdown complete');
  process.exit(0);
});