#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { promisify } from "util";
import { exec } from "child_process";
import * as os from "node:os";

const execAsync = promisify(exec);

const SERVER_NAME = "auggie-mcp";
const SERVER_VERSION = "0.1.0";

// Default timeouts in seconds
const DEFAULT_QUERY_TIMEOUT = 240;

interface QueryCodebaseArgs {
  query: string;
  workspace_root?: string;
}

interface ServerConfig {
  model: string; // e.g., "haiku4.5"
  rules_path?: string;
  timeout_sec: number; // local timeout in seconds
  output_format: "text" | "json";
}

function resolveServerConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  const envModel = process.env.AUGGIE_MODEL || process.env.AUGMENT_MODEL;
  const envOutput = (process.env.AUGGIE_OUTPUT_FORMAT || process.env.AUGMENT_OUTPUT_FORMAT) as
    | "text"
    | "json"
    | undefined;
  const envTimeout = process.env.AUGGIE_TIMEOUT_SEC || process.env.AUGMENT_TIMEOUT_SEC;
  const envRules = process.env.AUGGIE_RULES_PATH || process.env.AUGMENT_RULES_PATH;

  const cfg: ServerConfig = {
    model: overrides?.model || envModel || "haiku4.5",
    output_format: overrides?.output_format || envOutput || "text",
    timeout_sec:
      overrides?.timeout_sec ??
      (envTimeout ? parseInt(envTimeout, 10) : undefined) ??
      DEFAULT_QUERY_TIMEOUT,
    rules_path: overrides?.rules_path || envRules || undefined,
  };

  // sanitize
  if (cfg.output_format !== "json") cfg.output_format = "text";
  if (!Number.isFinite(cfg.timeout_sec) || cfg.timeout_sec! <= 0) {
    cfg.timeout_sec = DEFAULT_QUERY_TIMEOUT;
  }

  return cfg;
}

interface QueryResult {
  answer: string;
  usage: {
    duration_ms: number;
  };
}

/**
 * Preflight check to ensure Auggie CLI is available
 */
async function checkAuggieCLI(): Promise<void> {
  try {
    const { stdout } = await execAsync("auggie --version");
    if (!stdout.trim()) {
      throw new Error("Auggie CLI returned empty version");
    }
  } catch (error) {
    throw new Error(
      `Auggie CLI not found. Please install it first: https://docs.augmentcode.com/cli/overview\n` +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}



/**
 * Run Auggie CLI command and stream output
 */
async function runAuggieQuery(args: QueryCodebaseArgs, cfg: ServerConfig): Promise<QueryResult> {
  const startTime = Date.now();

  let cmd = os.platform() === "win32" ? "cmd" : "auggie";

  // Build command arguments
  const cmdArgs = os.platform() === "win32" ? ["/c", "auggie"] : [];

  // Use --print for non-interactive mode
  cmdArgs.push("--print");

  // Add quiet mode to only get final output
  cmdArgs.push("--quiet");

  // Add workspace root if provided
  if (args.workspace_root) {
    cmdArgs.push("--workspace-root", args.workspace_root);
  }

  // Add model from server config
  if (cfg.model) {
    cmdArgs.push("--model", cfg.model);
  }

  // Add rules path from server config if provided
  if (cfg.rules_path) {
    cmdArgs.push("--rules", cfg.rules_path);
  }

  // Add output format if JSON requested by server config
  if (cfg.output_format === "json") {
    cmdArgs.push("--output-format", "json");
  }

  // Add the query as the instruction
  cmdArgs.push(`call codebase-retrieval with "${args.query}". ` +
    `Return the relevant output and nothing more; everything you write will be ` +
    `piped to a different CLI tool, so dont write anything other than the output`);

  return new Promise((resolve, reject) => {
    const timeout = (cfg.timeout_sec || DEFAULT_QUERY_TIMEOUT) * 1000;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(cmd, cmdArgs, {
      env: process.env,
      cwd: args.workspace_root || process.cwd(),
    });

    // Set timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      reject(new Error(`Query timed out after ${cfg.timeout_sec || DEFAULT_QUERY_TIMEOUT} seconds`));
    }, timeout);

    // Collect stdout
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    // Collect stderr
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Handle process exit
    child.on("close", (code) => {
      clearTimeout(timeoutId);

      if (timedOut) {
        return; // Already rejected
      }

      if (code !== 0) {
        const stderrText = stderr.trim();
        const stdoutText = stdout.trim();

        // Check for authentication errors
        if (stderrText.includes("not logged in") ||
            stderrText.includes("authentication") ||
            stderrText.includes("unauthorized")) {
          reject(new Error(
            `Authentication required. Please either:\n` +
            `1. Run 'auggie login' to authenticate, or\n` +
            `2. Set AUGMENT_SESSION_AUTH environment variable (get token via 'auggie token print')\n\n` +
            `Error details: ${stderrText || stdoutText || "<no details>"}`
          ));
          return;
        }

        reject(new Error(
          `Auggie CLI failed with exit code ${code}\n` +
          `STDERR: ${stderrText || "<empty>"}\n` +
          `STDOUT: ${stdoutText || "<empty>"}`
        ));
        return;
      }

      const duration = Date.now() - startTime;

      resolve({
        answer: stdout.trim(),
        usage: {
          duration_ms: duration,
        },
      });
    });

    // Handle errors
    child.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to spawn Auggie CLI: ${error.message}`));
    });
  });
}

/**
 * Create and configure the MCP server
 */
function createServer(configOverrides?: Partial<ServerConfig>): Server {
  const config = resolveServerConfig(configOverrides);
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Define available tools
  const tools: Tool[] = [
    {
      name: "query_codebase",
      description: 
        "Query a codebase using the context engine. " +
        "This tool provides intelligent answers about code structure, functionality, " +
        "and implementation details by leveraging advanced context retrieval.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A description of the information you need.",
          },
          workspace_root: {
            type: "string",
            description: "Absolute path to the workspace/repository root. Defaults to current directory.",
          },
        },
        required: ["query"],
      },
    },
  ];

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "query_codebase") {
      try {
        // Validate and cast arguments
        if (!args || typeof args !== "object") {
          throw new Error("Invalid arguments");
        }

        const queryArgs = args as unknown as QueryCodebaseArgs;

        if (!queryArgs.query) {
          throw new Error("'query' argument is required and must be a string");
        }

        // Run the query
        const result = await runAuggieQuery(queryArgs, config);

        return {
          content: [
            {
              type: "text",
              text: result.answer,
            },
          ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Perform preflight checks
    console.error("[auggie-mcp] Checking Auggie CLI availability...");
    await checkAuggieCLI();

    // Note: Authentication token is optional - Auggie CLI will handle auth
    if (process.env.AUGMENT_SESSION_AUTH) {
      console.error("[auggie-mcp] Using AUGMENT_SESSION_AUTH from environment");
    } else {
      console.error("[auggie-mcp] No AUGMENT_SESSION_AUTH set - relying on Auggie CLI login");
    }

    console.error("[auggie-mcp] Starting MCP server...");

    // Create and start server
    const server = createServer();
    const transport = new StdioServerTransport();

    await server.connect(transport);

    console.error("[auggie-mcp] Server started successfully");
  } catch (error) {
    console.error(
      `[auggie-mcp] Failed to start server: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}

void main();
