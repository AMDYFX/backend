import type { Knex } from "knex";

/**
 * Initial schema — sets up core tables for the Heliobond backend.
 *
 * This migration serves as a reference and starting point. When the project
 * migrates from in-memory storage to a real database, adapt these tables to
 * match the actual data model.
 */
export async function up(knex: Knex): Promise<void> {
  // ── Projects ────────────────────────────────────────────────────────────
  await knex.schema.createTable("projects", (t) => {
    t.increments("id").primary();
    t.string("name", 255).notNullable();
    t.text("description");
    t.string("wallet_address", 64).notNullable().unique();
    t.string("chain", 32).notNullable().defaultTo("stellar");
    t.boolean("active").notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  // ── Score history ───────────────────────────────────────────────────────
  await knex.schema.createTable("score_history", (t) => {
    t.increments("id").primary();
    t.integer("project_id").unsigned().notNullable()
      .references("id").inTable("projects").onDelete("CASCADE");
    t.integer("credit_quality").notNullable();
    t.integer("green_impact").notNullable();
    t.string("tx_hash", 128);
    t.bigInteger("timestamp").notNullable();
    t.timestamps(true, true);

    t.index(["project_id", "timestamp"]);
  });

  // ── Audit log ───────────────────────────────────────────────────────────
  await knex.schema.createTable("audit_log", (t) => {
    t.increments("id").primary();
    t.integer("project_id").unsigned().notNullable()
      .references("id").inTable("projects").onDelete("CASCADE");
    t.integer("credit_quality").notNullable();
    t.integer("green_impact").notNullable();
    t.string("tx_hash", 128);
    t.string("triggered_by", 32).notNullable(); // "cron" | "api" | "webhook"
    t.timestamps(true, true);

    t.index(["project_id", "created_at"]);
  });

  // ── Webhooks ────────────────────────────────────────────────────────────
  await knex.schema.createTable("webhooks", (t) => {
    t.increments("id").primary();
    t.string("url", 1024).notNullable();
    t.string("secret", 255);
    t.boolean("active").notNullable().defaultTo(true);
    t.jsonb("events").notNullable().defaultTo('["score_updated"]');
    t.timestamps(true, true);
  });

  // ── API keys ────────────────────────────────────────────────────────────
  await knex.schema.createTable("api_keys", (t) => {
    t.increments("id").primary();
    t.string("key_hash", 255).notNullable().unique();
    t.string("name", 255).notNullable();
    t.string("prefix", 16).notNullable(); // first few chars for identification
    t.jsonb("scopes").notNullable().defaultTo('["read"]');
    t.boolean("active").notNullable().defaultTo(true);
    t.timestamp("last_used_at");
    t.timestamp("expires_at");
    t.timestamps(true, true);
  });

  // ── Vault events (indexer) ──────────────────────────────────────────────
  await knex.schema.createTable("vault_events", (t) => {
    t.increments("id").primary();
    t.bigInteger("ledger").notNullable();
    t.string("tx_hash", 128).notNullable();
    t.integer("event_index").notNullable();
    t.string("type", 64).notNullable();
    t.string("address", 64).notNullable();
    t.string("usdc", 64);
    t.string("shares", 64);
    t.bigInteger("ts").notNullable();
    t.timestamps(true, true);

    t.unique(["tx_hash", "event_index"]);
    t.index(["address", "ledger"]);
    t.index(["type"]);
  });

  // ── Indexer cursor ──────────────────────────────────────────────────────
  await knex.schema.createTable("indexer_cursor", (t) => {
    t.string("name", 64).primary();
    t.bigInteger("last_ledger").notNullable().defaultTo(0);
    t.timestamps(true, true);
  });

  // ── Knex migration tracking is automatic via knex_migrations table ─────
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("indexer_cursor");
  await knex.schema.dropTableIfExists("vault_events");
  await knex.schema.dropTableIfExists("api_keys");
  await knex.schema.dropTableIfExists("webhooks");
  await knex.schema.dropTableIfExists("audit_log");
  await knex.schema.dropTableIfExists("score_history");
  await knex.schema.dropTableIfExists("projects");
}
