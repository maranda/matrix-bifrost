import { PoolClient } from "pg";

export async function runSchema(connection: PoolClient) {
    // Create schema
    await connection.query(`
        ALTER TABLE remote_users DROP CONSTRAINT remote_users_user_id_key;
        ALTER TABLE remote_users ALTER COLUMN sender_name SET NOT NULL;
        ALTER TABLE remote_users ADD CONSTRAINT cons_uid_sname_unique UNIQUE (user_id, sender_name);
    `);
}
