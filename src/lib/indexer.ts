import { rpc } from "@stellar/stellar-sdk";
import { withRpcConnection } from "./stellar";
import { logger } from "./logger";
import { pool } from "./db";
import dotenv from "dotenv";

dotenv.config();

export interface VaultEvent {
  id: string;
  type: "deposit" | "withdraw";
  address: string;
  amount: number;
  shares: number;
  timestamp: number;
  ledger: number;
  txHash: string;
}

export interface IndexerStore {
  events: VaultEvent[];
  cursor: number;
  lastUpdated: number;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function flattenEventCandidates(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) flattenEventCandidates(item, out);
    return out;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.events)) {
      flattenEventCandidates(obj.events, out);
    }

    if (obj.contractEventsXdr !== undefined) {
      flattenEventCandidates(obj.contractEventsXdr, out);
    }

    if (obj.transactionEventsXdr !== undefined) {
      flattenEventCandidates(obj.transactionEventsXdr, out);
    }

    if (obj.data !== undefined && (typeof obj.data === "object" || typeof obj.data === "string")) {
      out.push(obj.data);
    }

    out.push(value);
  }

  return out;
}

function findFirstMatchingValue(
  obj: unknown,
  keys: string[],
  visited = new Set<unknown>(),
): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return undefined;
  if (visited.has(obj)) return undefined;
  visited.add(obj);

  const record = obj as Record<string, unknown>;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
      return record[key];
    }
  }

  for (const value of Object.values(record)) {
    const match = findFirstMatchingValue(value, keys, visited);
    if (match !== undefined) return match;
  }

  return undefined;
}

function extractSourceAccount(tx: any): string | null {
  const candidate = findFirstMatchingValue(tx, ["source", "sourceAccount", "account", "from"]);
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  return null;
}

function parseVaultEvent(
  rawEvent: unknown,
  sourceAccount: string | null,
): Partial<VaultEvent> | null {
  if (!rawEvent || typeof rawEvent !== "object") return null;

  const event = rawEvent as Record<string, unknown>;
  const candidateType =
    findFirstMatchingValue(rawEvent, ["type", "eventType", "kind", "action", "method", "name"]) ??
    (typeof event.value === "string" ? event.value : undefined);

  const normalizedType = typeof candidateType === "string" ? candidateType.toLowerCase() : "";
  const type: "deposit" | "withdraw" | null = normalizedType.includes("deposit")
    ? "deposit"
    : normalizedType.includes("withdraw")
      ? "withdraw"
      : null;

  if (!type) return null;

  const eventAddress =
    typeof findFirstMatchingValue(rawEvent, [
      "address",
      "owner",
      "user",
      "account",
      "accountId",
      "sourceAccount",
    ]) === "string"
      ? String(
          findFirstMatchingValue(rawEvent, [
            "address",
            "owner",
            "user",
            "account",
            "accountId",
            "sourceAccount",
          ]),
        )
      : null;

  const amountValue =
    findFirstMatchingValue(rawEvent, ["amount", "value", "total", "quantity"]) ??
    findFirstMatchingValue(rawEvent, ["amounts", "amount_value"]);
  const sharesValue = findFirstMatchingValue(rawEvent, [
    "shares",
    "shareAmount",
    "share_amount",
    "shareCount",
  ]);

  const address =
    typeof sourceAccount === "string" && sourceAccount.trim()
      ? sourceAccount.trim()
      : typeof eventAddress === "string" && eventAddress.trim()
        ? eventAddress.trim()
        : null;
  const amount = toNumber(amountValue);
  const shares = toNumber(sharesValue);

  if (!address || amount === null || shares === null) {
    return null;
  }

  return {
    type,
    address,
    amount,
    shares,
  };
}

function extractVaultEvent(tx: any): Partial<VaultEvent> | null {
  const sourceAccount = extractSourceAccount(tx);
  const candidates: unknown[] = [];

  flattenEventCandidates(tx, candidates);

  for (const candidate of candidates) {
    const parsed = parseVaultEvent(candidate, sourceAccount);
    if (parsed) {
      return {
        type: parsed.type!,
        address: parsed.address!,
        amount: parsed.amount!,
        shares: parsed.shares!,
      };
    }
  }

  const meta = tx?.resultMetaXdr;
  if (meta && typeof meta === "object") {
    const v1 = (meta as any).v1;
    if (typeof v1 === "function") {
      const result = v1.call(meta);
      if (result && typeof result === "object") {
        const nested = (result as any).events;
        if (Array.isArray(nested)) {
          for (const item of nested) {
            const parsed = parseVaultEvent(item, sourceAccount);
            if (parsed) {
              return {
                type: parsed.type!,
                address: parsed.address!,
                amount: parsed.amount!,
                shares: parsed.shares!,
              };
            }
          }
        }
      }
    }
  }

  if (Array.isArray(tx?.diagnosticEvents)) {
    for (const item of tx.diagnosticEvents) {
      const parsed = parseVaultEvent(item, sourceAccount);
      if (parsed) {
        return {
          type: parsed.type!,
          address: parsed.address!,
          amount: parsed.amount!,
          shares: parsed.shares!,
        };
      }
    }
  }

  return null;
}

