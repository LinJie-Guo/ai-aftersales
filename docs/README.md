# 文档目录

| 文档 | 用途 |
| --- | --- |
| [Docker 部署](docker/README.md) | 安装启动、健康检查、更新、备份和恢复 |
| [数据库初始化](sql/README.md) | 自动初始化、手动导入、SQL 更新方法 |
| [初始化 SQL](sql/init.sql) | PostgreSQL 16 空库结构、索引、约束、角色和默认管理员 |
| [配置与开发](configuration.md) | 环境变量、开发启动和验证命令 |
| [演示数据与截图](demo/README.md) | README 截图来源、虚构数据范围和重新生成方式 |
| [使用说明](usage.md) | 首次配置、排查流程、权限和常见问题 |

文档中的命令默认从源码仓库根目录执行。部署配置以 `docker/docker-compose.yml` 为准，数据库升级以 `server/src/db/migrate.ts` 为准。数据库结构调整后，应同步更新初始化 SQL 与相关操作说明。
