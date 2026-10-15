export declare const MIGRATIONS_DIR: string;
export declare const SEED_DIR: string;

export interface MigrateOptions {
  connectionString: string;
  dir?: string;
  log?: (msg: string) => void;
}

/** Apply pending db/migrations/*.sql files; returns the names applied by this call. */
export declare function runMigrations(opts: MigrateOptions): Promise<string[]>;

/** Run every db/seed/*.sql file (each must be idempotent). */
export declare function runSeeds(opts: MigrateOptions): Promise<void>;
