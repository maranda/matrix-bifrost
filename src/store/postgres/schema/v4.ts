import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    // Create schema
    await connection.query(`
        ALTER TABLE events ADD COLUMN origin_id TEXT;
        ALTER TABLE events ADD COLUMN stanza_id TEXT;
    `);
}
