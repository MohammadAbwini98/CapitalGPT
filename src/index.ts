import "dotenv/config"; // Load .env into process.env
import { z } from "zod"; // Import Zod for env validation
//import Lightstreamer from "lightstreamer-client"; // Import Lightstreamer namespace (compat)
//const { LightstreamerClient, Subscription } = Lightstreamer as any; // Extract exports safely
import Lightstreamer from "lightstreamer-client"; // Import Lightstreamer namespace
const { LightstreamerClient, Subscription } = Lightstreamer as any; // Extract exports safely

// Import Lightstreamer client types

const envSchema = z.object({ // Define env schema
  CAPITAL_REST_BASE_URL: z.string().url(), // REST base URL
  CAPITAL_STREAM_URL: z.string().url(), // Stream URL
  CAPITAL_API_KEY: z.string().min(1), // API key
  CAPITAL_IDENTIFIER: z.string().min(1), // Identifier
  CAPITAL_PASSWORD: z.string().min(1), // Password
  CAPITAL_ACCOUNT_TYPE: z.enum(["demo", "live"]).default("demo"), // Account type
  CAPITAL_INSTRUMENTS: z.string().min(1), // Instruments list
  CAPITAL_STREAM_MODE: z.enum(["MERGE", "DISTINCT", "RAW"]).default("MERGE"), // LS mode
  CAPITAL_PRINT_JSON: z.string().optional(), // Print JSON toggle
  CAPITAL_MARKET_STATUS_POLL_MS: z.string().optional(), // Poll ms
  CAPITAL_RECONNECT_MIN_MS: z.string().optional(), // Reconnect min
  CAPITAL_RECONNECT_MAX_MS: z.string().optional() // Reconnect max
}); // End schema

const parsed = envSchema.safeParse(process.env); // Parse env
if (!parsed.success) { // If invalid env
  console.error("Invalid .env:", parsed.error.flatten().fieldErrors); // Print errors
  process.exit(1); // Exit
} // End invalid env handling

const config = { // Build config
  restBaseUrl: parsed.data.CAPITAL_REST_BASE_URL, // REST URL
  streamUrl: parsed.data.CAPITAL_STREAM_URL, // Stream URL
  apiKey: parsed.data.CAPITAL_API_KEY, // API key
  identifier: parsed.data.CAPITAL_IDENTIFIER, // Identifier
  password: parsed.data.CAPITAL_PASSWORD, // Password
  accountType: parsed.data.CAPITAL_ACCOUNT_TYPE, // Account type
  instruments: parsed.data.CAPITAL_INSTRUMENTS.split(",").map((s) => s.trim()).filter(Boolean), // Instruments array
  streamMode: parsed.data.CAPITAL_STREAM_MODE, // Stream mode
  printJson: (parsed.data.CAPITAL_PRINT_JSON ?? "true").toLowerCase() === "true", // Print JSON
  marketStatusPollMs: Number(parsed.data.CAPITAL_MARKET_STATUS_POLL_MS ?? "15000"), // Poll interval
  reconnectMinMs: Number(parsed.data.CAPITAL_RECONNECT_MIN_MS ?? "500"), // Reconnect min
  reconnectMaxMs: Number(parsed.data.CAPITAL_RECONNECT_MAX_MS ?? "10000") // Reconnect max
} as const; // Freeze-ish

type CapitalSession = { cst: string; securityToken: string }; // Session token type
type MarketStatus = "OPEN" | "CLOSED" | "SUSPENDED" | "UNKNOWN"; // Market status enum
type Tick = { // Tick type
  instrument: string; // Instrument
  ts: string; // Timestamp
  bid?: number; // Bid
  ask?: number; // Ask
  last?: number; // Last
  high?: number; // High
  low?: number; // Low
  volume?: number; // Volume
  liquidity?: number; // Liquidity
  raw: Record<string, string>; // Raw stream fields
}; // End Tick

function withTimeout(ms: number) { // Create abort timeout helper
  const controller = new AbortController(); // Create controller
  const id = setTimeout(() => controller.abort(), ms); // Abort after ms
  return { controller, cancel: () => clearTimeout(id) }; // Return
} // End helper

function sleep(ms: number) { // Sleep helper
  return new Promise((r) => setTimeout(r, ms)); // Resolve after ms
} // End helper

function toNum(v: string | undefined) { // Parse numeric helper
  if (v == null || v === "") return undefined; // Handle missing/empty
  const n = Number(v); // Convert
  return Number.isFinite(n) ? n : undefined; // Validate
} // End helper

function jitteredBackoff(attempt: number) { // Compute backoff delay
  const min = config.reconnectMinMs; // Min
  const max = config.reconnectMaxMs; // Max
  const base = Math.min(max, min * Math.pow(2, attempt)); // Exponential
  const jitter = Math.floor(Math.random() * Math.min(250, base)); // Jitter
  return Math.min(max, base + jitter); // Return delay
} // End helper