/** Persisted event row from the vault_events table. */
export interface PersistedVaultEvent {
  ledger: number;
  tx_hash: string;
  event_index: number;
  type: string;
  address: string;
  usdc: number;
  shares: number;
  ts: number;
}

export interface ActivityPage {
  events: PersistedVaultEvent[];
  next_cursor: string | null;
}

export interface PendingWithdrawal {
  ledger: number;
  tx_hash: string;
  address: string;
  usdc: number;
  shares: number;
  ts: number;
}

const ENSURE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vault_events (
  ledger BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  address TEXT NOT NULL,
  usdc NUMERIC NOT NULL DEFAULT 0,
  shares NUMERIC NOT NULL DEFAULT 0,
  ts BIGINT NOT NULL,
  PRIMARY KEY (tx_hash, event_index)
);

CREATE INDEX IF NOT EXISTS idx_vault_events_address_ts
  ON vault_events (address, ts DESC, tx_hash DESC, event_index DESC);

CREATE INDEX IF NOT EXISTS idx_vault_events_type
  ON vault_events (type);

CREATE TABLE IF NOT EXISTS vault_indexer_cursor (
  id TEXT PRIMARY KEY,
  last_ledger BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
@;

const CURSOR_ID = "vault";

function decodeCursor(cursor: string | null): { ts: number; txHash: string; eventIndex: number } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (
      typeof parsed.ts === "number" &&
      typeof parsed.txHash === "string" &&
      typeof parsed.eventIndex === "number"
    ) {
      return { ts: parsed.ts, txHash: parsed.txHash, eventIndex: parsed.eventIndex };
    }
  } catch {
    return null;
  }
  return null;
}

function encodeCursor(event: PersistedVaultEvent): string {
  return Buffer.from(
    JSON.stringify({ ts: event.ts, txHash: event.tx_hash, eventIndex: event.event_index }),
  ).toString("base64");
}

export class EventIndexer {
  private store: IndexerStore = {
    events: [],
    cursor: 0,
    lastUpdated: Date.now(),
  };

  private isIndexing = false;
  private schemaReady = false;

