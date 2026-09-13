# 数据库初始化

目标数据库为 PostgreSQL 16。SQL 包含当前迁移产生的 18 张表、主外键、唯一约束、搜索索引、`pg_trgm` 扩展、三个内置角色及默认管理员。它由隔离空库执行 `server/src/db/migrate.ts` 后导出，未导出本机业务数据库。

## 自动初始化（默认）

直接启动应用即可。`server/src/index.ts` 会依次运行数据库迁移、历史密钥处理、`seed()`、附件与知识回填。首次初始化会创建管理员和示例业务数据，默认管理员为 `admin / admin123`，密码经 scrypt 哈希后保存到 `app_user`。首次登录后应在用户管理中修改密码。已有任意用户时不会再次创建整套示例数据。

## 手动导入空库

用于 DBA 提前准备结构或检查数据库定义。先创建空数据库，再使用具备建表及创建 `pg_trgm` 扩展权限的账户导入：

```bash
createdb -U postgres aftersale
psql -X -U postgres -v ON_ERROR_STOP=1 --single-transaction -d aftersale -f docs/sql/init.sql
```

Compose 环境中，先只启动数据库，确保应用尚未启动且库中没有表：

```bash
docker compose -f docs/docker/docker-compose.yml up -d db
# 等待数据库健康后执行
docker compose -f docs/docker/docker-compose.yml exec -T db sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction' < docs/sql/init.sql
docker compose -f docs/docker/docker-compose.yml up -d --build app
```

导入脚本不创建 PostgreSQL 数据库或数据库用户；它创建业务表、内置角色以及默认业务管理员 `admin`。管理员初始密码为 `admin123`，密码字段仅保存 scrypt 哈希，也不含真实客户、API Key 或工单数据。

手动导入后管理员已经存在，应用启动时不会再插入默认示例业务数据。自动启动初始化仍使用 `server/src/db/seed.ts` 创建管理员及虚构示例数据。两种路径的默认登录账号一致；重复执行应用初始化不会重置已有 scrypt 密码。
**该 SQL 仅用于全新空库，不可重复导入，也不是升级脚本。** 现有数据库使用应用启动时的 `migrate.ts` 更新；升级前完整备份数据库和运行数据。

## 更新 SQL

数据库结构变化后，在隔离的 PostgreSQL 16 空库运行当前 `migrate()`，再执行一次迁移以补齐依赖新增字段的全文索引，不要运行 `seed()`，然后导出结构与角色：

```bash
pg_dump --schema-only --no-owner --no-privileges -d aftersale > schema.sql
pg_dump --data-only --table=app_role --column-inserts --no-owner --no-privileges -d aftersale > roles.sql
```

合并为 `init.sql`，保留文件末尾默认管理员的 `INSERT ... ON CONFLICT DO NOTHING` 语句及用途说明，再在另一个空库执行事务导入、应用迁移和初始化，确认表、角色、索引与管理员创建正常。导出命令仅对临时数据库执行，勿将生产数据导出到仓库。数据库行为以迁移代码为准，ORM 定义见 `server/src/db/schema.ts`。
