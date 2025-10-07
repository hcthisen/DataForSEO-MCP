import { Request, Response, NextFunction } from "express";

export function loadAllowedApiKeys(envVar: string = "MCP_API_KEYS"): Set<string> {
  const rawKeys = process.env[envVar];

  if (!rawKeys) {
    throw new Error(`${envVar} environment variable must be set with at least one API key`);
  }

  const keys = rawKeys
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  if (keys.length === 0) {
    throw new Error(`${envVar} environment variable must contain at least one non-empty API key`);
  }

  return new Set(keys);
}

export function createApiKeyAuthMiddleware(allowedApiKeys: Set<string>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    let token: string | undefined;

    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.substring("Bearer ".length).trim();
    }

    if (!token) {
      const apiKeyHeader = req.header("x-api-key");
      if (apiKeyHeader) {
        token = apiKeyHeader.trim();
      }
    }

    if (!token || !allowedApiKeys.has(token)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized",
        },
        id: null,
      });
      return;
    }

    next();
  };
}
