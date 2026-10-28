/**
 * HTTP and SSE Transport Implementation for MCP Server
 * Wires the MCP SDK server to real request handling via StreamableHTTPServerTransport
 *
 * IMPORTANT: Each session gets its OWN Server instance, created via the
 * `createServer` factory passed in. The MCP SDK's Server can only ever be
 * connected to one transport for its lifetime — sharing a single Server
 * across sessions causes "Already connected to a transport" errors on the
 * second and every subsequent session.
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { requestContext } from '../request-context.js';

type ServerFactory = () => Server;

export async function createHttpServer(createServer: ServerFactory, port: number): Promise<void> {
  const app = express();

  app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Mcp-Session-Id']
  }));

  app.use(express.json({ limit: '10mb' }));

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      service: 'ninjaone-mcp-server',
      version: '1.2.0',
      timestamp: new Date().toISOString(),
      transport: 'http'
    });
  });

  app.get('/info', (req: Request, res: Response) => {
    res.json({
      name: 'ninjaone-mcp-server',
      version: '1.2.0',
      description: 'NinjaONE RMM MCP Server with HTTP transport',
      capabilities: { tools: true, resources: false, prompts: false, logging: true },
      transports: ['stdio', 'http', 'sse']
    });
  });

    app.post('/mcp', async (req: Request, res: Response) => {
    try {
      // Extract the bearer token Claude.ai sends for the signed-in user (Authorization: Bearer <token>)
      const authHeader = req.headers['authorization'] as string | undefined;
      const incomingToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      console.error('DEBUG - Authorization header present:', !!authHeader, '| Incoming token (first 20 chars):', incomingToken?.slice(0, 20) || 'NONE');
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else {
        const mcpServer = createServer();

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          }
        });

        transport.onclose = () => {
          if (transport.sessionId) delete transports[transport.sessionId];
        };

        await mcpServer.connect(transport as any);
      }

      await requestContext.run({ token: incomingToken }, async () => {
        await transport.handleRequest(req, res, req.body);
      });
    } catch (error) {
      console.error('MCP POST error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
          id: null
        });
      }
    }
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
    delete transports[sessionId];
  });

  app.get('/tools', async (req: Request, res: Response) => {
    try {
      res.json({
        tools: [
          { name: 'get_devices', description: 'List all devices' },
          { name: 'get_device', description: 'Get specific device' },
          { name: 'reboot_device', description: 'Reboot a device' },
          { name: 'query_antivirus_status', description: 'Query antivirus status' },
          { name: 'query_device_health', description: 'Query device health' },
          { name: 'get_organizations', description: 'List organizations' },
          { name: 'get_alerts', description: 'Get system alerts' }
        ]
      });
    } catch (error) {
      console.error('Tools endpoint error:', error);
      res.status(500).json({ error: 'Failed to retrieve tools', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.use((error: any, req: Request, res: Response, next: any) => {
    console.error('Express error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message || 'Unknown error occurred' });
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not found',
      message: `Route ${req.method} ${req.path} not found`,
      availableEndpoints: ['GET /health', 'GET /info', 'GET /tools', 'POST /mcp', 'GET /mcp', 'DELETE /mcp']
    });
  });

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.error(`HTTP server listening on port ${port}`);
      resolve();
    });
    server.on('error', (error) => {
      console.error('HTTP server error:', error);
      reject(error);
    });
  });
}

export async function createSseServer(createServer: ServerFactory, port: number): Promise<void> {
  const app = express();

  app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cache-Control']
  }));

  app.use(express.json({ limit: '10mb' }));

  const transports: Record<string, SSEServerTransport> = {};

  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      service: 'ninjaone-mcp-server',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      transport: 'sse'
    });
  });

  app.get('/events', async (req: Request, res: Response) => {
    const mcpServer = createServer();

    const transport = new SSEServerTransport('/message', res);
    transports[transport.sessionId] = transport;

    res.on('close', () => {
      delete transports[transport.sessionId];
    });

    await mcpServer.connect(transport);
  });

  app.post('/message', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];
    if (!transport) {
      res.status(400).send('No transport found for sessionId');
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.error(`SSE server listening on port ${port}`);
      resolve();
    });
    server.on('error', (error) => {
      console.error('SSE server error:', error);
      reject(error);
    });
  });
}