async function createSession(): Promise<CapitalSession> { // Create REST session
  const url = new URL("/api/v1/session", config.restBaseUrl).toString(); // Build URL (verify per Capital docs)
  const { controller, cancel } = withTimeout(10_000); // Timeout
  try { // Try block
    const res = await fetch(url, { // Fetch session
      method: "POST", // POST
      headers: { // Headers
        "Content-Type": "application/json", // JSON
        "X-CAP-API-KEY": config.apiKey // API key header (verify exact header name in docs)
      }, // End headers
      body: JSON.stringify({ identifier: config.identifier, password: config.password }), // Credentials payload
      signal: controller.signal // Abort signal
    }); // End fetch
    if (!res.ok) { // If not OK
      const text = await res.text().catch(() => ""); // Read response
      throw new Error(`Session failed: HTTP ${res.status} ${res.statusText} ${text}`); // Throw
    } // End not OK
    const cst = res.headers.get("CST"); // Read CST token
    const securityToken = res.headers.get("X-SECURITY-TOKEN"); // Read security token
    if (!cst || !securityToken) { // Validate tokens
      throw new Error("Missing CST / X-SECURITY-TOKEN headers (check host/docs)."); // Throw
    } // End validate
    return { cst, securityToken }; // Return tokens
  } catch (err) { // Catch errors
    const msg = err instanceof Error ? err.message : String(err); // Normalize
    throw new Error(`createSession error: ${msg}`); // Wrap
  } finally { // Finally
    cancel(); // Clear timeout
  } // End try/catch/finally
} // End createSession

function authHeaders(session: CapitalSession) { // Build auth headers
  return { // Return
    "X-CAP-API-KEY": config.apiKey, // API key
    CST: session.cst, // CST
    "X-SECURITY-TOKEN": session.securityToken // Security token
  } as const; // End
} // End authHeaders

async function fetchMarketStatus(session: CapitalSession, instrument: string): Promise<MarketStatus> { // Fetch market status
  const url = new URL(`/api/v1/markets/${encodeURIComponent(instrument)}`, config.restBaseUrl).toString(); // Build URL (verify per Capital docs)
  const { controller, cancel } = withTimeout(10_000); // Timeout
  try { // Try
    const res = await fetch(url, { // Fetch
      method: "GET", // GET
      headers: { ...authHeaders(session), Accept: "application/json" }, // Headers
      signal: controller.signal // Signal
    }); // End fetch
    if (!res.ok) { // If bad
      const text = await res.text().catch(() => ""); // Read
      console.error(`[ERROR] market status HTTP ${res.status} ${res.statusText} ${instrument} ${text}`); // Log
      return "UNKNOWN"; // Unknown
    } // End bad
    const json = (await res.json()) as any; // Parse JSON
    const s = (json?.marketDetails?.marketStatus ?? json?.marketStatus ?? "UNKNOWN") as string; // Extract status (field varies)
    if (s === "OPEN") return "OPEN"; // Map open
    if (s === "CLOSED") return "CLOSED"; // Map closed
    if (s === "SUSPENDED" || s === "TEMPORARILY_CLOSED") return "SUSPENDED"; // Map suspended
    return "UNKNOWN"; // Default
  } catch (err) { // Catch
    const msg = err instanceof Error ? err.message : String(err); // Normalize
    console.error(`[ERROR] fetchMarketStatus ${instrument}: ${msg}`); // Log
    return "UNKNOWN"; // Unknown
  } finally { // Finally
    cancel(); // Clear timeout
  } // End try/catch/finally
} // End fetchMarketStatus

function formatTick(t: Tick) { // Format output
  if (config.printJson) return JSON.stringify(t); // JSON
  return `${t.ts} ${t.instrument} bid=${t.bid ?? "-"} ask=${t.ask ?? "-"} vol=${t.volume ?? "-"} liq=${t.liquidity ?? "-"}`; // Text
} // End formatTick