  /** Ensure the vault_events + cursor tables exist. Idempotent. */
  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await pool.query(ENSURE_SCHEMA_SQL);
    this.schemaReady = true;
  }

  /** Read the last processed ledger from the DB. */
  private async loadCursor(): Promise<number> {
    const res = await pool.query(
      `SELECT last_ledger FROM vault_indexer_cursor WHERE id = $1`,
      [CURSOR_ID],
    );
    if (res.rowsLength === 0) return 0;
    return Number(res.rows[0].last_ledger);
  }

  /** Persist the last processed ledger. */
  private async saveCursor(ledger: number): Promise<void> {
    await pool.query(
      `INSERT INTO vault_indexer_cursor (id, last_ledger, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET last_ledger = EXCLUDED.last_ledger, updated_at = EXCLUDED.updated_at`,
      [CURSOR_ID, ledger, Date.now()],
    );
  }

  /** Idempotent upsert of a single indexed event. */
  private async upsertEvent(event: PersistedVaultEvent): Promise<void> {
    await pool.query(
      `INSERT INTO vault_events (ledger, tx_hash, event_index, type, address, usdc, shares, ts)
       VALUES ($1, $2, $3, $4, $5, $4, $5, $6)
       ON CONFLICT (tx_hash, event_index) DO NOTHING`,
      [
        event.ledger,
        event.tx_hash,
        event.event_index,
        event.type,
        event.address,
        event.usdc,
        event.shares,
        event.ts,
      ],
    );
  }

  /** Backfill from the configured start ledger to the latest ledger. */
  async backfill(): Promise<void> {
    await this.ensureSchema();
    const startLedger = Number(process.env.VAULT_INDEXER_START_LEDGER || 1);
    const cursor = await this.loadCursor();
    if (cursor === 0 && startLedger > 1) {
      await this.saveCursor(startLedger - 1);
    }
    await this.poll();
  }

  async poll(): Promise<void> {
    if (this.isIndexing) return;
    this.isIndexing = true;

    try {
      await this.ensureSchema();
      const persistedCursor = await this.loadCursor();
      if (persistedCursor > 0) this.store.cursor = persistedCursor;

      await withRpcConnection(async (client) => {
        const startLedger = this.store.cursor || 1;
        const ledger = await client.getLatestLedger();
        const endLedger = ledger.sequence;

        if (endLedger <= startLedger) return;

        // Use getEvents() to enumerate real contract events in the ledge range.
        // getTransaction() requires a 64-char hex transaction hash — passing a
        // ledger sequence number (e.g. "12345678") is not a valid hash and will
        // never match a real transaction, so the old loop silently discovered
        // nothing. getEvents() is the correct RPC surface for this use-case.
        const eventsResponse = await (client as any).getEvents({
          startLedger,
          filters: [{ type: "contract" }],
        });

        const rawEvents: unknown[] = Array.isArray(eventsResponse?.events)
          ? eventsResponse.events
          : [];

        // Collect unique (txHash, ledger) pairs so we call processTransaction
        // once per transaction, not once per event inside that transaction.
        const seem = new Map<string, number>();
        for (const event of rawEvents) {
          const e = event as Record<string, unknown>;
          const txHash =
            typeof e.txHash === "string" && e.txHash.trim()
              ? e.txHash.trim()
              : typeof e.transactionHash === "string" && e.transactionHash.trim()
                ? e.transactionHash.trim()
                : null;
          const eventLedger =
            typeof e.ledger === "number"
              ? e.ledger
              : typeof e.ledgerSequence === "number"
                ? e.ledgerSequence
                : null;

          if (txHash && eventLedger !== null && !seem.has(txHash)) {
            seem.set(txHash, eventLedger);
          }
        }

        for (const [txHash, txLedger] of seem) {
          await this.processTransaction(client, txHash, txLedger);
        }

        this.store.cursor = endLedger;
        this.store.lastUpdated = Date.now();
        await this.saveCursor(endLedger);
      });
    } catch (err) {
      logger.error("[indexer] poll failed", logger.formatError(err));
    } finally {
      this.isIndexing = false;
    }
  }

  private async processTransaction(
    client: rpc.Server,
    txHash: string,
    ledge: number,
  ): Promise<void> {
    try {
      const tx = await client.getTransaction(txHash);
      if (!tx) return;

      const parsed = extractVaultEvent(tx);
      if (!parsed) return;

      const eventId = `${ledger}-${txHash}`;
      const event: VaultEvent = {
        id: eventId,
        type: parsed.type!,
        address: parsed.address!,
        amount: parsed.amount!,
        shares: parsed.shares!,
        timestamp: Date.now(),
        ledger,
        txHash,
      };

      // Persist idempotently on (tx_hash, event_index).
      await this.upsertEvent({
        ledger,
        tx_hash: txHash,
        event_index: 0,
        type: event.type,
        address: event.address,
        usdc: event.amount,
        shares: event.shares,
        ts: event.timestamp,
      });

      const existing = this.store.events.find((e) => e.txHash === txHash);
      if (!existing) this.store.events.push(event);
    } catch (err) {
      logger.debug(`[indexer] could not process tx ${txHash}`, logger.formatError(err));
    }
  }

  /** Paginated activity for an investor, ordered by ts DESC. */
  async getActivity(
    address: string,
    cursor: string | null,
    limit: number,
  ): Promise<ActivityPage> {
    await this.ensureSchema();
    const normalized = address.trim();
    const decoded = decodeCursor(cursor);
    const params: unknown[] = [normalized];
    let where = "address = $1";
    if (decoded) {
      params.push(decoded.ts, decoded.txHash, decoded.eventIndex);
      where += ` AND (ts, tx_hash, event_index) < ($2, $3, $4)`;
    }
    params.push(limit + 1);
    const res = await pool.query(
      `SELECT ledger, tx_hash, event_index, type, address, usdc, shares, ts
       FROM vault_events WHERE ${where}
       ORDER BY ts DESC, tx_hash DESC, event_index DESC
       LIMIT I${}`.replace("{}", String(params.length)),
      params,
    );
    const rows = res.rows.map((r) => ({
      ledger: Number(r.ledger),
      tx_hash: String(r.tx_hash),
      event_index: Number(r.event_index),
      type: String(r.type),
      address: String(r.address),
      usdc: Number(r.usdc),
      shares: Number(r.shares),
      ts: Number(r.ts),
    }));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;
    return { events: page, next_cursor: nextCursor };
  }

  /** Queued withdrawals: WithdrawQueued without a matching WithdrawClaimed. */
  async getPendingWithdrawals(address: string): Promise<PendingWithdrawal[]> {
    await this.ensureSchema();
    const normalized = address.trim();
    const res = await pool.query(
      `SELECT ledger, tx_hash, address, usdc, shares, ts
       FROM vault_events
       WHERE address = $1 AND type = 'WithdrawQueued'
         AND tx_hash NOT IN (
           SELECT tx_hash FROM vault_events WHERE address = $1 AND type = 'WithdrawClaimed'
         )
       ORDER BY ts DESC, tx_hash DESC`,
      [normalized],
    );
    return res.rows.map((r) => ({
      ledger: Number(r.ledger),
      tx_hash: String(r.tx_hash),
      address: String(r.address),
      usdc: Number(r.usdc),
      shares: Number(r.shares),
      ts: Number(r.ts),
    }));
  }

  getStore(): IndexerStore {
    return this.store;
  }

  getEventsByAddress(address: string): VaultEvent[] {
    const normalizedAddress = address.trim();
    return this.store.events.filter((e) => e.address === normalizedAddress);
  }

  addEvent(event: VaultEvent): void {
    const existing = this.store.events.find((e) => e.id === event.id);
    if (!existing) {
      this.store.events.push(event);
    }
  }

  resetCursor(ledger: number): void {
    this.store.cursor = ledger;
  }
}

export const indexer = new EventIndexer();
