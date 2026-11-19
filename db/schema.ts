import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
export const workspace = sqliteTable('workspace', {id:integer('id').primaryKey(),json:text('json').notNull(),version:integer('version').notNull().default(0)});
export const ownerIdentity = sqliteTable('owner_identity', {id:integer('id').primaryKey(),userId:text('user_id').notNull()});
export const migrationState = sqliteTable('migration_state', {id:integer('id').primaryKey(),closed:integer('closed').notNull().default(0)});