async function main() { // Main
  console.log(`CapitalGPT starting accountType=${config.accountType} instruments=${config.instruments.join(",")}`); // Startup log
  const session = await createSession(); // Create session
  console.log("Session created."); // Log

  const marketState = new Map<string, MarketStatus>(); // Status map
  for (const i of config.instruments) marketState.set(i, "UNKNOWN"); // Init

  let pollerStopped = false; // Poller stop flag
  (async () => { // Start poller loop
    while (!pollerStopped) { // Loop
      const statuses = await Promise.all(config.instruments.map((i) => fetchMarketStatus(session, i))); // Fetch statuses
      for (let idx = 0; idx < config.instruments.length; idx++) { // Iterate
        marketState.set(config.instruments[idx], statuses[idx] ?? "UNKNOWN"); // Store
      } // End iterate
      const parts = config.instruments.map((i) => `${i}:${marketState.get(i) ?? "UNKNOWN"}`); // Build status line
      console.log(`MARKET_STATUS ${new Date().toISOString()} ${parts.join(" ")}`); // Print
      await sleep(config.marketStatusPollMs); // Wait
    } // End loop
  })().catch((e) => { // Catch poller fatal
    console.error(`[ERROR] poller fatal: ${e instanceof Error ? e.message : String(e)}`); // Log
  }); // End poller

  const isAllowed = (instrument: string) => { // Gate streaming by market status
    const st = marketState.get(instrument) ?? "UNKNOWN"; // Read status
    return st === "OPEN" || st === "UNKNOWN"; // Allow open/unknown
  }; // End gate

  let stopped = false; // Stream stop flag
  let client: any = null; // LS client
  let subs: any[] = []; // Subscriptions
  let attempt = 0; // Reconnect attempt

  const connectLoop = async () => { // Connection loop
    while (!stopped) { // Loop
      try { // Try connect
        const ls = new LightstreamerClient(config.streamUrl); // Create client
        client = ls; // Store
        ls.connectionOptions.setRetryDelay(1000); // Must be > 0 (Lightstreamer requirement)
        ls.addListener({ // Add status listener
          onStatusChange: (status: string) => {
            if (status.startsWith("DISCONNECTED") && !stopped) console.error(`[ERROR] Stream disconnected: ${status}`); // Log
          } // End callback
        }); // End listener

        // NOTE: Lightstreamer auth varies; verify Capital.com docs for correct mapping. // Comment line
        ls.connectionDetails.setUser(session.cst); // Set user (placeholder)
        ls.connectionDetails.setPassword(session.securityToken); // Set password (placeholder)

        ls.connect(); // Connect

        subs = config.instruments.map((instrument) => { // Build subs
          const item = `MARKET:${instrument}`; // Item name (placeholder; verify in docs)
          const fields = ["BID", "OFFER", "LAST_TRADED_PRICE", "HIGH", "LOW", "VOLUME", "MARKET_STATE", "UPDATE_TIME", "LIQUIDITY"]; // Fields (placeholder; verify)
          const sub = new Subscription(config.streamMode, item, fields); // Create subscription
          sub.setRequestedSnapshot("no"); // No snapshot
          sub.addListener({ // Add listener
            onItemUpdate: (update: any) => {
              if (stopped) return; // If stopped
              if (!isAllowed(instrument)) return; // If market closed/suspended
              const raw: Record<string, string> = {}; // Raw map
              for (const f of fields) raw[f] = update.getValue(f) ?? ""; // Fill raw
              const tick: Tick = { // Build tick
                instrument, // Instrument
                ts: new Date().toISOString(), // Timestamp
                bid: toNum(raw["BID"]), // Bid
                ask: toNum(raw["OFFER"]), // Ask
                last: toNum(raw["LAST_TRADED_PRICE"]), // Last
                high: toNum(raw["HIGH"]), // High
                low: toNum(raw["LOW"]), // Low
                volume: toNum(raw["VOLUME"]), // Volume
                liquidity: toNum(raw["LIQUIDITY"]), // Liquidity
                raw // Raw
              }; // End tick
              console.log(formatTick(tick)); // Print instantly
            }, // End update
            onSubscriptionError: (_code: number, message: string) => {
              console.error(`[ERROR] Subscription error ${instrument}: ${message}`); // Log
            } // End subscription error
          }); // End listener
          return sub; // Return sub
        }); // End subs

        for (const s of subs) ls.subscribe(s); // Subscribe
        attempt = 0; // Reset attempt

        while (!stopped) { // Wait until disconnected
          await sleep(500); // Delay
          const status = client?.getStatus() ?? ""; // Status
          if (status.startsWith("DISCONNECTED")) break; // Break to reconnect
        } // End wait

        try { // Cleanup
          for (const s of subs) client?.unsubscribe(s); // Unsubscribe
          subs = []; // Clear
          client?.disconnect(); // Disconnect
        } catch { /* no-op */ } // Ignore cleanup errors
      } catch (err) { // Catch connect errors
        console.error(`[ERROR] Stream connect error: ${err instanceof Error ? err.message : String(err)}`); // Log
      } // End try/catch

      if (stopped) break; // Stop
      const delay = jitteredBackoff(attempt++); // Delay
      console.error(`[ERROR] Reconnecting in ${delay}ms...`); // Log
      await sleep(delay); // Sleep
    } // End loop
  }; // End connectLoop

  void connectLoop(); // Start connect loop

  const shutdown = () => { // Shutdown handler
    console.log("Shutting down..."); // Log
    stopped = true; // Stop stream
    pollerStopped = true; // Stop poller
    try { for (const s of subs) client?.unsubscribe(s); } catch { /* no-op */ } // Unsubscribe
    try { client?.disconnect(); } catch { /* no-op */ } // Disconnect
    process.exit(0); // Exit
  }; // End shutdown

  process.on("SIGINT", shutdown); // Handle Ctrl+C
  process.on("SIGTERM", shutdown); // Handle termination
} // End main

main().catch((err) => { // Run main
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`); // Log fatal
  process.exit(1); // Exit
}); // End run
