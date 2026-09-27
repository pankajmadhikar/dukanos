/**
 * Gives dukaan_app a password so the API can log in.
 * The migration creates the role NOLOGIN. This does not change tables or policies.
 * The password is taken from DATABASE_URL and is not printed.
 */
import "dotenv/config";
import { Client } from "pg";

const ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appUrl = process.env.DATABASE_URL;
  const expectedRole = process.env.DATABASE_APP_ROLE ?? "dukaan_app";
  if (!adminUrl) {
    throw new Error("DATABASE_ADMIN_URL is required.");
  }
  if (!appUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  if (!ROLE_NAME.test(expectedRole)) {
    throw new Error("DATABASE_APP_ROLE is invalid.");
  }

  const app = new URL(appUrl);
  const role = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password);
  if (role !== expectedRole) {
    throw new Error(
      `DATABASE_URL user is ${role}. Refusing to alter a different role.`,
    );
  }
  if (password.length < 12) {
    throw new Error("DATABASE_URL password must be at least 12 characters.");
  }

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const existing = await client.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname = $1",
      [role],
    );
    if (existing.rowCount === 0) {
      throw new Error(
        "Role dukaan_app does not exist. Run npm run db:migrate first.",
      );
    }

    const login = await client.query<{ stmt: string }>(
      "SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS stmt",
      [role, password],
    );
    const loginStmt = login.rows[0]?.stmt;
    if (!loginStmt) {
      throw new Error("Could not build the role statement.");
    }
    await client.query(loginStmt);

    const connectGrant = await client.query<{ stmt: string }>(
      "SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS stmt",
      [role],
    );
    const grantStmt = connectGrant.rows[0]?.stmt;
    if (!grantStmt) {
      throw new Error("Could not build the connect grant.");
    }
    await client.query(grantStmt);
    process.stdout.write(`application role ${role} can log in\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "role setup failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
